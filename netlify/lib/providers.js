// ==========================================================================
// SAMVIT — PROVIDER ADAPTER LAYER
// --------------------------------------------------------------------------
// This is the ONLY file that knows the wire format of each AI provider.
// Every provider adapter exposes the same shape:
//
//   {
//     id, label,
//     envKey,                          // which env var holds the API key
//     defaultModel,                    // catalog default
//     models: [{id, label}],           // options shown in the picker
//     buildRequest(apiKey, {model, messages, system, maxTokens}) -> {url, headers, body}
//     async *parseStream(response)     // async generator yielding {text?, done?, error?}
//   }
//
// Model names for every provider change every few weeks. Defaults below were
// reviewed against provider documentation on 2026-09-13. If a call starts
// failing with a "model not found" style error, that's almost certainly why —
// update the model id here (or override it via query param) rather than
// assuming the integration itself is broken.
// ==========================================================================

import { iterateSSE } from "../../shared/sse.js";
import { MODEL_CATALOG, findModel, estimateModelCost } from "../../shared/catalog.js";

async function readErrorBody(response) {
  try {
    const text = await response.text();
    try {
      const json = JSON.parse(text);
      return json.error?.message || json.message || text;
    } catch {
      return text.slice(0, 500);
    }
  } catch {
    return `HTTP ${response.status}`;
  }
}

export function diagnoseProviderAuth(providerId, { status, message } = {}) {
  const provider = PROVIDERS[providerId];
  if (!provider) return { ok: false, reason: "unknown_provider", message: "Unknown provider." };
  if (status === 401 || status === 403) {
    const text = String(message || "");
    const invalidIssuer = /invalid[-_\s]?issuer|issuer/i.test(text);
    return {
      ok: false,
      reason: invalidIssuer ? "invalid_issuer" : "auth",
      message: invalidIssuer
        ? `${provider.label} rejected the key with an invalid-issuer 401. Check that ${provider.envKey} belongs to the correct provider account/project and that the deployment is not mixing keys from another issuer.`
        : `${provider.label} rejected the configured credential. Rotate or verify ${provider.envKey}.`,
    };
  }
  return { ok: true, reason: "configured", message: `${provider.label} credential is present.` };
}

// -------------------------------------------------------------------------
// ANTHROPIC (Claude)
// -------------------------------------------------------------------------
const anthropic = {
  id: "claude",
  label: "Claude (Anthropic)",
  envKey: "ANTHROPIC_API_KEY",
  buildRequest(apiKey, { model, messages, system, maxTokens }) {
    return {
      url: "https://api.anthropic.com/v1/messages",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: model || this.defaultModel,
        max_tokens: maxTokens || 2048,
        system: system || undefined,
        messages: messages.map((m) => ({ role: m.role, content: m.content })),
        stream: true,
      }),
    };
  },
  async *parseStream(response) {
    let usage = null;
    for await (const { event, data } of iterateSSE(response)) {
      if (event === "error") {
        let msg = data;
        try { msg = JSON.parse(data).error?.message || data; } catch (_) {}
        yield { error: msg };
        return;
      }
      if (data === "[DONE]") { yield { done: true, usage }; return; }
      let json;
      try { json = JSON.parse(data); } catch { continue; }
      if (json.type === "message_start" && json.message?.usage) {
        usage = { inputTokens: json.message.usage.input_tokens, outputTokens: json.message.usage.output_tokens || 0 };
      } else if (json.type === "content_block_delta" && json.delta?.type === "text_delta") {
        yield { text: json.delta.text };
      } else if (json.type === "message_delta" && json.usage) {
        usage = { ...usage, outputTokens: json.usage.output_tokens };
      } else if (json.type === "message_stop") {
        yield { done: true, usage }; return;
      }
    }
    yield { error: "Provider stream ended before completion.", retryable: true };
  },
};

// -------------------------------------------------------------------------
// OPENAI (GPT)
// -------------------------------------------------------------------------
const openai = {
  id: "openai",
  label: "GPT (OpenAI)",
  envKey: "OPENAI_API_KEY",
  buildRequest(apiKey, { model, messages, system, maxTokens }) {
    const msgs = [];
    if (system) msgs.push({ role: "system", content: system });
    for (const m of messages) msgs.push({ role: m.role, content: m.content });
    return {
      url: "https://api.openai.com/v1/chat/completions",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: model || this.defaultModel,
        messages: msgs,
        max_completion_tokens: maxTokens || 2048,
        stream: true,
        stream_options: { include_usage: true },
      }),
    };
  },
  async *parseStream(response) {
    let usage = null;
    for await (const { data } of iterateSSE(response)) {
      if (data === "[DONE]") { yield { done: true, usage }; return; }
      let json;
      try { json = JSON.parse(data); } catch { continue; }
      if (json.error) { yield { error: json.error.message || "OpenAI error" }; return; }
      if (json.usage) usage = { inputTokens: json.usage.prompt_tokens, outputTokens: json.usage.completion_tokens };
      const delta = json.choices?.[0]?.delta?.content;
      if (delta) yield { text: delta };
      // Usage may arrive AFTER finish_reason; wait for [DONE].
    }
    yield { error: "Provider stream ended before completion.", retryable: true };
  },
};

