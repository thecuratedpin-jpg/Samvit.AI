import {accountStore} from '../lib/storage/accounts.js';
// ==========================================================================
// SAMVIT — /api/memory
// --------------------------------------------------------------------------
//   GET    /api/memory?category=&query=&archived=       list (filtered)
//   POST   /api/memory        { category, content, tags, pinned }   create
//   PUT    /api/memory        { id, ...fields }                     update
//   DELETE /api/memory?id=X                                          delete
//   DELETE /api/memory?all=true                                      purge all
//
// v3 storage rewrite: the v2 prototype stored every memory as one giant
// JSON array under a single blob key ("all") — every single add, edit,
// pin, archive, or delete read AND rewrote the entire list. That's the
// one part of this file conversations.mjs (written after it) already got
// right: one blob per record + a small index. This brings memory.mjs to
// the same pattern, so a single edit can't risk the whole memory store,
// and it can't grow into one ever-larger blob. Existing data is migrated
// automatically and safely (old data is only deleted after the new copy
// is confirmed written) — nobody using this today loses their memories.
//
// Honest scaling note: this still lists+searches every record for a given
// user's store, which is the right tradeoff at the personal/small-group
// scale this app is built for (see README "Known limitations"). The real
// ceiling on "millions of users" isn't this file — it's that Samvit
// currently has ONE shared memory store per deployment (no real per-user
// accounts yet). See ROADMAP.md.
// ==========================================================================
import { getStore } from "@netlify/blobs";
import { requireSession } from "../lib/security.js";
import { normalizeMemory } from "../../shared/models.js";
import { createLogger } from "../lib/logger.js";
import { indexEntryFor, applyFilters, rankMemories } from "../lib/memory-logic.js";
import { prependIndexEntry, upsertIndexEntry, removeIndexEntry } from "../lib/storage/index-list.js";
import { updateRecord } from "../lib/storage/record.js";
import { storageErrorStatus, StorageNotFoundError } from "../lib/storage/errors.js";

const envAdapter = { get: (k) => process.env[k] };
const INDEX_KEY = "index";
const LEGACY_KEY = "all";
const MAX_STORED_MEMORIES = 2000;

function recordKey(id) {
  return `mem:${id}`;
}

async function loadIndex(store) {
  try {
    const data = await store.get(INDEX_KEY, { type: "json" });
    if (Array.isArray(data)) return data;
  } catch {}
  return null; // null (not []) distinguishes "never initialized" from "empty"
}

/** One-time, safe migration from the old single-blob format.
 *
 * v4 Priority 6 note (bootstrap races, deliberately NOT CAS-protected —
 * see brief section 15 "document intentionally non-atomic operations and
 * explain why they are safe"): if two requests somehow both hit this on a
 * truly fresh store at the same instant, both could run the migration and
 * write INDEX_KEY unconditionally. This is intentionally left as a plain
 * write, not CAS, because it's a narrow, one-time, self-correcting race —
 * every record write here is keyed by the SAME deterministic ids (the
 * legacy item's own `id`), so a redundant second migration writes the
 * IDENTICAL data, not conflicting data. Unlike every write this pass DID
 * protect (POST/PUT/DELETE below), there's no scenario here where two
 * concurrent callers compute two DIFFERENT valid results that could race —
 * they'd only ever compute the same one.
 */
async function migrateLegacyIfNeeded(store, log) {
  const legacy = await (async () => {
    try {
      const data = await store.get(LEGACY_KEY, { type: "json" });
      return Array.isArray(data) ? data : null;
    } catch {
      return null;
    }
  })();
  if (!legacy) return null;

  log.info("Migrating memory store from single-blob format", { count: legacy.length });
  const migrated = [];
  for (const item of legacy) {
    const memory = normalizeMemory(item, item.id ? item : null);
    memory.id = item.id || memory.id; // preserve original ids so existing links/urls don't break
    memory.timestamp = item.timestamp || memory.timestamp;
    await store.setJSON(recordKey(memory.id), memory, {onlyIfNew:true});
    migrated.push(indexEntryFor(memory));
  }
  await store.setJSON(INDEX_KEY, migrated, {onlyIfNew:true});
  await store.delete(LEGACY_KEY); // only after the new copy is confirmed written above
  return migrated;
}

