import {accountStore} from '../lib/storage/accounts.js';
// ==========================================================================
// SAMVIT — /api/projects
// --------------------------------------------------------------------------
//   GET    /api/projects            list
//   POST   /api/projects            { name, desc, status, icon, color }  create
//   PUT    /api/projects            { id, ...fields }                    update
//   DELETE /api/projects?id=X                                            delete
//
// v3: this is new. The v2 prototype's "Projects" grid rendered a hardcoded
// array (`initialProjects` in app.js) that looked real but wasn't backed by
// anything — unlike the security panel's honestly-labeled example data,
// nothing told the user these three projects weren't theirs. This gives
// Projects a real, persisted backend (same one-blob-per-record + index
// pattern as conversations.mjs and memory.mjs) so creating/renaming/
// archiving a project actually persists.
// ==========================================================================
import { getStore } from "@netlify/blobs";
import { requireSession } from "../lib/security.js";
import { normalizeProject } from "../../shared/models.js";
import { prependIndexEntry, upsertIndexEntry, removeIndexEntry } from "../lib/storage/index-list.js";
import { updateRecord } from "../lib/storage/record.js";
import { storageErrorStatus, StorageNotFoundError } from "../lib/storage/errors.js";

const envAdapter = { get: (k) => process.env[k] };
const INDEX_KEY = "index";
const MAX_PROJECTS = 500;

function recordKey(id) {
  return `proj:${id}`;
}

async function getIndex(store) {
  try {
    const data = await store.get(INDEX_KEY, { type: "json" });
    if (Array.isArray(data)) return data;
  } catch {}
  return [];
}

function indexEntryFor(project) {
  const { id, name, status, icon, color, createdAt, updatedAt } = project;
  return { id, name, status, icon, color, createdAt, updatedAt };
}

export default async (req) => {
  const auth = await requireSession(req, envAdapter);
  if (!auth.ok) return json({ error: auth.message }, auth.status);

  const store = accountStore("samvit-projects",auth.accountId);
  const url = new URL(req.url);

  if (req.method === "GET") {
    const index = await getIndex(store);
    const records = await Promise.all(
      index.map(async (entry) => {
        try {
          return await store.get(recordKey(entry.id), { type: "json" });
        } catch {
          return null;
        }
      })
    );
    const list = records.filter(Boolean).sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
    return json({ projects: list });
  }

  if (req.method === "POST") {
    let body;
    try {
      body = await req.json();
    } catch {
      return json({ error: "Malformed request body." }, 400);
    }
    const index = await getIndex(store);
    if (index.length >= MAX_PROJECTS) {
      return json({ error: `You've reached the ${MAX_PROJECTS}-project limit.` }, 413);
    }
    let project;
    try {
      project = normalizeProject(body);
    } catch (err) {
      return json({ error: err.message }, 400);
    }
    // Record write is unconditional -- safe: `project.id` is a freshly
    // generated id, so no concurrent writer can ever target this same
    // key (see memory.mjs's Priority 6 security-review note for the same
    // reasoning, applying identically here). The index prepend below is
    // the part concurrent creates actually contend on.
    await store.setJSON(recordKey(project.id), project);
    try {
      await prependIndexEntry(store, INDEX_KEY, indexEntryFor(project));
    } catch (err) {
      const status = storageErrorStatus(err);
      if (status) return json({ error: "Saved, but couldn't update the project list right now -- it may not appear until you refresh." }, status);
      throw err;
    }
    return json({ project }, 201);
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
      const result = await updateRecord(store, recordKey(body.id), (current) => normalizeProject({ ...current, ...body }, current));
      updated = result.value;
    } catch (err) {
      if (err instanceof StorageNotFoundError) return json({ error: "Project not found." }, 404);
      const status = storageErrorStatus(err);
      if (status) return json({ error: "Couldn't save this update right now -- please try again." }, status);
      return json({ error: err.message }, 400); // a genuine normalizeProject() validation error
    }

    try {
      await upsertIndexEntry(store, INDEX_KEY, indexEntryFor(updated));
    } catch (err) {
      const status = storageErrorStatus(err);
      if (status) return json({ error: "Saved, but the project list may show stale info until you refresh." }, status);
      throw err;
    }
    return json({ project: updated });
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
      return json({ error: "Couldn't delete this project right now -- please try again." }, status || 500);
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

export const config = { path: "/api/projects" };
