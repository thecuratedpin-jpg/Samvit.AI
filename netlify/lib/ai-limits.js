// ==========================================================================
// SAMVIT — AI REQUEST INPUT LIMITS (v4 Priority 4)
// --------------------------------------------------------------------------
// Before this, only chat.js validated request size at all (MAX_MESSAGES,
// MAX_MESSAGE_CHARS — duplicated a third time in route.mjs), and even that
// had no cap on TOTAL size across messages: 50 messages x 24,000 chars
// each is a 1.2-million-character request, comfortably accepted, before a
// single provider call happens. council.js and workflow.js had NO length
// validation at all — not stricter, none. A single long-enough `goal` or
// `prompt` sailed straight through to a real (paid) provider call, and
// council.js fans that same unvalidated prompt out to up to 4 providers at
// once.
//
// This is now the one place every AI-calling endpoint validates a request,
// so "every AI endpoint gets equivalent protection" is actually true
// instead of true-by-accident for whichever endpoint happened to get
// checks first.
//
// WHAT THIS IS ACTUALLY PROTECTING AGAINST: cost and abuse, not literally
// exceeding what a provider's API would accept. Every provider Samvit
// talks to has a context window far larger than anything below (see
// PROVIDER_CONTEXT_WINDOWS) — the limits here are deliberately much
// smaller than that, because "the provider would technically accept a
// 900,000-token request" is not the same question as "should Samvit send
// one, and pay for it, on behalf of whoever's holding the access code."
// ==========================================================================

export const MAX_MESSAGES = 50;
export const MAX_MESSAGE_CHARS = 24_000;

// workflow.js's `goal` field is intentionally tighter than a chat message:
// a goal is meant to be a short, focused instruction ("migrate our auth
// service to PKCE"), not a document dump. Kept as its own, smaller,
// deliberately-chosen constant rather than reusing MAX_MESSAGE_CHARS,
// which would loosen a limit that was already correctly tighter than the
// general case -- centralizing it here is about having one source of
// truth per limit, not collapsing every limit into the same number.
export const MAX_GOAL_CHARS = 2000;

// NEW: the actual gap this priority exists to close. A flat ceiling on the
// sum of every message's content plus the system prompt, independent of
// how that total is distributed across messages. 100,000 characters is
// deliberately generous for a real conversation (comfortably covers a
// long multi-turn chat or a sizeable pasted document) while sitting nowhere
// near what any provider would reject outright — this is a cost/abuse
// ceiling, not a technical one.
export const MAX_TOTAL_REQUEST_CHARS = 100_000;

// Rough, honestly-approximate chars-per-token ratio for English text (the
// commonly cited rule of thumb, and roughly what Samvit's own providers.js
// cost estimates already assume implicitly). This is NOT a real tokenizer
// count — provider-side tokenization varies by model and language, can run
// noticeably higher for code or non-English text, and Anthropic/OpenAI/
// Google each publish real token-counting endpoints for exact figures.
// Good enough for "reject before spending money on an obviously oversized
// request," not good enough to bill against — Samvit doesn't try to.
const CHARS_PER_TOKEN_ESTIMATE = 4;

export function estimateTokens(text) {
  return Math.ceil((text?.length || 0) / CHARS_PER_TOKEN_ESTIMATE);
}

// A conservative cap on ESTIMATED input tokens, independent of the
// character cap above (character count and token count don't move in
// perfect lockstep -- dense code or non-English text can run meaningfully
// more tokens per character than the estimate assumes). Derived from
// MAX_TOTAL_REQUEST_CHARS using the same rough ratio, so the two limits
// agree with each other rather than being two independently-guessed
// numbers that could disagree.
export const MAX_ESTIMATED_INPUT_TOKENS = Math.ceil(MAX_TOTAL_REQUEST_CHARS / CHARS_PER_TOKEN_ESTIMATE);

// Real, current published context windows (input capacity), verified via
// web search (Aug 2026) against each provider's own docs/model pages, not
// guessed:
//   - Claude Sonnet 5:  1,000,000 tokens (platform.claude.com)
//   - GPT-5.6 (Sol):    1,050,000 tokens (developers.openai.com)
//   - Gemini 3.1 Pro:   1,048,576 tokens (ai.google.dev / Vertex AI)
//   - Grok 4.5:           500,000 tokens (docs.x.ai) -- notably smaller
//     than the other three; xAI's OWN larger/older models (Grok 4.3, 4.20)
//     have bigger windows than their current flagship does.
// Providers change these without much notice, and Samvit has no automated
// way to detect a change -- treat this as a generous backstop ceiling that
// should essentially never actually trigger in normal use (the flat
// character/token caps above are meaningfully tighter and are what
// actually protects cost day to day), not as Samvit's primary limit.
// Re-verify against each provider's current docs if this ever needs to be
// precise rather than a safety margin.
export const PROVIDER_CONTEXT_WINDOWS = {
  claude: 1_000_000,
  openai: 1_050_000,
  gemini: 1_048_576,
  grok: 500_000,
};

