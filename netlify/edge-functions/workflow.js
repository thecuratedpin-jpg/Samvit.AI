import {accountStore} from '../lib/storage/accounts.js';
import { streamMetered } from '../lib/metered-provider.js';
// ==========================================================================
// SAMVIT — /api/workflow
// --------------------------------------------------------------------------
// Turns a goal ("migrate our auth service to PKCE") into a real, structured
// step-by-step plan by asking one model to return JSON, instead of picking
// from a hardcoded template like the original prototype did.
// ==========================================================================
import { PROVIDERS, getApiKeyForProvider, estimateCostUsd } from "../lib/providers.js";
import { requireSession, checkRateLimit, clientIdentifier } from "../lib/security.js";
import { recordUsage } from "../lib/orchestrator.js";
import { normalizeMission } from "../../shared/models.js";
import { validateSingleTextInput, MAX_GOAL_CHARS } from "../lib/ai-limits.js";
import { getStore } from "@netlify/blobs";

const SYSTEM_PROMPT = `You turn a goal into an actionable project plan.
Respond with ONLY a JSON object (no markdown fences, no commentary) matching exactly this shape:
{
  "title": "short plan title",
  "summary": "one sentence summary",
  "estimatedMinutes": 45,
  "steps": [
    { "title": "short step title", "detail": "1-2 sentence description of the step", "estimatedMinutes": 10 }
  ]
}
Produce between 3 and 8 steps. Be concrete and specific to the stated goal. Do not wrap the JSON in backticks.`;

function extractJson(text) {
  const trimmed = text.trim().replace(/^```json/i, "").replace(/^```/, "").replace(/```$/, "");
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("No JSON object found in model output.");
  return JSON.parse(trimmed.slice(start, end + 1));
}

export default async (request, context) => {
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const auth = await requireSession(request, Netlify.env);
  if (!auth.ok) return json({ error: auth.message }, auth.status);

  let payload;
  try {
    payload = await request.json();
  } catch {
    return json({ error: "Malformed request body." }, 400);
  }

  const { goal, provider = "claude", model } = payload || {};
  // v4 Priority 4: was a hardcoded, third copy of the same "2000" number
  // duplicated in ai-limits.js's MAX_GOAL_CHARS -- now imported instead of
  // re-typed, plus this now also gets the total-size/estimated-token
  // checks (of limited extra effect for a single short field like this,
  // but one validation path instead of three separately-maintained ones).
  const validation = validateSingleTextInput(goal, { fieldName: "goal", maxChars: MAX_GOAL_CHARS });
  if (!validation.valid) {
    return json({ error: validation.error }, 400);
  }

  try {
    const store = getStore("samvit-ratelimits");
    const id = clientIdentifier(request, context);
    const rl = await checkRateLimit(store, `workflow:${id}`, { windowMs: 60_000, max: Number(Netlify.env.get("RATE_LIMIT_PER_MINUTE")) || 20 });
    if (!rl.allowed) return json({ error: `Rate limit reached. Try again in ${Math.ceil(rl.resetMs / 1000)}s.` }, 429);
  } catch (_) {}

  if (!PROVIDERS[provider]) return json({ error: `Unknown provider "${provider}".` }, 400);
  const apiKey = getApiKeyForProvider(provider, Netlify.env);

  let fullText = "";
  for await (const chunk of streamMetered(provider, apiKey, {
    model,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: `Goal: ${goal}` }],
    maxTokens: 1536, signal: request.signal, accountId:auth.accountId,
  })) {
    if (chunk.error) return json({ error: chunk.error }, 502);
    if (chunk.text) fullText += chunk.text;
    if (chunk.done) {
      try { await recordUsage(accountStore("samvit-analytics",auth.accountId), { provider, model, usage: chunk.usage, costUsd: (chunk.meteredCostUsd??null), endpoint: "workflow" }).catch(() => {}); } catch {}
      break;
    }
  }

  try {
    const rawPlan = extractJson(fullText);
    const mission = normalizeMission({
      title: rawPlan.title,
      goal,
      summary: rawPlan.summary,
      provider,
      status: "draft",
      steps: Array.isArray(rawPlan.steps)
        ? rawPlan.steps.map((s) => ({ title: s.title, detail: s.detail, estimatedMinutes: s.estimatedMinutes }))
        : [],
    });
    return json({ plan: rawPlan, mission });
  } catch (err) {
    return json({ error: `Model did not return a parseable plan: ${err.message}`, raw: fullText.slice(0, 1000) }, 502);
  }
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
}

export const config = { path: "/api/workflow" };
