import {runtimeSecret} from './runtime-secrets.js';
import {getStore} from '@netlify/blobs';
import {validAccountId} from './storage/accounts.js';
// ==========================================================================
// SAMVIT — SECURITY HELPERS (shared by edge functions AND node functions)
// --------------------------------------------------------------------------
// Deliberately written with only Web-standard APIs (crypto.subtle, atob/
// btoa, TextEncoder) so the exact same file works in Deno (edge functions)
// and Node 18+ (regular functions) without a build step. The one relative
// import below (casUpdate, v4 Priority 6) keeps that property -- it's
// plain JS using only the same Web-standard store calls this file already
// made directly, not an npm dependency or anything runtime-specific.
//
// What this actually protects: your API keys and your bill. Samvit is
// designed to be deployed to a public Netlify URL. Without SESSION_SECRET +
// ACCESS_CODE configured, anyone who finds that URL can spend your OpenAI /
// Anthropic / Gemini / xAI credits. Set them before you share the link.
// ==========================================================================
import { casUpdate } from "./storage/concurrency.js";

const COOKIE_NAME = "samvit_session";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function toBase64Url(bytes) {
  let str = "";
  for (const b of bytes) str += String.fromCharCode(b);
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(str) {
  const padded = str.replace(/-/g, "+").replace(/_/g, "/").padEnd(str.length + ((4 - (str.length % 4)) % 4), "=");
  const bin = atob(padded);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function hmac(secret, message) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return toBase64Url(new Uint8Array(sig));
}

/** Builds a signed "payload.signature" token. Payload is a base64url JSON blob. */
export async function signToken(secret, payload) {
  const payloadStr = toBase64Url(new TextEncoder().encode(JSON.stringify(payload)));
  const sig = await hmac(secret, payloadStr);
  return `${payloadStr}.${sig}`;
}

/** Verifies a token produced by signToken. Returns the payload or null. */
export async function verifyToken(secret, token) {
  if (!token || typeof token !== "string" || token.length>4096 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) return null;
  const [payloadStr, sig] = token.split(".");
  const expected = await hmac(secret, payloadStr);
  if (expected.length !== sig.length) return null;
  // constant-time-ish compare
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ sig.charCodeAt(i);
  if (diff !== 0) return null;
  try {
    const payload = JSON.parse(new TextDecoder().decode(fromBase64Url(payloadStr)));
    if (!Number.isFinite(payload.exp) || Date.now() >= payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

/**
 * Constant-time string comparison. Used for the ACCESS_CODE check so a
 * network attacker measuring response-time differences can't narrow down
 * the code character-by-character. (In practice network jitter already
 * makes this hard, but there's no reason to rely on that when a correct
 * compare costs nothing.) Falls back to a length-only-revealing compare —
 * still constant-time in the number of characters actually compared.
 */
export function timingSafeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const maxLen = Math.max(a.length, b.length);
  let diff = a.length === b.length ? 0 : 1;
  for (let i = 0; i < maxLen; i++) {
    const ca = i < a.length ? a.charCodeAt(i) : 0;
    const cb = i < b.length ? b.charCodeAt(i) : 0;
    diff |= ca ^ cb;
  }
  return diff === 0;
}

export function extractCookie(request, name) {
  const header = request.headers.get("cookie") || "";
  for (const part of header.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) return decodeURIComponent(rest.join("="));
  }
  return null;
}

export function sessionCookieHeader(token, { clear = false } = {}) {
  const maxAge = clear ? 0 : Math.floor(SESSION_TTL_MS / 1000);
  const value = clear ? "" : token;
  return `${COOKIE_NAME}=${encodeURIComponent(value)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

// Samvit has one shared ACCESS_CODE, not real per-user accounts (see
// ROADMAP.md "Real per-user accounts") -- every signed session's token
// payload carries this SAME fixed subject. Exported as the one place that
// fact lives, instead of "samvit-user" being separately hardcoded in
// auth.mjs's signToken() call AND here. v4 Priority 5 (subscription/
// entitlement lookups) uses this as the account id to key a subscription
// record by -- correct for today's single-tenant reality, and exactly the
// field ROADMAP.md says would carry a real per-user id once real accounts
// exist, so nothing about that future migration needs to change here.
export const DEFAULT_ACCOUNT_ID = "samvit-user";

// -------------------------------------------------------------------------
// Environment separation (v4 Priority 5 — production hardening pass)
// -------------------------------------------------------------------------
// THE BUG THIS CLOSES: requireSession() used to treat "ACCESS_CODE isn't
// set" as the ONLY signal for "this deployment is intentionally open for
// local dev." That conflates two different questions -- "did the operator
// configure auth?" and "is this a production deployment at all?" -- into
// one. A production deploy that simply forgot to set ACCESS_CODE (a real,
// plausible deployment misconfiguration, not a hypothetical) silently
// became fully open: every endpoint, including AI Council, with zero auth
// and zero entitlement enforcement. Inferring production-safety from
// whether a config value happens to exist is exactly what the brief calls
// out as wrong to do.
//
// THE FIX: an explicit, deliberate opt-in is now required to run open.
// `NODE_ENV=production` is an absolute override -- if it's set, this is
// production, full stop, even if DEV_MODE was accidentally left set (belt
// and suspenders: a leftover dev flag in a prod environment must not
// reopen the app). Otherwise, open/dev behavior requires `DEV_MODE=true`
// literally -- not "any truthy string", not inferred from anything else.
// No signal at all (the common case for a deployment nobody has
// configured either way yet) is treated as PRODUCTION, not development --
// the safe default is to require explicit auth config, not to require an
// explicit lockdown flag. This is what "fail closed" means in practice
// here: the default posture is locked, and dev mode is the opt-in, not
// the other way around.
export function isDevelopmentMode(env) {
  if (env?.get?.("NODE_ENV") === "production") return false;
  return env?.get?.("DEV_MODE") === "true";
}

// Safe, non-leaking codes for the "this deployment's auth/entitlement
// checks cannot run at all" family of failures (brief section 7/9) --
// distinct from AUTH_ERRORS-shaped per-request outcomes like "not signed
// in yet", which are a normal, expected state, not a misconfiguration.
export const AUTHENTICATION_UNAVAILABLE = "AUTHENTICATION_UNAVAILABLE";

/** Resolve a signed, unrevoked per-user session. Explicit local development retains the legacy ID. */
export async function requireSession(request, env) {
  // The existing explicit local-development exception is preserved; production is never open.
  if(!env.get('ACCESS_CODE') && isDevelopmentMode(env)) return {ok:true,open:true,accountId:DEFAULT_ACCOUNT_ID,role:'developer'};
  let secret;try{secret=await runtimeSecret(env,'SESSION_SECRET');}catch{return {ok:false,status:503,code:AUTHENTICATION_UNAVAILABLE,message:'Session storage is unavailable.'};}
  if(!secret||secret.length<32)return {ok:false,status:500,code:AUTHENTICATION_UNAVAILABLE,message:'Account sign-in is not configured. Set a session secret of at least 32 characters.'};
  let payload;try{payload=await verifyToken(secret,extractCookie(request,COOKIE_NAME));}catch{return {ok:false,status:401,message:'Sign in to your account.'};}
  if(!payload||!validAccountId(payload.sub))return {ok:false,status:401,message:'Sign in to your account.'};
  if(!['GET','HEAD','OPTIONS'].includes(request.method)){
    const origin=request.headers.get('origin');if(origin&&origin!==new URL(request.url).origin)return {ok:false,status:403,message:'Invalid request origin.'};
  }
  try{
    const store=getStore('samvit-accounts'),user=await store.get('account:'+payload.sub,{type:'json',consistency:'strong'});
    if(!user||user.disabled||payload.version!==user.sessionVersion)return {ok:false,status:401,message:'This session is no longer valid. Sign in again.'};
    const path=new URL(request.url).pathname;
    if(!user.emailVerified&&!['/api/auth','/api/status','/api/account'].includes(path))return {ok:false,status:403,message:'Verify your email before using this feature.'};
    const meta=await store.get('meta',{type:'json',consistency:'strong'});
    if(meta?.ownerAccountId===user.id&&!meta.migrationComplete)return {ok:false,status:503,message:'Your data migration must finish. Sign in again to resume it.'};
    return {ok:true,open:false,accountId:user.id,email:user.email,emailVerified:Boolean(user.emailVerified),role:user.emailVerified?(meta?.ownerAccountId===user.id?'owner':'member'):'unverified'};
  }catch{return {ok:false,status:503,code:AUTHENTICATION_UNAVAILABLE,message:'Account verification is temporarily unavailable.'};}
}

export { COOKIE_NAME, SESSION_TTL_MS };

// -------------------------------------------------------------------------
// Rate limiting (Netlify Blobs backed, fixed-window)
// -------------------------------------------------------------------------
/**
 * @param {object} store  a Netlify Blobs store instance (from getStore())
 * @param {string} identifier  e.g. client IP or session id
 * @param {object} opts  { windowMs, max }
 */
// -------------------------------------------------------------------------
// Rate limiting (v4 Priority 2 — concurrency-safe)
// -------------------------------------------------------------------------
// v3/early-v4 implementation did a plain read -> increment -> write, with
// no check that the value hadn't changed in between. Two concurrent
// requests could both read count=N, both compute N+1, both write N+1 --
// one increment is silently lost, so the limit is under-enforced exactly
// when it matters most (a burst of concurrent requests). @netlify/blobs
// v10 supports real conditional writes (verified against
// node_modules/@netlify/blobs/dist/main.d.ts, not assumed): `onlyIfNew`
// (succeed only if the key doesn't exist yet) and `onlyIfMatch` (succeed
// only if the key's current ETag matches). That's a real compare-and-swap
// primitive, so the fix is the standard one for building an atomic counter
// on top of CAS-only storage: read the current value + its ETag, compute
// the new value, attempt a conditional write, and retry with fresh data if
// another request's write won the race in between.
//
// A first version of this retried immediately, in a tight loop, with a
// small fixed retry budget. Under real concurrency that's exactly wrong:
// every contending request retries at the same instant, so they keep
// colliding with each other rather than spreading out -- tested with 10-50
// truly simultaneous requests (see the "concurrency" describe block in
// security.test.js), most of them exhausted their retries and fell back to
// failing open, meaning the limit went *unenforced* under the exact
// bursty-traffic condition it exists to handle. Fixed with the standard
// remedy for CAS contention: small jittered backoff between attempts, so
// retries desynchronize instead of repeatedly colliding, plus a smarter
// last resort -- if every attempt is somehow still exhausted, make one
// final best-effort decision from a fresh read (deny if that read already
// shows the limit hit) instead of unconditionally allowing. That fallback
// path has a narrow race of its own (a plain read without a verified
// write), but it's a real, informed decision rather than a blind opening.
// Exported specifically so tests can construct mocks that precisely target
// "a read during the retry loop" vs "the fallback's one dedicated read
// after every retry is exhausted" without duplicating or guessing this
// number — see the "exhaustion fallback ... DENY" test in security.test.js.
export const RATE_LIMIT_CAS_MAX_RETRIES = 8;
const RATE_LIMIT_BACKOFF_BASE_MS = 2;

/**
 * @param {object} store  Netlify Blobs store (getStore("samvit-ratelimits"))
 * @param {string} identifier  e.g. `chat:${clientIp}` or `council:${clientIp}`
 * @param {{windowMs?: number, max?: number}} options
 * @param {number} weight  How many units of the limit this one call consumes.
 *   Defaults to 1 (one request = one unit, the original behavior). AI
 *   Council passes a higher weight reflecting how many actual provider
 *   calls one request fans out to (see council.js) -- a 4-model request
 *   with critique enabled costs 8 real provider calls, and the rate limit
 *   now reflects that instead of counting it the same as a single chat
 *   message. A request is rejected if it would need more units than are
 *   left in the current window, even if some budget remains.
 */
export async function checkRateLimit(store, identifier, { windowMs = 60_000, max = 20 } = {}, weight = 1) {
  const windowStart = Math.floor(Date.now() / windowMs) * windowMs;
  const key = `rl:${identifier}:${windowStart}`;
  const resetMs = () => windowStart + windowMs - Date.now();

  for (let attempt = 0; attempt <= RATE_LIMIT_CAS_MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      // Jittered backoff BEFORE re-reading, growing with attempt number --
      // this is what actually fixes the contention problem: without it,
      // every colliding request retries in perfect lockstep and keeps
      // colliding. Small (single-digit-to-low-double-digit ms) so this
      // stays fast under test and doesn't meaningfully add to real
      // request latency even at the high end.
      const backoffMs = RATE_LIMIT_BACKOFF_BASE_MS * attempt + Math.random() * RATE_LIMIT_BACKOFF_BASE_MS * attempt;
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
    }

    let existing;
    try {
      existing = await store.getWithMetadata(key, { type: "json", consistency: "strong" });
    } catch (err) {
      return failOpen(identifier, "read", err, max, resetMs());
    }

    const count = existing?.data?.count || 0;
    if (count + weight > max) {
      // Reject WITHOUT spending a write -- the caller doesn't have enough
      // remaining budget in this window for this request's full cost,
      // even if some budget is left (see `weight` doc above).
      return { allowed: false, remaining: Math.max(0, max - count), resetMs: resetMs() };
    }

    const nextCount = count + weight;
    try {
      const writeOptions = existing ? { onlyIfMatch: existing.etag } : { onlyIfNew: true };
      const result = await store.setJSON(key, { count: nextCount }, writeOptions);
      if (result.modified) {
        return { allowed: true, remaining: Math.max(0, max - nextCount), resetMs: resetMs() };
      }
      // Lost the compare-and-swap race: another request's write landed
      // between our read and our write. Loop and retry with fresh data --
      // this is the fix, not a fallback; under real concurrency this is
      // expected to happen occasionally and is exactly what makes the
      // final count correct instead of silently dropping an increment.
    } catch (err) {
      return failOpen(identifier, "write", err, max, resetMs());
    }
  }

  // Every attempt collided. Rather than blindly allow (which is what the
  // first version of this function did, and which the concurrency tests
  // caught as under-enforcement -- see the block comment above), make one
  // more read and decide from that: if it already shows the budget
  // exhausted, deny; otherwise allow without a verified write. This still
  // has a narrow race (this final decision isn't itself compare-and-swapped
  // against), but "exhausted every retry despite jittered backoff" should
  // now be rare, and an informed best-effort decision is a meaningfully
  // better failure mode than an unconditional one.
  try {
    const finalRead = await store.getWithMetadata(key, { type: "json", consistency: "strong" });
    const finalCount = finalRead?.data?.count || 0;
    logDegraded(identifier, "exhausted retries, decided from final read", { attempts: RATE_LIMIT_CAS_MAX_RETRIES, finalCount });
    return {
      allowed: finalCount + weight <= max,
      remaining: Math.max(0, max - finalCount),
      degraded: true,
      resetMs: resetMs(),
    };
  } catch (err) {
    return failOpen(identifier, "final read after exhausted retries", err, max, resetMs());
  }
}

function failOpen(identifier, phase, err, max, resetMs) {
  logDegraded(identifier, `${phase} failed`, { error: err?.message });
  return { allowed: true, remaining: max, degraded: true, resetMs };
}

/** Rate-limit degradation is a real, security-relevant event (it means
 * this request either went through with no verified limit check, or was
 * decided from a non-atomic fallback) -- worth a structured log line even
 * without a logger instance threaded through every call site. Matches
 * logger.js's JSON-line format for consistency. */
function logDegraded(identifier, reason, extra) {
  console.warn(JSON.stringify({ ts: new Date().toISOString(), level: "warn", scope: "rate-limit", message: "Rate limit check degraded", identifier, reason, ...extra }));
}

export function clientIdentifier(request, context) {
  return (
    context?.ip ||
    request.headers.get("x-nf-client-connection-ip") ||
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    "unknown"
  );
}

// -------------------------------------------------------------------------
// Audit log (Netlify Blobs backed, append-only-ish, capped)
// -------------------------------------------------------------------------
const AUDIT_KEY = "log";
const MAX_AUDIT_ENTRIES = 500;

/**
 * Records a real security-relevant event (login success/failure, logout,
 * memory purge, session revocation UI action, Council authorization
 * decisions). Best-effort — a logging failure must never block the
 * request it's logging; several callers (auth.mjs's login/logout flow)
 * `await` this directly with no try/catch of their own, relying on this
 * function's own contract to NEVER throw, which is preserved exactly as
 * before.
 *
 * v4 Priority 6 (storage concurrency): the read-modify-write itself is
 * now done via casUpdate() (netlify/lib/storage/concurrency.js) instead
 * of a plain read-then-write — under real concurrency (e.g. several
 * Council authorization decisions logging at once, which is exactly the
 * kind of burst this app actually produces), the old version could lose
 * an entry: two concurrent calls both read the same list, both prepend
 * their own event, and the second write silently discarded the first
 * event with no error and no trace. Audit-log entries existing specifically
 * to be trustworthy under exactly this kind of concurrent security-
 * decision logging, silently losing one was a real, if lower-severity,
 * correctness bug — worth fixing under the SAME best-effort contract
 * (a genuine storage outage/sustained conflict still just means "this one
 * entry didn't get logged," never "block the request"), not a stricter one.
 *
 * @param {object} store  Netlify Blobs store (getStore("samvit-audit"))
 */
export async function recordAuditEvent(store, event) {
  try {
    await casUpdate(store, AUDIT_KEY, (current) => {
      const list = Array.isArray(current) ? current : [];
      return [{ ts: new Date().toISOString(), ...event }, ...list].slice(0, MAX_AUDIT_ENTRIES);
    });
  } catch {
    // Best-effort only -- unchanged contract, now covering StorageConflictError/
    // StorageUnavailableError from casUpdate() the same way it always covered
    // a plain thrown error from store.get()/setJSON().
  }
}

export async function listAuditEvents(store, limit = 50) {
  try {
    const existing = (await store.get(AUDIT_KEY, { type: "json", consistency: "strong" })) || [];
    return Array.isArray(existing) ? existing.slice(0, limit) : [];
  } catch {
    return [];
  }
}
