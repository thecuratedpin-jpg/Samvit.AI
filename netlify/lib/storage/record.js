// ==========================================================================
// SAMVIT — safe single-record update (v4 Priority 6)
// --------------------------------------------------------------------------
// The record-level counterpart to index-list.js: memory.mjs/projects.mjs/
// missions.mjs/conversations.mjs all also read-modify-write the RECORD
// itself on every PUT (`{...existing, ...body}`), with no protection
// against two concurrent edits to the SAME record — the second write wins,
// the first edit vanishes, and unlike the index (a cache of summaries),
// this can lose real user data (a mission's step progress, a memory's
// content, a conversation's messages).
//
// updateRecord() ALSO gives a real, correct answer to brief section 9's
// "update vs delete" race, using only primitives Netlify Blobs actually
// has (no CAS-protected delete exists — see blobs.js's safeDelete() for
// why "delete always wins" is the documented behavior on the delete
// side): if a record is deleted between this function's read and its
// conditional write, the write's `onlyIfMatch` has nothing left to match
// (the key no longer exists), so it's rejected as a lost race exactly
// like any other conflict — the retry loop reloads, finds the key
// genuinely gone, and this throws StorageNotFoundError instead of
// silently resurrecting stale data on top of a deletion that already
// happened. No tombstone or extra bookkeeping needed for this direction;
// the existing CAS mechanism already produces the right outcome.
// ==========================================================================
import { casUpdate } from "./concurrency.js";
import { StorageNotFoundError } from "./errors.js";

/**
 * Safely updates an EXISTING record. `updateFn(current)` receives the
 * real current record (never `null` — see below) and returns the record
 * to write. If the record doesn't exist (including "existed when the
 * caller first checked, but was deleted by a concurrent request before
 * this write landed"), throws StorageNotFoundError instead of retrying —
 * a genuinely absent key won't start existing by retrying, and this is
 * exactly the safe outcome for the delete-vs-update race described above.
 *
 * @param {object} store
 * @param {string} key
 * @param {(current: any) => any|Promise<any>} updateFn
 * @returns {Promise<{value: any, attempts: number}>}
 * @throws {StorageNotFoundError}
 */
export async function updateRecord(store, key, updateFn) {
  return casUpdate(store, key, async (current) => {
    if (current === null) throw new StorageNotFoundError(`No record at "${key}".`);
    return updateFn(current);
  });
}