// A generous fraction of a provider's real context window -- this is a
// backstop specifically for a request that's within Samvit's own flat caps
// but is being sent to a provider with a meaningfully smaller window (i.e.
// Grok's 500K vs. the other three's ~1M). In practice MAX_TOTAL_REQUEST_CHARS
// already keeps every request far below even Grok's ceiling, so this exists
// as defense-in-depth and as an honest, grounded answer to "provider-specific
// limits" rather than something expected to fire under normal operation.
const PROVIDER_WINDOW_SAFETY_FRACTION = 0.5;

/**
 * Validates message shape + every size limit above in one place. Every
 * AI-calling endpoint should call this before doing anything that costs
 * money. Returns `{ valid: true }` or `{ valid: false, error }` — `error`
 * is written to be safe to return directly to the client (see the
 * "no internal details" requirement): it names a limit and a concrete
 * number, never an internal constant name, stack trace, or implementation
 * detail.
 *
 * @param {{messages: unknown, system?: string, providers?: string[]}} input
 *   `providers` (plural — council.js's shape) is optional; when given,
 *   the estimated-token check uses the SMALLEST context window among the
 *   selected providers, so picking Grok among your models doesn't let a
 *   request slip through sized for a 1M-token model instead.
 */
export function validateAiRequest({ messages, system, providers } = {}) {
  if (!Array.isArray(messages) || messages.length === 0) {
    return { valid: false, error: "Request must include a non-empty `messages` array." };
  }
  if (messages.length > MAX_MESSAGES) {
    return { valid: false, error: `Too many messages in one request (max ${MAX_MESSAGES}). Start a new conversation.` };
  }

  if (system !== undefined && typeof system !== "string") return {valid:false,error:"System instructions must be text."};
  if (messages.some(m=>!["user","assistant"].includes(m?.role))) return {valid:false,error:"Only user and assistant message roles are supported."};
  let totalChars = typeof system === "string" ? system.length : 0;
  for (const m of messages) {
    if (!m || typeof m !== "object" || typeof m.content !== "string" || m.content.length === 0) {
      return { valid: false, error: "Every message must be an object with non-empty text `content`." };
    }
    if (m.content.length > MAX_MESSAGE_CHARS) {
      return { valid: false, error: `A message exceeds the ${MAX_MESSAGE_CHARS}-character limit.` };
    }
    totalChars += m.content.length;
  }

  if (totalChars > MAX_TOTAL_REQUEST_CHARS) {
    return { valid: false, error: `Total request size exceeds the ${MAX_TOTAL_REQUEST_CHARS}-character limit across all messages. Start a new conversation or shorten what you're sending.` };
  }

  const estimatedTokens = estimateTokens(system) + messages.reduce((sum, m) => sum + estimateTokens(m.content), 0);
  if (estimatedTokens > MAX_ESTIMATED_INPUT_TOKENS) {
    return { valid: false, error: `Estimated input size (~${estimatedTokens} tokens) exceeds the ~${MAX_ESTIMATED_INPUT_TOKENS}-token limit.` };
  }

  if (Array.isArray(providers) && providers.length > 0) {
    const relevantWindows = providers
      .map((p) => PROVIDER_CONTEXT_WINDOWS[typeof p === "string" ? p : p?.provider])
      .filter((w) => Number.isFinite(w));
    if (relevantWindows.length > 0) {
      const smallestWindow = Math.min(...relevantWindows);
      const safeLimit = Math.floor(smallestWindow * PROVIDER_WINDOW_SAFETY_FRACTION);
      if (estimatedTokens > safeLimit) {
        return { valid: false, error: `Estimated input size (~${estimatedTokens} tokens) is too large for one or more of the selected models.` };
      }
    }
  }

  return { valid: true };
}

/** A single free-text field (workflow.js's `goal`, route.mjs's `message`)
 * validated against the same character/token ceilings, for endpoints that
 * take one string rather than a messages array. Kept as a thin wrapper
 * around validateAiRequest so there's exactly one set of numbers, not two.
 * `maxChars` lets a caller apply a tighter field-specific ceiling (e.g.
 * workflow.js's MAX_GOAL_CHARS) on top of the general ones. */
export function validateSingleTextInput(text, { fieldName = "input", maxChars } = {}) {
  if (typeof text !== "string" || !text.trim()) {
    return { valid: false, error: `Request must include a non-empty \`${fieldName}\`.` };
  }
  if (Number.isFinite(maxChars) && text.length > maxChars) {
    return { valid: false, error: `\`${fieldName}\` exceeds the ${maxChars}-character limit.` };
  }
  return validateAiRequest({ messages: [{ role: "user", content: text }] });
}
