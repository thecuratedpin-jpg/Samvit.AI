// ==========================================================================
// SAMVIT — AI ROUTER
// --------------------------------------------------------------------------
// Classifies an incoming user message so the app (or the person using it)
// can decide: is this a quick chat, does it deserve running past multiple
// models (Council), or is it actually a multi-step goal that should become
// a Mission?
//
// HONEST ABOUT WHAT THIS IS: a deterministic, pattern-based heuristic
// classifier — regex/keyword signals over the message text, not a trained
// model and not an extra LLM call. That's a deliberate choice, not a
// shortcut: calling a model just to decide how to route to a model would
// add real cost and latency to every single message. It's also why this
// is a pure function (no imports, no I/O) — fully unit-testable and fast
// enough to run on every keystroke if a UI wants to.
//
// This is a real, working v1 — not the whole of what "AI Router" could
// mean. See ROADMAP.md ("Smarter AI Router") for the honest next step:
// an optional model-based classifier for cases this heuristic gets wrong,
// gated behind an explicit setting since it has a real cost.
// ==========================================================================

const MULTI_STEP_PATTERNS = [
  /\bstep\s*1\b/i,
  /\bfirst\b.{0,40}\bthen\b/i,
  /\band then\b/i,
  /\bafter that\b/i,
  /\bplan (out|for)\b/i,
  /\bbuild (me )?a plan\b/i,
  /\bmulti[- ]step\b/i,
  /\bbreak (this |it )?down\b/i,
  /^\s*\d+[.)]\s+.+\n\s*\d+[.)]\s+/m, // an actual numbered list in the message
];

const COUNCIL_PATTERNS = [
  /\bcompare (models|answers|opinions)\b/i,
  /\bdifferent (ai|model|opinion)s?\b/i,
  /\bask (multiple|several|different) models?\b/i,
  /\bsecond opinion\b/i,
  /\bwhat do (you all|the models) think\b/i,
  /\bcross[- ]check\b/i,
];

const CODE_PATTERNS = [/```/, /\b(function|const|class|import|def|SELECT|npm|git)\b/, /\.(js|ts|py|jsx|tsx|sql|json)\b/i];
const COMPARISON_PATTERNS = [/\bvs\.?\b/i, /\bversus\b/i, /\bwhich is better\b/i, /\bpros and cons\b/i, /\bcompare\b/i];
const CREATIVE_PATTERNS = [/\bwrite (a|an|me a)\b.{0,20}\b(poem|story|song|essay|script)\b/i, /\bbrainstorm\b/i];
const QUESTION_PATTERNS = [/^\s*(what|why|how|when|where|who|is|are|does|do|can|should)\b/i, /\?\s*$/];

function countMatches(text, patterns) {
  return patterns.reduce((n, p) => n + (p.test(text) ? 1 : 0), 0);
}

/** Rough complexity signal from length + structural cues. Not a claim of
 * true task difficulty — a proxy good enough to bias defaults. */
function estimateComplexity(text) {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  const conjunctions = (text.match(/\b(and|also|additionally|as well as)\b/gi) || []).length;
  const questionMarks = (text.match(/\?/g) || []).length;
  let score = 0;
  if (words > 40) score += 1;
  if (words > 120) score += 1;
  if (conjunctions >= 2) score += 1;
  if (questionMarks >= 2) score += 1;
  if (score >= 3) return "high";
  if (score >= 1) return "medium";
  return "low";
}

function detectIntent(text) {
  const scores = {
    code: countMatches(text, CODE_PATTERNS),
    comparison: countMatches(text, COMPARISON_PATTERNS),
    creative: countMatches(text, CREATIVE_PATTERNS),
    question: countMatches(text, QUESTION_PATTERNS),
  };
  const top = Object.entries(scores).sort((a, b) => b[1] - a[1])[0];
  return top[1] > 0 ? top[0] : "general";
}

/**
 * @param {{ message: string, configuredProviders?: string[], defaultProvider?: string }} input
 * @returns {{ intent: string, complexity: 'low'|'medium'|'high', suggestedMode: 'chat'|'council'|'mission',
 *             suggestedProvider: string|null, capabilities: string[], reasoning: string[] }}
 */
export function classifyRequest({ message, configuredProviders = [], defaultProvider = null }) {
  const text = typeof message === "string" ? message : "";
  const reasoning = [];

  const intent = detectIntent(text);
  const complexity = estimateComplexity(text);
  const multiStepSignals = countMatches(text, MULTI_STEP_PATTERNS);
  const councilSignals = countMatches(text, COUNCIL_PATTERNS);

  let suggestedMode = "chat";
  if (councilSignals > 0) {
    suggestedMode = "council";
    reasoning.push("Message explicitly asks to compare models/opinions.");
  } else if (multiStepSignals > 0 || (complexity === "high" && intent !== "creative")) {
    suggestedMode = "mission";
    reasoning.push(
      multiStepSignals > 0
        ? "Message describes an ordered, multi-step task."
        : "Message is long/compound enough that a tracked plan likely beats one reply."
    );
  } else {
    reasoning.push("Looks like a single, direct question or request — a normal chat reply fits.");
  }

  const capabilities = [];
  if (intent === "code") capabilities.push("code");
  if (complexity === "high") capabilities.push("long-context");
  if (suggestedMode === "council") capabilities.push("multi-provider");

  // Provider selection: prefer whatever's actually configured, don't assume
  // a specific provider is available — this is the part of the router that
  // has to change as providers come and go, and it's driven entirely by
  // what the caller tells us is configured (see providers.js PROVIDERS for
  // the source of truth), not a hardcoded provider name.
  let suggestedProvider = null;
  if (configuredProviders.length > 0) {
    suggestedProvider = configuredProviders.includes(defaultProvider) ? defaultProvider : configuredProviders[0];
  }

  return { intent, complexity, suggestedMode, suggestedProvider, capabilities, reasoning };
}