// -------------------------------------------------------------------------
// GOOGLE GEMINI
// -------------------------------------------------------------------------
const gemini = {
  id: "gemini",
  label: "Gemini (Google)",
  envKey: "GEMINI_API_KEY",
  buildRequest(apiKey, { model, messages, system, maxTokens }) {
    const m = model || this.defaultModel;
    const contents = messages.map((msg) => ({
      role: msg.role === "assistant" ? "model" : "user",
      parts: [{ text: msg.content }],
    }));
    const body = {
      contents,
      generationConfig: { maxOutputTokens: maxTokens || 2048 },
    };
    if (system) body.systemInstruction = { parts: [{ text: system }] };
    return {
      url: `https://generativelanguage.googleapis.com/v1beta/models/${m}:streamGenerateContent?alt=sse`,
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": apiKey,
      },
      body: JSON.stringify(body),
    };
  },
  async *parseStream(response) {
    let usage = null;
    for await (const { data } of iterateSSE(response)) {
      let json;
      try { json = JSON.parse(data); } catch { continue; }
      if (json.error) { yield { error: json.error.message || "Gemini error" }; return; }
      if (json.usageMetadata) {
        usage = { inputTokens: json.usageMetadata.promptTokenCount, outputTokens: (json.usageMetadata.candidatesTokenCount || 0) + (json.usageMetadata.thoughtsTokenCount || 0) };
      }
      const parts = json.candidates?.[0]?.content?.parts;
      if (parts) {
        for (const p of parts) if (p.text) yield { text: p.text };
      }
      if (json.candidates?.[0]?.finishReason) { yield { done: true, usage }; return; }
    }
    yield { error: "Provider stream ended before completion.", retryable: true };
  },
};

// -------------------------------------------------------------------------
// xAI GROK (OpenAI-compatible wire format)
// -------------------------------------------------------------------------
const grok = {
  id: "grok",
  label: "Grok (xAI)",
  envKey: "XAI_API_KEY",
  buildRequest(apiKey, { model, messages, system, maxTokens }) {
    const msgs = [];
    if (system) msgs.push({ role: "system", content: system });
    for (const m of messages) msgs.push({ role: m.role, content: m.content });
    return {
      url: "https://api.x.ai/v1/chat/completions",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: model || this.defaultModel,
        messages: msgs,
        max_tokens: maxTokens || 2048,
        stream: true,
        stream_options: { include_usage: true },
      }),
    };
  },
  async *parseStream(response) {
    let usage = null;
    for await (const { data } of iterateSSE(response)) {
      if (data === "[DONE]") { yield { done: true, usage }; return; }
      let json;
      try { json = JSON.parse(data); } catch { continue; }
      if (json.error) { yield { error: json.error.message || "Grok error" }; return; }
      if (json.usage) usage = { inputTokens: json.usage.prompt_tokens, outputTokens: json.usage.completion_tokens };
      const delta = json.choices?.[0]?.delta?.content;
      if (delta) yield { text: delta };
      // Usage may arrive AFTER finish_reason; wait for [DONE].
    }
    yield { error: "Provider stream ended before completion.", retryable: true };
  },
};

export const PROVIDERS = {
  claude: anthropic,
  openai,
  gemini,
  grok,
};

// Model metadata is shared with the browser; adapter details remain server-side.
for (const provider of Object.values(PROVIDERS)) {
  provider.models = MODEL_CATALOG.filter(m => m.provider === provider.id);
  provider.defaultModel = provider.models.find(m => m.tier === 'balanced')?.id || provider.models[0].id;
}

/**
 * Calls a provider and yields normalized {text?, done?, error?, status?,
 * retryable?} chunks. Handles the actual fetch + non-2xx handling in one
 * place so every edge function does the exact same error handling.
 */
