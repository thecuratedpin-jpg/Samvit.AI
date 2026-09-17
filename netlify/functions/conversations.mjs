import {accountStore} from '../lib/storage/accounts.js';
// ==========================================================================
// SAMVIT — /api/conversations
// --------------------------------------------------------------------------
// Persisted chat history. The original prototype's "Recent Chats" list was
// static markup with fake titles — nothing was actually saved. This stores
// real conversation threads (messages + which provider/model answered).
//
//   GET    /api/conversations           list summaries
//   GET    /api/conversations?id=X      full thread
//   POST   /api/conversations           create/save { title, messages, provider, model }
//   PUT    /api/conversations           update { id, messages, title }
//   DELETE /api/conversations?id=X       delete
// ==========================================================================
import { getStore } from "@netlify/blobs";
import { requireSession } from "../lib/security.js";
import { prependIndexEntry, upsertIndexEntry, removeIndexEntry } from "../lib/storage/index-list.js";
import { updateRecord } from "../lib/storage/record.js";
import { storageErrorStatus, StorageNotFoundError } from "../lib/storage/errors.js";

const envAdapter = { get: (k) => process.env[k] };
const INDEX_KEY = "index";
const MAX_STORED = 200;

async function loadIndex(store) {
  try {
    const data = await store.get(INDEX_KEY, { type: "json" });
    if (Array.isArray(data)) return data;
  } catch {}
  return [];
}

function validMessages(messages) {
  return Array.isArray(messages) && messages.length <= 200 && messages.every(m=>m && ['user','assistant'].includes(m.role) && typeof m.content==='string' && m.content.length<=100000) && JSON.stringify(messages).length<=1000000;
}

export default async (req) => {
  const auth = await requireSession(req, envAdapter);
  if (!auth.ok) return json({ error: auth.message }, auth.status);

  const store = accountStore("samvit-conversations",auth.accountId);
  const url = new URL(req.url);
  const id = url.searchParams.get("id");

  if (req.method === "GET") {
    if (id) {
      try {
        const convo = await store.get(`convo:${id}`, { type: "json" });
        if (!convo) return json({ error: "Not found." }, 404);
        return json({ conversation: convo });
      } catch {
        return json({ error: "Not found." }, 404);
      }
    }
    const index = await loadIndex(store);
    index.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
    return json({ conversations: index });
  }

  if (req.method === "POST") {
    let body;
    try {
      body = await req.json();
    } catch {
      return json({ error: "Malformed request body." }, 400);
    }
    if (!validMessages(body?.messages)) return json({ error: "`messages` array is required." }, 400);
    if (body.title !== undefined && typeof body.title !== "string") return json({error:"Title must be text."},400);
    const newId = `convo-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const now = new Date().toISOString();
    const convo = {
      id: newId,
      title: (body.title || body.messages[0]?.content || "Untitled conversation").slice(0, 80),
      provider: body.provider || "claude",
      model: body.model || null,
      messages: body.messages,
      createdAt: now,
      updatedAt: now,
    };
    // Unconditional record write is safe: `newId` embeds Date.now() plus
    // random bytes, so no concurrent writer targets the same key (same
    // reasoning as memory.mjs's Priority 6 security-review note). The
    // index prepend below (with its MAX_STORED cap, now applied INSIDE
    // the same CAS-protected update -- see prependIndexEntry()'s options)
    // is what concurrent creates actually contend on.
    await store.setJSON(`convo:${newId}`, convo);
    try {
      await prependIndexEntry(store, INDEX_KEY, { id: newId, title: convo.title, provider: convo.provider, model: convo.model, updatedAt: now }, { maxLength: MAX_STORED });
    } catch (err) {
      const status = storageErrorStatus(err);
      if (status) return json({ error: "Saved, but couldn't update the conversation list right now -- it may not appear until you refresh." }, status);
      throw err;
    }
    return json({ conversation: convo }, 201);
  }

  if (req.method === "PUT") {
    let body;
    try {
      body = await req.json();
    } catch {
      return json({ error: "Malformed request body." }, 400);
    }
    if (body.messages !== undefined && !validMessages(body.messages)) return json({error:"Invalid or oversized conversation."},400);
    if (body.title !== undefined && typeof body.title !== "string") return json({error:"Title must be text."},400);
    if (!body.id) return json({ error: "`id` is required." }, 400);

    let updated;
    try {
      const result = await updateRecord(store, `convo:${body.id}`, (current) => ({
        ...current,
        messages: body.messages || current.messages,
        title: body.title || current.title,
        updatedAt: new Date().toISOString(),
      }));
      updated = result.value;
    } catch (err) {
      if (err instanceof StorageNotFoundError) return json({ error: "Not found." }, 404);
      const status = storageErrorStatus(err);
      if (status) return json({ error: "Couldn't save this update right now -- please try again." }, status);
      throw err;
    }

    try {
      await upsertIndexEntry(store, INDEX_KEY, { id: updated.id, title: updated.title, provider: updated.provider, model: updated.model, updatedAt: updated.updatedAt });
    } catch (err) {
      const status = storageErrorStatus(err);
      if (status) return json({ error: "Saved, but the conversation list may show stale info until you refresh." }, status);
      throw err;
    }
    return json({ conversation: updated });
  }

  if (req.method === "DELETE") {
    if (!id) return json({ error: "`id` query param is required." }, 400);

    let removed;
    try {
      const result = await removeIndexEntry(store, INDEX_KEY, id);
      removed = result.removed;
    } catch (err) {
      const status = storageErrorStatus(err);
      return json({ error: "Couldn't delete this conversation right now -- please try again." }, status || 500);
    }
    if (removed) {
      try {
        await store.delete(`convo:${id}`);
      } catch {}
    }
    return json({ ok: true });
  }

  return json({ error: "Method not allowed" }, 405);
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
}

export const config = { path: "/api/conversations" };