/** v4 Priority 6: same accepted-narrow-race reasoning as
 * migrateLegacyIfNeeded() above — seed ids are fixed (`seed-0`/`seed-1`/
 * `seed-2`), so a concurrent double-seed writes identical data, not
 * conflicting data. */
async function seedFreshStore(store) {
  await store.setJSON(INDEX_KEY, [], {onlyIfNew:true});
  return (await store.get(INDEX_KEY,{type:'json'})) || [];
}

async function getIndex(store, log) {
  const existing = await loadIndex(store);
  if (existing) return existing;
  const migrated = await migrateLegacyIfNeeded(store, log);
  if (migrated) return migrated; // had legacy data — now migrated
  return seedFreshStore(store); // brand new store — an empty, conditional initialization
}

export default async (req) => {
  const log = createLogger(envAdapter, "memory");
  const auth = await requireSession(req, envAdapter);
  if (!auth.ok) return json({ error: auth.message }, auth.status);

  const store = accountStore("samvit-memories",auth.accountId);
  const url = new URL(req.url);

  if (req.method === "GET") {
    const index = await getIndex(store, log);
    const category = url.searchParams.get("category");
    const query = (url.searchParams.get("query") || "").toLowerCase().trim();
    const showArchived = url.searchParams.get("archived") === "true";

    const matchingEntries = applyFilters(index, { category, query, showArchived });
    // Fetch full records only for the entries we're actually returning.
    const fullRecords = await Promise.all(
      matchingEntries.map(async (entry) => {
        try {
          return await store.get(recordKey(entry.id), { type: "json" });
        } catch {
          return null;
        }
      })
    );
    const list = rankMemories(fullRecords.filter(Boolean), query);
    return json({ memories: list });
  }

  if (req.method === "POST") {
    let body;
    try {
      body = await req.json();
    } catch {
      return json({ error: "Malformed request body." }, 400);
    }
    if (body.purgeAll) {
      await purgeAll(store);
      return json({ ok: true });
    }
    const index = await getIndex(store, log);
    if (index.length >= MAX_STORED_MEMORIES) {
      return json({ error: `You've reached the ${MAX_STORED_MEMORIES}-memory limit for this store. Archive or delete some memories first.` }, 413);
    }
    let memory;
    try {
      memory = normalizeMemory(body);
    } catch (err) {
      return json({ error: err.message }, 400);
    }
    // The record's own key is a fresh, randomly-generated id (see
    // normalizeMemory's genId()) -- no other writer can ever be targeting
    // the SAME key at the same time, so an unconditional write here is
    // safe as-is (see this file's own Priority 6 security-review note at
    // the bottom for the full "which writes need CAS and which don't"
    // accounting). The INDEX prepend below is the part many concurrent
    // creates genuinely contend on, and IS CAS-protected.
    await store.setJSON(recordKey(memory.id), memory, {onlyIfNew:true});
    try {
      await prependIndexEntry(store, INDEX_KEY, indexEntryFor(memory));
    } catch (err) {
      const status = storageErrorStatus(err);
      if (status) {
        log.error("Failed to index a newly-created memory after real write contention", { error: err.message });
        return json({ error: "Saved, but couldn't update the memory list right now -- it may not appear until you refresh. Please try again if it's missing." }, status);
      }
      throw err;
    }
    return json({ memory }, 201);
  }

  if (req.method === "PUT") {
    let body;
    try {
      body = await req.json();
    } catch {
      return json({ error: "Malformed request body." }, 400);
    }
    if (!body.id) return json({ error: "`id` is required." }, 400);

    let updated;
    try {
      const result = await updateRecord(store, recordKey(body.id), (current) => normalizeMemory({ ...current, ...body }, current));
      updated = result.value;
    } catch (err) {
      if (err instanceof StorageNotFoundError) return json({ error: "Memory not found." }, 404);
      const status = storageErrorStatus(err);
      if (status) return json({ error: "Couldn't save this update right now -- please try again." }, status);
      return json({ error: err.message }, 400); // a genuine normalizeMemory() validation error, not a storage error
    }

    try {
      await upsertIndexEntry(store, INDEX_KEY, indexEntryFor(updated));
    } catch (err) {
      const status = storageErrorStatus(err);
      if (status) {
        log.error("Memory record updated, but its index entry could not be refreshed", { error: err.message });
        return json({ error: "Saved, but the memory list may show stale info until you refresh." }, status);
      }
      throw err;
    }
    return json({ memory: updated });
  }

  if (req.method === "DELETE") {
    if (url.searchParams.get("all") === "true") {
      await purgeAll(store);
      return json({ ok: true });
    }
    const id = url.searchParams.get("id");
    if (!id) return json({ error: "`id` query param is required." }, 400);

    let removed;
    try {
      const result = await removeIndexEntry(store, INDEX_KEY, id);
      removed = result.removed;
    } catch (err) {
      const status = storageErrorStatus(err);
      return json({ error: "Couldn't delete this memory right now -- please try again." }, status || 500);
    }
    if (removed) {
      try {
        await store.delete(recordKey(id));
      } catch {}
    }
    return json({ ok: true, deleted: removed });
  }

  return json({ error: "Method not allowed" }, 405);
};

