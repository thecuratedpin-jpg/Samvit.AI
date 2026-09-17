import {accountStore} from '../lib/storage/accounts.js';
// ==========================================================================
// SAMVIT — /api/missions
// --------------------------------------------------------------------------
//   GET    /api/missions             list
//   POST   /api/missions             { title, goal, steps, provider, ... }  create
//   PUT    /api/missions             { id, ...fields }                     update
//   DELETE /api/missions?id=X                                              delete
//
// This is the real, honestly-scoped version of Execution Engine "pause /
// resume / retry": missions and their step-by-step progress are actually
// persisted, so closing the tab or switching devices doesn't lose your
// place. What this is NOT: a background worker/scheduler that keeps
// executing your mission while you're gone. Netlify Functions are
// request-scoped and don't run persistent background processes, so
// autonomous unattended execution isn't something this file can honestly
// claim — the frontend drives each step (calling /api/chat or /api/workflow
// per step) while a tab is open, and this endpoint is what makes that
// resumable. See ROADMAP.md ("Real autonomous background execution") for
// what a true always-on worker system would require.
// ==========================================================================
import { getStore } from "@netlify/blobs";
import { requireSession } from "../lib/security.js";
import { normalizeMission } from "../../shared/models.js";
import { prependIndexEntry, upsertIndexEntry, removeIndexEntry } from "../lib/storage/index-list.js";
import { updateRecord } from "../lib/storage/record.js";
import { storageErrorStatus, StorageNotFoundError } from "../lib/storage/errors.js";

const envAdapter = { get: (k) => process.env[k] };
const INDEX_KEY = "index";
const MAX_MISSIONS = 500;

function recordKey(id) {
  return `mission:${id}`;
}

async function getIndex(store) {
  try {
    const data = await store.get(INDEX_KEY, { type: "json" });
    if (Array.isArray(data)) return data;
  } catch {}
  return [];
}

function indexEntryFor(mission) {
  const { id, title, status, provider, currentStepIndex, createdAt, updatedAt } = mission;
  return { id, title, status, provider, currentStepIndex, stepCount: mission.steps.length, createdAt, updatedAt };
}

export default async (req) => {
  const auth = await requireSession(req, envAdapter);
  if (!auth.ok) return json({ error: auth.message }, auth.status);

  const store = accountStore("samvit-missions",auth.accountId);
  const url = new URL(req.url);

  if (req.method === "GET") {
    const id = url.searchParams.get("id");
    if (id) {
      let mission;
      try {
        mission = await store.get(recordKey(id), { type: "json" });
      } catch {}
      if (!mission) return json({ error: "Mission not found." }, 404);
      return json({ mission });
    }
    const index = await getIndex(store);
    return json({ missions: index.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt)) });
  }

  if (req.method === "POST") {
    let body;
    try {
      body = await req.json();
    } catch {
      return json({ error: "Malformed request body." }, 400);
    }
    const index = await getIndex(store);
    if (index.length >= MAX_MISSIONS) {
      return json({ error: `You've reached the ${MAX_MISSIONS}-mission limit. Delete some old missions first.` }, 413);
    }
    let mission;
    try {
      mission = normalizeMission(body);
    } catch (err) {
      return json({ error: err.message }, 400);
    }
    // Unconditional record write is safe: `mission.id` is freshly
    // generated, so no concurrent writer targets the same key (see
    // memory.mjs's Priority 6 security-review note for the full
    // reasoning). The index prepend is what concurrent creates contend on.
    await store.setJSON(recordKey(mission.id), mission);
    try {
      await prependIndexEntry(store, INDEX_KEY, indexEntryFor(mission));
    } catch (err) {
      const status = storageErrorStatus(err);
      if (status) return json({ error: "Saved, but couldn't update the mission list right now -- it may not appear until you refresh." }, status);
      throw err;
    }
    return json({ mission }, 201);
  }

  if (req.method === "PUT") {
    let body;
    try {
      body = await req.json();
    } catch {
      return json({ error: "Malformed request body." }, 400);
    }
    if (!body.id) return json({ error: "`id` is required." }, 400);

    // Missions are updated far more often than projects/memories --
    // roughly once per executed step (see this file's own header on
    // "pause/resume") -- making this the endpoint most likely to see two
    // real, close-together writes to the SAME mission (a user driving
    // execution from two open tabs, or a retried request racing the
    // original). updateRecord()'s CAS protection is what keeps step N's
    // progress from silently overwriting step N+1's if they land out of
    // order, and recomputes `normalizeMission({...current, ...body},
    // current)` fresh on every retry against the LATEST state, not a
    // stale snapshot taken before the loop started.
    let updated;
    try {
      const result = await updateRecord(store, recordKey(body.id), (current) => normalizeMission({ ...current, ...body }, current));
      updated = result.value;
    } catch (err) {
      if (err instanceof StorageNotFoundError) return json({ error: "Mission not found." }, 404);
      const status = storageErrorStatus(err);
      if (status) return json({ error: "Couldn't save this update right now -- please try again." }, status);
      return json({ error: err.message }, 400); // a genuine normalizeMission() validation error
    }

    try {
      await upsertIndexEntry(store, INDEX_KEY, indexEntryFor(updated));
    } catch (err) {
      const status = storageErrorStatus(err);
      if (status) return json({ error: "Saved, but the mission list may show stale info until you refresh." }, status);
      throw err;
    }
    return json({ mission: updated });
  }

  if (req.method === "DELETE") {
    const id = url.searchParams.get("id");
    if (!id) return json({ error: "`id` query param is required." }, 400);

    let removed;
    try {
      const result = await removeIndexEntry(store, INDEX_KEY, id);
      removed = result.removed;
    } catch (err) {
      const status = storageErrorStatus(err);
      return json({ error: "Couldn't delete this mission right now -- please try again." }, status || 500);
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

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
}

export const config = { path: "/api/missions" };
