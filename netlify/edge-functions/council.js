import {accountStore} from '../lib/storage/accounts.js';
import { streamMetered } from '../lib/metered-provider.js';
import { getStore } from "@netlify/blobs";
import { getApiKeyForProvider } from "../lib/providers.js";
import { requireSession, checkRateLimit, clientIdentifier, recordAuditEvent } from "../lib/security.js";
import { recordUsage } from "../lib/orchestrator.js";
import { createLogger } from "../lib/logger.js";
import { validateAiRequest } from "../lib/ai-limits.js";
import { PROVIDER_IDS } from "../../shared/models.js";
import { SUBSCRIPTION_STORE_NAME } from "../lib/subscriptions.js";
import { authorizeCouncilRequest } from "../lib/council-access.js";

const CRITIQUE_SYSTEM_PROMPT = `You are one of several independent AI models that were each asked the same question. You will be shown all answers, including your own (labeled "YOUR ORIGINAL ANSWER"). Respond with ONLY a JSON object, no markdown fences, no commentary:
{"critique": "2-4 sentences noting where the answers agree, disagree, or where you see a possible error in any of them (yours included)", "confidence": <integer 0-100, your own honest self-assessed confidence in the correctness of YOUR OWN original answer>}`;

function getRoleForStrategy(strategy, index, count) {
  const s = strategy?.toUpperCase() || 'CONSENSUS';

  if (s === 'SPECIALIST_DELEGATION') {
    const roles = ['Software Architect', 'Security Reviewer', 'Performance Engineer', 'Domain Expert', 'QA Tester'];
    return roles[index % roles.length];
  }

  if (s === 'DEBATE') {
    return index % 2 === 0 ? 'Proponent (Argue for the mainstream/conventional approach)' : 'Challenger (Argue against conventional wisdom, highlight risks, propose alternatives)';
  }

  if (s === 'CRITIQUE' && count > 1 && index === count - 1) {
    return 'Lead Critic (Evaluate the other models, DO NOT provide a direct answer, just analyze trade-offs)';
  }

  if (s === 'SYNTHESIS') {
    return 'Synthesizer (Bridge independent points, resolve conflicts, and output a unified truth)';
  }

  return 'Independent Analyst';
}

