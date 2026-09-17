// ==========================================================================
// SAMVIT — EXAMPLE PLUGIN: fetch-url
// --------------------------------------------------------------------------
// Proves the Plugin SDK contract (plugin-registry.js) end-to-end with one
// real, working plugin that needs no OAuth/credentials: given a public URL,
// fetch it and return cleaned, readable text.
//
// Why not GitHub/Notion/Slack/etc. instead: those need a real OAuth app
// registered with each provider (client id/secret, a redirect URI, a
// consent screen) — infrastructure this project doesn't have and can't
// fake. This plugin needs none of that, so it's the honest way to prove
// the SDK actually works rather than leaving it an untested contract.
//
// SECURITY NOTE: a server-side "fetch any URL the user gives you" endpoint
// is a real SSRF (server-side request forgery) surface — without
// safeguards, it could be used to probe internal network services or cloud
// metadata endpoints (e.g. 169.254.169.254) from Samvit's own server
// context. isUrlSafeToFetch() below is the real defense: only http(s),
// blocks localhost/private/link-local/metadata IP ranges, and re-checks
// after DNS resolution isn't done here (no DNS lookup performed — Node's
// fetch resolves at request time; a determined attacker could still use
// DNS rebinding against the hostname check alone). Documented as a known
// gap, not silently ignored — see ROADMAP.md "Real plugin sandboxing".
// ==========================================================================
import { registerPlugin } from "../lib/plugin-registry.js";
import {safeFetch} from '../lib/intelligence/safe-fetch.js';

const MAX_RESPONSE_CHARS = 20_000;
const FETCH_TIMEOUT_MS = 8_000;

const BLOCKED_HOSTNAMES = new Set(["localhost", "0.0.0.0", "metadata.google.internal"]);

function isPrivateOrReservedIp(hostname) {
  // IPv4 literal checks (10.x, 172.16-31.x, 192.168.x, 127.x, 169.254.x/link-local+cloud metadata)
  const ipv4 = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const [a, b] = [Number(ipv4[1]), Number(ipv4[2])];
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 169 && b === 254) return true; // link-local + AWS/GCP/Azure metadata (169.254.169.254)
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 0) return true;
    return false;
  }
  // IPv6 loopback / unique-local / link-local literals. url.hostname keeps
  // the brackets for IPv6 literals (e.g. "[::1]", "[fc00::1]") — strip them
  // before matching, or these checks silently never fire.
  const ipv6 = hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : null;
  if (ipv6) {
    if (ipv6 === "::1") return true;
    if (/^f[cd][0-9a-f]{2}:/i.test(ipv6)) return true; // fc00::/7 unique-local
    if (/^fe80:/i.test(ipv6)) return true; // link-local
  }
  return false;
}

/** Exported separately so it's directly unit-testable without a network call. */
export function isUrlSafeToFetch(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return { safe: false, reason: "Not a valid URL." };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { safe: false, reason: "Only http/https URLs are allowed." };
  }
  const hostname = url.hostname.toLowerCase();
  if (BLOCKED_HOSTNAMES.has(hostname)) return { safe: false, reason: "This host is blocked." };
  if (hostname.endsWith(".local") || hostname.endsWith(".internal")) return { safe: false, reason: "This host is blocked." };
  if (isPrivateOrReservedIp(hostname)) return { safe: false, reason: "Private/internal addresses are blocked." };
  return { safe: true };
}

function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

async function handler({ url }, { log } = {}) {
  return safeFetch(url,{signal:AbortSignal.timeout(FETCH_TIMEOUT_MS)});
}

export const fetchUrlPlugin = {
  id: "fetch-url",
  name: "Fetch URL",
  description: "Fetches a public web page and returns its readable text content.",
  version: "1.0.0",
  permissions: ["network:fetch"],
  timeoutMs: FETCH_TIMEOUT_MS + 2000,
  inputSchema: { required: ["url"], properties: { url: "string" } },
  handler,
};

registerPlugin(fetchUrlPlugin);