async function purgeAll(store) {
  const index = await loadIndex(store);
  if (index) {
    await Promise.all(index.map((entry) => store.delete(recordKey(entry.id)).catch(() => {})));
  }
  try {
    await store.delete(LEGACY_KEY);
  } catch {}
  await store.setJSON(INDEX_KEY, []);
}

// --------------------------------------------------------------------------
// v4 Priority 6 security review — intentionally non-atomic operations left
// as-is in this file, and why each is safe (brief section 15):
//
// 1. migrateLegacyIfNeeded() / seedFreshStore() — see their own comments.
//    Deterministic, idempotent ids make a redundant concurrent run write
//    identical (not conflicting) data.
// 2. purgeAll() — plain deletes + an unconditional index reset. A create
//    racing a concurrent purge is a genuine intent conflict (the user
//    asked to both add and erase everything at nearly the same instant),
//    not a technical corruption risk: the record either survives (if its
//    write lands after the purge's index reset) or doesn't (if before) —
//    both are defensible outcomes for a request that overlapped a "delete
//    everything," and neither can corrupt an UNRELATED record, which is
//    the actual property this pass protects. Not CAS-protected because
//    there's no well-defined "correct" merge of "add X" with "delete
//    everything" to converge toward, unlike a normal update/update or
//    update/delete race, which DO have one obvious correct outcome (see
//    storage/record.js's own header for the update-vs-delete case, which
//    a purge is just an N-way version of).
// 3. Record write on POST — unconditional `setJSON`, not CAS. Safe because
//    the key is a freshly generated id (normalizeMemory's genId()); no
//    other request can ever be targeting the SAME key at the same moment,
//    so there is nothing for a conditional write to protect against here.
//    Every operation that CAN have two callers target the same key
//    (the index; any UPDATE/DELETE of an existing record) IS CAS-protected
//    via updateRecord()/prependIndexEntry()/upsertIndexEntry()/
//    removeIndexEntry() above.
// 4. Record write and index write, together, are NOT one atomic
//    transaction — Blobs has no cross-key transactions, and this pass
//    doesn't invent a fake one. A crash between the two leaves the index
//    momentarily describing a slightly stale summary of a record that DID
//    save correctly (e.g. an old `pinned` value shown in a list, correct
//    content once opened) — never a lost record, never a resurrected
//    deleted one, never a corrupted OTHER record. The index is a derived,
//    self-healing read cache (every subsequent successful write to the
//    same id fully overwrites its entry); the record blob is the source
//    of truth.
// --------------------------------------------------------------------------

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
}

export const config = { path: "/api/memory" };
