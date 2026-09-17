// ==========================================================================
// SAMVIT V12 — DEVICE ACTION QUEUE (Phases 5 + 7)
// --------------------------------------------------------------------------
// The only path by which work reaches a paired computer.
//
// Flow: cloud enqueues a validated, policy-approved action → the agent polls
// and claims it under a lease → the agent executes and reports a real
// observation → the cloud verifies the observation against what the action
// promised.
//
// Leases make this crash-safe: if an agent dies mid-action the lease expires
// and the action becomes claimable again, rather than being stuck forever or
// (worse) being executed twice concurrently.
// ==========================================================================
import {accountStore} from '../storage/accounts.js';
import {casUpdate} from '../storage/concurrency.js';
import {verifyObservation} from '../../../shared/desktop.js';

export const DEVICE_STORE = 'samvit-devices';
export const MAX_ACTIONS = 100;
export const DEFAULT_LEASE_MS = 60000;
export const MAX_ATTEMPTS = 3;

const terminal = status => ['completed', 'failed', 'denied', 'expired'].includes(status);

const readRows = async accountId => {
  const record = await accountStore(DEVICE_STORE, accountId).get('actions', {type: 'json', consistency: 'strong'});
  return Array.isArray(record?.rows) ? record.rows : [];
};

export async function enqueueAction(accountId, {deviceId, capability, args, expected = null, decision = null, missionId = null}) {
  const record = {
    id: crypto.randomUUID(),
    deviceId,
    capability,
    args,
    expected,
    decision,
    missionId,
    status: 'pending',
    attempts: 0,
    createdAt: Date.now(),
    dispatchedAt: null,
    leaseExpiresAt: null,
    completedAt: null,
    observation: null,
    verification: null,
    error: null
  };
  await casUpdate(accountStore(DEVICE_STORE, accountId), 'actions', current => ({
    rows: [...(current?.rows || []), record].slice(-MAX_ACTIONS)
  }));
  return record;
}

/**
 * Claim up to `limit` actions for a device. A pending action, or a dispatched
 * action whose lease has expired, is claimable. Returns exactly the actions
 * claimed by THIS call.
 */
export async function claimActions(accountId, deviceId, {limit = 5, leaseMs = DEFAULT_LEASE_MS, now = Date.now()} = {}) {
  let claimed = [];
  await casUpdate(accountStore(DEVICE_STORE, accountId), 'actions', current => {
    const rows = current?.rows || [];
    claimed = [];
    return {
      rows: rows.map(row => {
        if (claimed.length >= limit || row.deviceId !== deviceId) return row;
        const leaseExpired = row.status === 'dispatched' && (!row.leaseExpiresAt || row.leaseExpiresAt <= now);
        if (row.status !== 'pending' && !leaseExpired) return row;
        // Stop retrying an action that keeps failing to be reported on.
        if ((row.attempts || 0) >= MAX_ATTEMPTS) {
          const expired = {...row, status: 'expired', completedAt: now, error: 'The computer did not report back on this action'};
          claimed.push(expired);
          return expired;
        }
        const updated = {...row, status: 'dispatched', dispatchedAt: now, leaseExpiresAt: now + leaseMs, attempts: (row.attempts || 0) + 1};
        claimed.push(updated);
        return updated;
      })
    };
  });
  return claimed;
}

/** Record the agent's real observation and verify it against the expectation. */
export async function completeAction(accountId, deviceId, actionId, {observation = null, report = null, error = null, now = Date.now()} = {}) {
  let result = null;
  await casUpdate(accountStore(DEVICE_STORE, accountId), 'actions', current => {
    const rows = current?.rows || [];
    result = null;
    const next = rows.map(row => {
      if (row.id !== actionId || row.deviceId !== deviceId) return row;
      // Idempotent: a retried report must not overwrite the first outcome.
      if (terminal(row.status)) {
        result = row;
        return row;
      }
      const verification = error
        ? {status: 'unresolved', reason: 'action_failed', detail: String(error).slice(0, 300)}
        : verifyObservation(row.expected, observation);
      const updated = {
        ...row,
        status: error ? 'failed' : 'completed',
        completedAt: now,
        leaseExpiresAt: null,
        observation: observation || null,
        // The report is what the model actually needs (file contents, command
        // output). Bounded here so one action cannot bloat the job record.
        report: report ? JSON.parse(JSON.stringify(report).slice(0, 24000)) : null,
        error: error ? String(error).slice(0, 300) : null,
        verification
      };
      result = updated;
      return updated;
    });
    if (!result) throw Error('That action is not queued for this computer');
    return {rows: next};
  });
  return result;
}

/** Record a decision the user made about an action that was ASK_USER. */
export async function markActionDecision(accountId, actionId, {approved, now = Date.now()} = {}) {
  let result = null;
  await casUpdate(accountStore(DEVICE_STORE, accountId), 'actions', current => {
    const rows = current?.rows || [];
    result = null;
    const next = rows.map(row => {
      if (row.id !== actionId) return row;
      if (terminal(row.status)) {result = row; return row;}
      const updated = approved
        ? {...row, status: 'pending', decision: {...(row.decision || {}), approvedAt: now, approved: true}}
        : {...row, status: 'denied', completedAt: now, decision: {...(row.decision || {}), approvedAt: now, approved: false}, error: 'You declined this action'};
      result = updated;
      return updated;
    });
    if (!result) throw Error('Action not found');
    return {rows: next};
  });
  return result;
}

export async function readActions(accountId) {
  return readRows(accountId);
}

export async function readAction(accountId, actionId) {
  return (await readRows(accountId)).find(row => row.id === actionId) || null;
}

export async function listActions(accountId, {deviceId = null, limit = 20} = {}) {
  const rows = await readRows(accountId);
  return rows.filter(row => !deviceId || row.deviceId === deviceId).slice(-limit).reverse();
}

/** Actions still outstanding for a device — used by the UI and by missions. */
export async function pendingActions(accountId, deviceId = null) {
  return (await readRows(accountId)).filter(row => !terminal(row.status) && (!deviceId || row.deviceId === deviceId));
}
