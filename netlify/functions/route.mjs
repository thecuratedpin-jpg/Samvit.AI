// ==========================================================================
// SAMVIT — /api/route
// --------------------------------------------------------------------------
//   POST /api/route  { message }  ->  { intent, complexity, suggestedMode,
//                                       suggestedProvider, capabilities, reasoning }
//
// Exposes netlify/lib/router.js — a real, fast, heuristic classifier (see
// that file for exactly what it is and isn't) — so a client can ask "how
// would Samvit route this?" before deciding whether to send a normal chat,
// start a Council run, or generate a Mission plan. Called automatically
// from chat.js's send flow (see src/features/chat.js) to show a real,
// dismissible routing suggestion after each reply -- it never switches
// views on its own.
// ==========================================================================
import { requireSession } from "../lib/security.js";
import { PROVIDERS, getApiKeyForProvider } from "../lib/providers.js";
import { classifyRequest } from "../lib/router.js";
import { validateSingleTextInput } from "../lib/ai-limits.js";

const envAdapter = { get: (k) => process.env[k] };

export default async (req) => {
  const auth = await requireSession(req, envAdapter);
  if (!auth.ok) return json({ error: auth.message }, auth.status);
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  let body;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Malformed request body." }, 400);
  }
  // v4 Priority 4: this used to silently `.slice()` an oversized message
  // down to size before classifying it -- which means the classification
  // (and the routing suggestion the user sees) would have been based on a
  // truncated, possibly mangled version of what they actually typed, with
  // no indication that happened. Rejecting with a clear error is more
  // honest than quietly classifying based on text the user didn't
  // actually send. This endpoint doesn't call a provider itself, so
  // validateSingleTextInput (not the full validateAiRequest, which adds
  // provider-context-window checks that don't apply here) is the right
  // fit -- and it's the same shared limit as everywhere else now, not a
  // third separately-maintained copy of "24000".
  const validation = validateSingleTextInput(body.message, { fieldName: "message" });
  if (!validation.valid) {
    return json({ error: validation.error }, 400);
  }

  const configuredProviders = Object.keys(PROVIDERS).filter((id) => getApiKeyForProvider(id, envAdapter));
  const result = classifyRequest({
    message: body.message,
    configuredProviders,
    defaultProvider: typeof body.defaultProvider === "string" ? body.defaultProvider : configuredProviders[0] || null,
  });

  return json(result);
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
}

export const config = { path: "/api/route" };
