// ==========================================================================
// SAMVIT V14 — PROACTIVE SIGNAL MONITORS (P14, opt-in foundation)
// --------------------------------------------------------------------------
// The one proactive capability in V14: a paired computer can WATCH a folder
// the user explicitly authorised, and tell the account when files under it
// change. That signal is advisory — it lands in the account's Signals inbox
// and audit log. It does NOT start missions, call models, or act on the
// computer. Proactive work is opt-in, scope-limited, capped, rate-limited,
// expiring and cancellable; this module is the pure half of those rules.
// ==========================================================================
import {checkScopeAccess, canonicalPath} from './desktop.js';

export const MONITOR_KINDS = Object.freeze(['watch.folder']);
export const MAX_MONITORS_PER_DEVICE = 3;
export const MONITOR_TTL_MS = 30 * 24 * 60 * 60 * 1000; // watches expire; renew is a fresh act of consent
export const MAX_SIGNALS_PER_DAY = 20;                    // per device, rolling day
export const DEBOUNCE_MS = 5000;
export const SIGNAL_INBOX_CAP = 25;

/**
 * Validate a proposed monitor against the paired computer's unauthorised-everything
 * default. Returns the normalised monitor or throws with a user-readable reason.
 * `now` lets tests pin time.
 */
export function validateMonitor({device, kind, path, now = Date.now()}) {
  if (!device || device.revoked) throw Error('That computer is not connected');
  if (!MONITOR_KINDS.includes(kind)) throw Error(`Unknown monitor kind "${kind}". Proactive watches are limited to folder-change signals.`);
  const watches = Array.isArray(device.monitors) ? device.monitors : [];
  const active = watches.filter(m => m.enabled !== false && (m.expiresAt || 0) > now);
  if (active.length >= MAX_MONITORS_PER_DEVICE && !active.some(m => m.path === canonicalPath(path))) {
    throw Error(`This computer already has ${MAX_MONITORS_PER_DEVICE} active watches. Remove one first.`);
  }
  // The watch must sit INSIDE an authorised (read) scope — a proactive eye
  // over an unauthorised folder would be surveillance, not assistance.
  const access = checkScopeAccess(device.scopes || [], path, 'read');
  if (!access.allowed) {
    throw Error('Proactive watches can only cover folders you have authorised for this computer. Authorise the folder first.');
  }
  return {
    id: crypto.randomUUID(),
    kind,
    path: canonicalPath(path),
    enabled: true,
    createdAt: now,
    expiresAt: now + MONITOR_TTL_MS,
    notifiedUntil: 0
  };
}

/** Remove-disabled + expiry-filtered live view of a device's monitors. */
export function activeMonitors(device, {now = Date.now()} = {}) {
  return (Array.isArray(device?.monitors) ? device.monitors : []).filter(m => m.enabled !== false && (m.expiresAt || 0) > now);
}

/**
 * Rate-limit gate for a signal. Pure: the caller supplies this device's
 * recent signal timestamps (the caller persists them).
 */
export function signalAllowed(recentTimestamps, {now = Date.now()} = {}) {
  const dayAgo = now - 86400000;
  const recent = (Array.isArray(recentTimestamps) ? recentTimestamps : []).filter(at => at > dayAgo);
  if (recent.length >= MAX_SIGNALS_PER_DAY) return {allowed: false, recent};
  return {allowed: true, recent};
}

/** Validate one incoming signal event from an agent. Pure shape checks only. */
export function validateSignal({monitor, payload}) {
  if (!monitor) throw Error('No active watch matches this signal');
  const path = typeof payload?.path === 'string' ? payload.path.slice(0, 32767) : null;
  if (!path) throw Error('A signal needs the changed path');
  const event = ['created', 'changed', 'removed'].includes(payload?.event) ? payload.event : 'changed';
  return {monitorId: monitor.id, kind: monitor.kind, path, event, summary: `Files changed in ${monitor.path}`.slice(0, 200), at: Date.now()};
}
