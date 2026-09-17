// ==========================================================================
// SAMVIT V12 — DURABLE ACTION RECEIPTS (P3)
// --------------------------------------------------------------------------
// THE PROBLEM THIS SOLVES: the agent performs a state-changing operation, then
// crashes before reporting it. The cloud's lease expires, the action becomes
// claimable again, and it is delivered a second time — so the operation runs
// twice. For `fs.write` that is merely wasteful; for `dev.run` it could run a
// deployment twice, and for `fs.delete` it could delete something that was
// recreated in between.
//
// THE FIX: before executing, the agent checks a durable local receipt for that
// action id. If the action already completed, the agent REPLAYS the recorded
// observation and report instead of performing the operation again. The cloud
// still sees a normal completion, so its verification and audit are unchanged.
//
// Only SUCCESSFUL state-changing actions are recorded. A failed action leaves
// no receipt, so a genuine retry still happens — idempotency must not turn a
// transient failure into a permanent one.
// ==========================================================================
import {readFileSync, writeFileSync, mkdirSync} from 'node:fs';
import {dirname} from 'node:path';

export const RECEIPT_LIMIT = 500;

// Read-only capabilities change nothing, so replaying them is harmless and
// recording them would only evict useful receipts.
const READ_ONLY = new Set(['fs.list', 'fs.stat', 'fs.read', 'fs.search', 'env.inspect']);

export const shouldRecord = capability => !READ_ONLY.has(capability);

/**
 * A bounded, crash-safe receipt log on the agent's own disk.
 * Deliberately simple: a single JSON document, newest-wins on eviction.
 */
export function createReceiptStore(path) {
  let cache = null;

  const load = () => {
    if (cache) return cache;
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8'));
      cache = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      cache = {}; // missing or unreadable: start clean rather than fail the agent
    }
    return cache;
  };

  const save = () => {
    try {
      mkdirSync(dirname(path), {recursive: true, mode: 0o700});
      writeFileSync(path, JSON.stringify(cache), {mode: 0o600});
    } catch { /* a receipt write failure must not stop the agent working */ }
  };

  return {
    get(actionId) {
      if (typeof actionId !== 'string' || !actionId) return null;
      return load()[actionId] || null;
    },
    put(actionId, record) {
      if (typeof actionId !== 'string' || !actionId) return;
      const all = load();
      all[actionId] = {...record, recordedAt: Date.now()};
      const keys = Object.keys(all);
      if (keys.length > RECEIPT_LIMIT) {
        keys.sort((a, b) => (all[a].recordedAt || 0) - (all[b].recordedAt || 0));
        for (const key of keys.slice(0, keys.length - RECEIPT_LIMIT)) delete all[key];
      }
      save();
    },
    size() { return Object.keys(load()).length; }
  };
}