export async function* streamFromProvider(providerId, apiKey, params) {
  const provider = PROVIDERS[providerId];
  if (!provider) {
    yield { error: `Unknown provider "${providerId}"`, status: 400, retryable: false };
    return;
  }
  if (!apiKey) {
    yield {
      error: `No API key configured for ${provider.label}. Set ${provider.envKey} in your Netlify environment variables.`,
      status: 401,
      retryable: false,
      reason: "missing_key",
    };
    return;
  }
  if (params.model && !findModel(providerId, params.model)) {
    yield { error: 'Unsupported model for this provider.', status:400, retryable:false }; return;
  }
  const { url, headers, body } = provider.buildRequest(apiKey, params);
  const timeout = AbortSignal.timeout(params.timeoutMs || 90_000);
  const signal = params.signal ? AbortSignal.any([params.signal, timeout]) : timeout;
  let response;
  try {
    response = await fetch(url, { method: "POST", headers, body, signal });
  } catch (err) {
    yield { error: `Network error calling ${provider.label}: ${err.message}`, status: 0, retryable: !signal.aborted, reason: "network" };
    return;
  }
  if (!response.ok) {
    const message = await readErrorBody(response);
    const retryable = response.status === 429 || response.status >= 500;
    const reason = response.status === 429 ? "rate_limited" : response.status === 401 || response.status === 403 ? "auth" : "provider_error";
    const diagnostic = diagnoseProviderAuth(providerId, { status: response.status, message });
    yield { error: `${provider.label} returned HTTP ${response.status}: ${message}`, status: response.status, retryable, reason: diagnostic.reason === "invalid_issuer" ? "invalid_issuer" : reason, diagnostic };
    return;
  }
  try { yield* provider.parseStream(response); }
  catch (err) { yield {error: signal.aborted ? 'Request stopped or timed out.' : 'Provider stream was interrupted.', retryable: !signal.aborted}; }
}

/**
 * Same contract as streamFromProvider, but retries the connection with
 * exponential backoff + jitter when the failure happens BEFORE any text
 * was streamed back (network blip, 429, or a transient 5xx). Once even one
 * text chunk has reached the caller, a failure is passed straight through
 * rather than retried — retrying mid-stream would risk emitting duplicate
 * or out-of-order text, which is worse than surfacing the error.
 */
export async function* streamFromProviderWithRetry(providerId, apiKey, params, { maxRetries = 2 } = {}) {
  let attempt = 0;
  while (true) {
    if (params.signal?.aborted) { yield {error:"Request stopped.",retryable:false}; return; }
    let yieldedText = false;
    let lastChunk = null;
    for await (const chunk of streamFromProvider(providerId, apiKey, params)) {
      if (chunk.text) yieldedText = true;
      if (chunk.error && !yieldedText && chunk.retryable && attempt < maxRetries) {
        lastChunk = chunk;
        break;
      }
      yield chunk;
      if (chunk.done || (chunk.error && (yieldedText || !chunk.retryable))) return;
    }
    if (!lastChunk) return; // stream completed normally without needing a retry
    attempt += 1;
    const backoffMs = Math.min(4000, 250 * 2 ** attempt) + Math.floor(Math.random() * 200);
    await new Promise((resolve) => setTimeout(resolve, backoffMs));
  }
}

/** Centralizes the provider-id -> env-var-name lookup that used to be
 * copy-pasted separately in chat.js, council.js, and workflow.js. */
export function getApiKeyForProvider(providerId, env) {
  const provider = PROVIDERS[providerId];
  if (!provider) return null;
  return env.get(provider.envKey) || null;
}

export function getProviderDiagnostics(env) {
  return Object.fromEntries(Object.values(PROVIDERS).map((provider) => {
    const configured = Boolean(env.get(provider.envKey));
    return [provider.id, {
      configured,
      envKey: provider.envKey,
      status: configured ? "configured" : "missing_key",
      message: configured ? `${provider.label} key is configured.` : `Set ${provider.envKey} to enable ${provider.label}.`,
    }];
  }));
}

export function getModelCatalog() {
  return Object.values(PROVIDERS).map((p) => ({
    id: p.id,
    label: p.label,
    defaultModel: p.defaultModel,
    models: p.models,
  }));
}

// -------------------------------------------------------------------------
// Approximate cost estimation
// -------------------------------------------------------------------------
// Self-reported, approximate USD-per-million-tokens pricing as of the last
// time this file was updated. Provider pricing changes; treat this as a
// rough usage indicator for your own dashboard, NOT a billing-accurate
// figure — always check the provider's own pricing page for real costs.
/** Cost uses the actual model and final provider usage; unknown is not zero. */
export function estimateCostUsd(providerId, usage, modelId = PROVIDERS[providerId]?.defaultModel) {
  if (!usage) return null;
  return estimateModelCost(findModel(providerId, modelId), usage.inputTokens, usage.outputTokens);
}