export default async (request, context) => {
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });

  const log = createLogger(Netlify.env, "council");
  const auth = await requireSession(request, Netlify.env);
  if (!auth.ok) return json({ error: auth.message }, auth.status);

  let payload;
  try {
    payload = await request.json();
  } catch {
    return json({ error: "Malformed request body." }, 400);
  }

  const { providers, prompt, system, critique: critiqueRequested, strategy } = payload || {};
  if (!Array.isArray(providers) || providers.length === 0) {
    return json({ error: "Request must include a non-empty `providers` array." }, 400);
  }
  if (providers.length > PROVIDER_IDS.length) {
    return json({ error: `Pick at most ${PROVIDER_IDS.length} providers at once.` }, 400);
  }
  if (typeof prompt !== "string" || !prompt.trim()) {
    return json({ error: "Request must include a non-empty `prompt`." }, 400);
  }

  if (!auth.open) {
    let subStore, auditStore;
    try { subStore = getStore(SUBSCRIPTION_STORE_NAME); } catch (err) { log.warn("Subscription store unavailable, failing closed", { error: err?.message }); }
    try { auditStore = getStore("samvit-audit"); } catch (err) { log.warn("Audit store", { error: err?.message }); }

    const decision = await authorizeCouncilRequest(subStore, auth.accountId, Netlify.env, {
      providerCount: providers.length,
      critiqueRequested: Boolean(critiqueRequested),
    });

    if (!decision.ok) {
      if (auditStore) {
        recordAuditEvent(auditStore, {
          type: "council_access_denied",
          account: auth.accountId,
          tier: decision.subscription?.planId,
          providerCount: providers.length,
          reason: decision.reason,
        }).catch(() => {});
      }
      return json({ error: decision.error }, decision.status);
    }
  }

  const requestWeight = providers.length * (critiqueRequested ? 2 : 1);

  try {
    const store = getStore("samvit-ratelimits");
    const id = clientIdentifier(request, context);
    const rl = await checkRateLimit(
      store,
      `council:${id}`,
      { windowMs: 60_000, max: Number(Netlify.env.get("RATE_LIMIT_COUNCIL_PER_MINUTE")) || 5 },
      requestWeight
    );
    if (!rl.allowed) return json({ error: `Council rate limit reached.` }, 429);
  } catch {}

  const validation = validateAiRequest({ messages: [{ role: "user", content: prompt }], system, providers });
  if (!validation.valid) return json({ error: validation.error }, 400);

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (obj) => { if (!request.signal.aborted) { try {controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));} catch {} } };
      const finalTexts = {};

      const tasks = providers.map(async (entry, index) => {
        const providerId = typeof entry === "string" ? entry : entry.provider;
        const model = typeof entry === "string" ? undefined : entry.model;
        const apiKey = getApiKeyForProvider(providerId, Netlify.env);

        let customSystem = system || '';
        if (strategy && ['SPECIALIST_DELEGATION', 'DEBATE', 'CRITIQUE', 'SYNTHESIS'].includes(strategy.toUpperCase())) {
           const role = getRoleForStrategy(strategy, index, providers.length);
           customSystem = `Your assigned council role is: ${role}.\n\n` + customSystem;
        }

        const messages = [{ role: "user", content: prompt }];

        try {
          let text = "";
          for await (const chunk of streamMetered(providerId, apiKey, { model, messages, system: customSystem, maxTokens: 1536, signal: request.signal, accountId:auth.accountId })) {
            if (chunk.error) { send({ provider: providerId, error: chunk.error, phase: "answer" }); return; }
            if (chunk.text) { text += chunk.text; send({ provider: providerId, delta: chunk.text, phase: "answer" }); }
            if (chunk.done) {
              finalTexts[providerId] = text;
              send({ provider: providerId, done: true, phase: "answer" });
              try { await recordUsage(accountStore("samvit-analytics",auth.accountId), { provider: providerId, model, usage: chunk.usage, costUsd: (chunk.meteredCostUsd??null), endpoint: "council" }).catch(() => {}); } catch {}
              return;
            }
          }
        } catch (err) {
          send({ provider: providerId, error: err?.message || "Unexpected error.", phase: "answer" });
        }
      });

      await Promise.allSettled(tasks);

      const successfulIds = Object.keys(finalTexts);
      if (critiqueRequested && successfulIds.length >= 2) {
        const critiqueTasks = successfulIds.map(async (providerId) => {
          const apiKey = getApiKeyForProvider(providerId, Netlify.env);
          const otherAnswers = successfulIds
            .map((id) => `${id === providerId ? "YOUR ORIGINAL ANSWER" : `Answer from "${id}"`}:\n${finalTexts[id]}`)
            .join("\n\n---\n\n");
          const critiquePrompt = `Original question: ${prompt}\n\n${otherAnswers}`;
          try {
            let text = "";
            for await (const chunk of streamMetered(providerId, apiKey, {
              messages: [{ role: "user", content: critiquePrompt }],
              system: CRITIQUE_SYSTEM_PROMPT,
              maxTokens: 400, signal: request.signal, accountId:auth.accountId,
            })) {
              if (chunk.error) { send({ provider: providerId, error: chunk.error, phase: "critique" }); return; }
              if (chunk.text) text += chunk.text;
              if (chunk.done) {
                try { await recordUsage(accountStore("samvit-analytics",auth.accountId), { provider: providerId, usage: chunk.usage, costUsd: (chunk.meteredCostUsd??null), endpoint: "council-critique" }).catch(() => {}); } catch {}
              }
            }
            const parsed = parseCritiqueJson(text);
            send({ provider: providerId, phase: "critique", critique: parsed.critique, confidence: parsed.confidence });
          } catch (err) {
            log.warn("Critique phase failed for provider", { provider: providerId, error: err?.message });
            send({ provider: providerId, error: "Critique step failed for this model.", phase: "critique" });
          }
        });
        await Promise.allSettled(critiqueTasks);
      }

      send({ allDone: true });
      try {controller.close();} catch {}
    },
  });

  return new Response(stream, {
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" },
  });
};

function parseCritiqueJson(text) {
  try {
    const trimmed = text.trim().replace(/^```json/i, "").replace(/^```/, "").replace(/```$/, "");
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    const parsed = JSON.parse(trimmed.slice(start, end + 1));
    return {
      critique: typeof parsed.critique === "string" ? parsed.critique.slice(0, 1000) : "",
      confidence: Number.isFinite(parsed.confidence) ? Math.max(0, Math.min(100, Math.round(parsed.confidence))) : null,
    };
  } catch {
    return { critique: text.slice(0, 300), confidence: null };
  }
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
}

export const config = { path: "/api/council" };