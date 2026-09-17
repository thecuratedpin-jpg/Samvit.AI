// ==========================================================================
// SAMVIT — /api/plugins
// --------------------------------------------------------------------------
//   GET  /api/plugins                          list registered plugin manifests
//   POST /api/plugins { pluginId, input }       invoke a plugin
//
// Backs the real Plugin SDK (netlify/lib/plugin-registry.js). Registered
// plugins are imported for their side effect (each calls registerPlugin())
// before this handles any request — see the import below. Rate-limited
// like every other AI-adjacent/network-adjacent endpoint.
// ==========================================================================
import { getStore } from "@netlify/blobs";
import { requireSession, checkRateLimit, clientIdentifier } from "../lib/security.js";
import { listPlugins, invokePlugin } from "../lib/plugin-registry.js";
import { createLogger } from "../lib/logger.js";
import "../plugins/fetch-url.js"; // registers the "fetch-url" plugin

const envAdapter = { get: (k) => process.env[k] };

export default async (req, context) => {
  const auth = await requireSession(req, envAdapter);
  if (!auth.ok) return json({ error: auth.message }, auth.status);

  if (req.method === "GET") {
    return json({ plugins: listPlugins() });
  }

  if (req.method === "POST") {
    if(req.headers.get('origin')&&req.headers.get('origin')!==new URL(req.url).origin)return json({error:'Invalid request origin'},403);
    let body;
    try {
      body = await req.json();
    } catch {
      return json({ error: "Malformed request body." }, 400);
    }
    if (typeof body.pluginId !== "string") return json({ error: "`pluginId` is required." }, 400);

    try {
      const store = getStore("samvit-ratelimits");
      const id = clientIdentifier(req, context || {});
      const rl = await checkRateLimit(store, `plugin:${id}`, { windowMs: 60_000, max: Number(envAdapter.get("RATE_LIMIT_PER_MINUTE")) || 20 });
      if(rl.degraded)return json({error:'Tool usage controls unavailable'},503);
      if (!rl.allowed) return json({ error: `Plugin rate limit reached. Try again in ${Math.ceil(rl.resetMs / 1000)}s.` }, 429);
    } catch (_) {return json({error:'Tool usage controls unavailable'},503);}

    const log = createLogger(envAdapter, "plugins");
    const outcome = await invokePlugin(body.pluginId, body.input || {}, { log });
    if (!outcome.ok) return json({ error: outcome.error }, 400);
    return json({ result: outcome.result });
  }

  return json({ error: "Method not allowed" }, 405);
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
}

export const config = { path: "/api/plugins" };
