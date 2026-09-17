// ==========================================================================
// SAMVIT — PLUGIN SDK
// --------------------------------------------------------------------------
// A real, minimal plugin contract and registry — not a marketplace, not
// OAuth-integrated third-party connectors (GitHub/Figma/Notion/etc.). Those
// need real OAuth app registrations and a review/security story of their
// own (see ROADMAP.md "Plugin marketplace"). What's here is the actual
// SDK contract every future plugin — including real GitHub/Figma/Notion
// ones later — would implement, proven end-to-end with one real, safe,
// no-credentials-needed plugin (see netlify/plugins/fetch-url.js).
//
// PLUGIN CONTRACT
// A plugin is a plain object:
//   {
//     id: string,              unique, lowercase-kebab-case
//     name: string,             human label
//     description: string,
//     version: string,           semver-ish, informational
//     permissions: string[],      declared upfront, e.g. ["network:fetch"] —
//                                  advisory today (nothing enforces a
//                                  plugin can't exceed what it declares;
//                                  see ROADMAP.md "Real plugin sandboxing"
//                                  for what actual enforcement needs), but
//                                  every plugin must declare something so
//                                  a reviewer or future sandbox has a
//                                  starting point.
//     inputSchema: { required: string[], properties: Record<string,string> },
//                                  a minimal, dependency-free description —
//                                  NOT JSON Schema (no validator dependency
//                                  added for this), just enough to check
//                                  required fields are present and typed.
//     handler: async (input, context) => result   -- context: { log }
//   }
// ==========================================================================

const registry = new Map();
const DEFAULT_TIMEOUT_MS = 15_000;

export function registerPlugin(plugin) {
  const errors = validatePluginManifest(plugin);
  if (errors.length > 0) {
    throw new Error(`Invalid plugin manifest for "${plugin?.id || "?"}": ${errors.join("; ")}`);
  }
  registry.set(plugin.id, plugin);
}

export function validatePluginManifest(plugin) {
  const errors = [];
  if (!plugin || typeof plugin !== "object") return ["plugin must be an object"];
  if (!plugin.id || !/^[a-z][a-z0-9-]*$/.test(plugin.id)) errors.push("id must be lowercase-kebab-case");
  if (!plugin.name) errors.push("name is required");
  if (!plugin.description) errors.push("description is required");
  if (!Array.isArray(plugin.permissions) || plugin.permissions.length === 0) errors.push("permissions must be a non-empty array");
  if (!plugin.inputSchema || !Array.isArray(plugin.inputSchema.required)) errors.push("inputSchema.required must be an array");
  if (typeof plugin.handler !== "function") errors.push("handler must be a function");
  return errors;
}

export function listPlugins() {
  return Array.from(registry.values()).map((p) => ({
    id: p.id,
    name: p.name,
    description: p.description,
    version: p.version || "0.0.0",
    permissions: p.permissions,
    inputSchema: p.inputSchema,
  }));
}

export function getPlugin(id) {
  return registry.get(id) || null;
}

/** Checks `input` against a plugin's declared inputSchema.required — a
 * plain presence/type check, not full JSON Schema validation. */
export function validateInput(plugin, input) {
  const errors = [];
  const props = plugin.inputSchema?.properties || {};
  for (const key of plugin.inputSchema?.required || []) {
    if (input?.[key] === undefined || input?.[key] === null || input?.[key] === "") {
      errors.push(`"${key}" is required`);
      continue;
    }
    const expectedType = props[key];
    if (expectedType && typeof input[key] !== expectedType) {
      errors.push(`"${key}" must be a ${expectedType}`);
    }
  }
  return errors;
}

/**
 * Runs a plugin's handler with input validation and a hard timeout, so one
 * slow/hung plugin can't hang the request indefinitely. Never throws for
 * plugin-side failures — always resolves to { ok, result } or { ok: false, error }.
 */
export async function invokePlugin(id, input, context = {}) {
  const plugin = getPlugin(id);
  if (!plugin) return { ok: false, error: `No plugin registered with id "${id}".` };

  const inputErrors = validateInput(plugin, input);
  if (inputErrors.length > 0) return { ok: false, error: `Invalid input: ${inputErrors.join("; ")}` };

  const timeoutMs = plugin.timeoutMs || DEFAULT_TIMEOUT_MS;
  let timeoutHandle;
  try {
    const result = await Promise.race([
      plugin.handler(input, context),
      new Promise((_, reject) => {
        timeoutHandle = setTimeout(() => reject(new Error(`Plugin "${id}" timed out after ${timeoutMs}ms.`)), timeoutMs);
      }),
    ]);
    return { ok: true, result };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  } finally {
    clearTimeout(timeoutHandle);
  }
}

/** Test/dev helper — real callers should only ever import registerPlugin. */
export function _resetRegistryForTests() {
  registry.clear();
}
