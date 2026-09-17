// ==========================================================================
// SAMVIT — safe storage primitives (v4 Priority 6)
// --------------------------------------------------------------------------
// Thin, consistent wrappers around the two Blobs operations every call
// site in this app already does directly (a plain read, a plain delete) —
// giving them the SAME error taxonomy (errors.js) casUpdate() uses, so an
// endpoint can catch one family of errors regardless of which storage
// primitive it called. Re-exports casUpdate so most files only need one
// import line from this directory (`import { safeGet, casUpdate } from
// "../lib/storage/blobs.js"`).
// ==========================================================================
import { StorageUnavailableError } from "./errors.js";
import { casUpdate } from "./concurrency.js";

export { casUpdate };
export * from "./errors.js";

/**
 * Reads and parses a JSON value. Returns `fallback` (default `null`) if
 * the key doesn't exist. Throws StorageUnavailableError if the READ
 * itself fails — deliberately NOT swallowed into `fallback`, because
 * "missing" and "the store is broken" are different situations an
 * endpoint should usually treat differently (a 404 vs. a 503). A caller
 * that specifically wants the older "fail closed to a default" behavior
 * (e.g. subscriptions.js's getSubscription(), which has its own, more
 * nuanced three-way distinction — see that file) should catch this
 * itself rather than relying on safeGet() to make that policy choice for
 * every caller.
 *
 * @param {object} store
 * @param {string} key
 * @param {any} [fallback]
 */
export async function safeGet(store, key, fallback = null) {
  try {
    const value = await store.get(key, { type: "json" });
    return value ?? fallback;
  } catch (err) {
    throw new StorageUnavailableError(`Failed to read "${key}".`, { cause: err });
  }
}

/**
 * Deletes a key. Netlify Blobs' delete() is unconditional (verified
 * against node_modules/@netlify/blobs/dist/main.d.ts — there is no
 * onlyIfMatch/onlyIfNew equivalent for delete, unlike setJSON), so this
 * cannot itself be made a compare-and-swap operation — "delete always
 * wins" over a concurrent update is the documented, deliberate behavior
 * this app uses instead (see each endpoint's own DELETE handler comment,
 * and CHANGES-V4-PRIORITIES.md's Priority 6 writeup for why that's a
 * SAFE choice given the record-update side is what actually prevents
 * corruption — a stale update can't resurrect a deleted record, because
 * its own conditional write fails once the record is gone; see
 * index-list.js). Never throws for "key doesn't exist" (deleting nothing
 * is not an error); throws StorageUnavailableError only if the delete
 * call itself fails.
 *
 * @param {object} store
 * @param {string} key
 */
export async function safeDelete(store, key) {
  try {
    await store.delete(key);
  } catch (err) {
    throw new StorageUnavailableError(`Failed to delete "${key}".`, { cause: err });
  }
}
