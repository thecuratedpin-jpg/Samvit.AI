// ==========================================================================
// SAMVIT — generic concurrency-safe read-modify-write (v4 Priority 6)
// --------------------------------------------------------------------------
// THE PROBLEM THIS FIXES: this app has, at last count, seven independent
// hand-written copies of the same unsafe pattern —
//
//   const data = await store.get(key);
//   data.someField = newValue;       // or push()/unshift()/splice()/++
//   await store.setJSON(key, data);
//
// — across subscriptions.js (saveSubscription), security.js
// (recordAuditEvent), orchestrator.js (recordUsage/recordHealthPing), and
// the index + record updates in memory.mjs/projects.mjs/missions.mjs/
// conversations.mjs. Two concurrent callers can both read the SAME
// current value, both compute a DIFFERENT next value from it, and
// whichever writes second silently wins — the first caller's update is
// gone, with no error, no retry, and no way to tell it happened. Under
// this app's real concurrency (multiple simultaneous AI requests each
// calling recordUsage(), or two devices both editing the same project),
// this isn't a hypothetical: it drops real writes.
//
// THE FIX, generalized from the ONE place in this codebase that already
// did this correctly (security.js's checkRateLimit(), v4 Priority 2): the
// standard remedy for building a safe read-modify-write on top of a
// storage system that only offers compare-and-swap (not real
// transactions) is read current value + ETag, compute the new value,
// attempt a CONDITIONAL write (`onlyIfMatch`/`onlyIfNew` — real,
// verified-against-node_modules primitives @netlify/blobs v10 supports,
// same verification checkRateLimit()'s own header comment already did),
// and retry with FRESH data if another writer's conditional write won the
// race in between. Small jittered backoff between retries so contending
// writers desynchronize instead of colliding in lockstep (checkRateLimit's
// own comment documents exactly why a first, un-jittered version of that
// function under-enforced the rate limit it exists to enforce — same
// lesson applies here, reused rather than re-learned).
//
// This module has EXACTLY ONE export developers are meant to call
// directly for a bespoke read-modify-write: casUpdate(). Higher-level,
// narrower helpers built on it (upsertIndexEntry, safeGet, ...) live in
// blobs.js / index-list.js — see this directory's own file layout.
// ==========================================================================
import { StorageConflictError, StorageUnavailableError } from "./errors.js";

export const DEFAULT_MAX_RETRIES = 8; // same budget checkRateLimit() uses -- see its own comment for why 8, not some other number: enough headroom for real contention, still bounded (brief section 4: "Do NOT create infinite retry loops")
const DEFAULT_BACKOFF_BASE_MS = 2;

/**
 * Safely applies `updateFn` to the current value stored at `key`, using a
 * real compare-and-swap write so a concurrent writer can never silently
 * clobber this one (or vice versa).
 *
 * @param {object} store  A Netlify Blobs store (getStore(...)).
 * @param {string} key
 * @param {(current: any|null, meta: {etag: string|null}) => any|Promise<any>} updateFn
 *   Receives the CURRENT parsed value (`null` if the key doesn't exist
 *   yet) and must return the value to write next. Called again, with
 *   FRESH data, on every retry — it must be a pure function of `current`
 *   (and `meta`), never something that captures state from an earlier
 *   attempt and assumes it only runs once. May be async. May THROW to
 *   abort the whole operation without writing anything (e.g. "this
 *   record doesn't exist, there's nothing to update" — see
 *   StorageNotFoundError) — a throw from `updateFn` propagates directly
 *   out of casUpdate(), it is never treated as a CAS conflict to retry.
 * @param {{maxRetries?: number, backoffBaseMs?: number}} [options]
 * @returns {Promise<{value: any, attempts: number}>} the value that was
 *   actually written, and how many attempts it took (1 = no contention).
 * @throws {StorageConflictError} every retry lost the compare-and-swap race
 * @throws {StorageUnavailableError} a read or write itself failed (the
 *   store is unreachable) — NOT the same as losing a CAS race, which is a
 *   successful read followed by a rejected conditional write, not a thrown
 *   error.
 */
export async function casUpdate(store, key, updateFn, { maxRetries = DEFAULT_MAX_RETRIES, backoffBaseMs = DEFAULT_BACKOFF_BASE_MS } = {}) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      // Jittered backoff BEFORE re-reading — this is what actually fixes
      // contention (see file header): without it, every colliding writer
      // retries at the same instant and keeps colliding.
      const backoffMs = backoffBaseMs * attempt + Math.random() * backoffBaseMs * attempt;
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
    }

    let existing;
    try {
      existing = await store.getWithMetadata(key, { type: "json", consistency: "strong" });
    } catch (err) {
      throw new StorageUnavailableError(`Failed to read "${key}".`, { cause: err });
    }

    // Deliberately OUTSIDE any try/catch that would swallow it as a
    // storage failure — updateFn is caller logic, not storage I/O, and a
    // validation/not-found error it throws must propagate as-is, not be
    // reinterpreted as "the store is unavailable" or "retry this."
    const current = existing?.data ?? null;
    const next = await updateFn(current, { etag: existing?.etag ?? null });

    try {
      const writeOptions = existing ? { onlyIfMatch: existing.etag } : { onlyIfNew: true };
      const result = await store.setJSON(key, next, writeOptions);
      if (result?.modified) return { value: next, attempts: attempt + 1 };
      // Lost the compare-and-swap race: another writer's write landed
      // between our read and our write. Loop and retry with fresh data —
      // this IS the fix, not a fallback path; under real concurrency this
      // is expected to happen occasionally, and retrying is what makes
      // the final state correct instead of one writer's update vanishing.
    } catch (err) {
      throw new StorageUnavailableError(`Failed to write "${key}".`, { cause: err });
    }
  }

  throw new StorageConflictError(`Exceeded ${maxRetries} retries writing "${key}" — too much sustained write contention on this key.`);
}
