// ==========================================================================
// SAMVIT — safe index-list operations (v4 Priority 6)
// --------------------------------------------------------------------------
// memory.mjs, projects.mjs, missions.mjs, and conversations.mjs all use the
// same "one blob per record + a small index array listing them" pattern
// (see e.g. memory.mjs's own header comment on why), and every one of them
// independently hand-wrote the SAME unsafe index update:
//
//   const index = await getIndex(store);
//   index.unshift(newEntry);            // or splice/filter/findIndex+assign
//   await store.setJSON(INDEX_KEY, index);
//
// Two concurrent creates (or a create racing a delete, or two edits to
// different records) can both read the same index, both compute a
// DIFFERENT next array from it, and the second write silently discards the
// first — the record's OWN blob was written safely (each record has a
// unique key, so THAT part never collided), but it becomes invisible: not
// listed, not findable, effectively orphaned. This is section 12's
// "Concurrent memory creation ... no lost records" scenario, and it was a
// real, reachable bug before this pass.
//
// These three functions are the ONE place that index-mutation logic lives
// now, built on casUpdate() (concurrency.js) — every endpoint that has an
// index calls one of these instead of hand-rolling its own read-modify-
// write, so a future new endpoint using this same pattern gets the safe
// behavior by default instead of having to remember to reinvent it.
// ==========================================================================
import { casUpdate } from "./concurrency.js";

/** Prepends `entry` to the array at `indexKey` (creating it if it doesn't
 * exist yet). Returns the updated array.
 * @param {{maxLength?: number}} [options]  If given, the array is
 *   truncated to this length after prepending (evicting the oldest
 *   entries) -- e.g. conversations.mjs's MAX_STORED cap. Truncation
 *   happens INSIDE the same CAS-protected update, so it can't itself
 *   race with a concurrent prepend/removal the way a separate
 *   read-truncate-write step could. */
export async function prependIndexEntry(store, indexKey, entry, { maxLength } = {}) {
  const { value } = await casUpdate(store, indexKey, (current) => {
    const list = Array.isArray(current) ? current : [];
    const next = [entry, ...list];
    return typeof maxLength === "number" ? next.slice(0, maxLength) : next;
  });
  return value;
}

/** Replaces the entry matching `getId(existingEntry) === getId(entry)`
 * with `entry`; if no match is found, prepends it (upsert — covers both
 * "update an existing index entry" and "this record's index entry
 * doesn't exist for some reason, add it" without a separate code path).
 * Returns the updated array. */
export async function upsertIndexEntry(store, indexKey, entry, getId = (e) => e.id) {
  const { value } = await casUpdate(store, indexKey, (current) => {
    const list = Array.isArray(current) ? current : [];
    const idx = list.findIndex((e) => getId(e) === getId(entry));
    if (idx === -1) return [entry, ...list];
    const next = list.slice();
    next[idx] = entry;
    return next;
  });
  return value;
}

/** Removes the entry with the given `id` (via `getId(entry) === id`).
 * Returns `{ value, removed }` — `removed` is `false` if nothing matched
 * (so a caller can tell "already gone" apart from "just removed", e.g. to
 * decide whether to also delete the record's own blob). Safe to call even
 * if the index doesn't exist yet (treated as empty; `removed` is `false`). */
export async function removeIndexEntry(store, indexKey, id, getId = (e) => e.id) {
  let removed = false;
  const { value } = await casUpdate(store, indexKey, (current) => {
    const list = Array.isArray(current) ? current : [];
    const next = list.filter((e) => getId(e) !== id);
    removed = next.length !== list.length; // recomputed fresh on every retry -- reflects the attempt that actually wins the CAS write, not a stale first guess
    return next;
  });
  return { value, removed };
}
