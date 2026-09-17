// ==========================================================================
// SAMVIT V14 — PROACTIVE MONITOR STORE (P14, store-backed half)
// --------------------------------------------------------------------------
// Opt-in management + signal intake for folder watches. Every rule lives in
// shared/proactive.js (pure); this file persists the results and writes the
// audit trail. Signals land in a capped per-account inbox — advisory only.
// They never trigger missions, models, or computer actions by themselves.
import {casUpdate} from '../storage/concurrency.js';
import {accountStore} from '../storage/accounts.js';
import {validateMonitor, activeMonitors, signalAllowed, validateSignal, SIGNAL_INBOX_CAP} from '../../../shared/proactive.js';
import {getDevice, DEVICE_STORE} from './registry.js';
import {recordAction} from '../intelligence/permissions.js';

/** Enable (or replace the watch for the same path) a monitor on a device. */
export async function enableMonitor(accountId, deviceId, {kind, path}) {
  const device = await getDevice(accountId, deviceId);
  if (!device) throw Error('Computer not found');
  const monitor = validateMonitor({device, kind, path});
  await casUpdate(accountStore(DEVICE_STORE, accountId), 'device:' + deviceId, current => {
    const watches = (current?.monitors || []).filter(m => !(m.path === monitor.path && m.kind === monitor.kind));
    return {...current, monitors: [...watches, monitor], updatedAt: Date.now()};
  });
  await recordAction(accountId, {action: `proactive enable ${monitor.kind}`, outcome: 'ALLOW', reason: 'user_opt_in', deviceId});
  return monitor;
}

/** Cancel a monitor. Cancellable means one click and it is truly off. */
export async function disableMonitor(accountId, deviceId, monitorId) {
  const result = await casUpdate(accountStore(DEVICE_STORE, accountId), 'device:' + deviceId, current => {
    if (!current) return current;
    return {...current, monitors: (current.monitors || []).map(m => m.id === monitorId ? {...m, enabled: false, disabledAt: Date.now()} : m), updatedAt: Date.now()};
  });
  await recordAction(accountId, {action: 'proactive disable', outcome: 'ALLOW', reason: 'user_cancelled', deviceId});
  return (result.value?.monitors || []).find(m => m.id === monitorId) || null;
}

/** What the agent is currently expected to watch (active only, expiry applied). */
export async function monitorsForDevice(accountId, deviceId, {now = Date.now()} = {}) {
  const device = await getDevice(accountId, deviceId);
  return activeMonitors(device, {now});
}

/**
 * Record one signal from the device agent. Rate-limited per device;
 * everything is appended to the capped inbox AND the audit log.
 */
export async function recordSignal(accountId, deviceId, payload, {now = Date.now()} = {}) {
  const device = await getDevice(accountId, deviceId);
  if (!device || device.revoked) throw Error('That computer is not connected');
  const monitor = activeMonitors(device, {now}).find(m => m.id === payload?.monitorId);
  const gate = signalAllowed(device.signalHistory, {now});
  if (!gate.allowed) return {recorded: false, reason: 'rate_limited'};
  const signal = validateSignal({monitor, payload});
  await casUpdate(accountStore(DEVICE_STORE, accountId), 'device:' + deviceId, current => ({
    ...current,
    signalHistory: [...gate.recent, now].slice(-50),
    updatedAt: Date.now()
  }));
  await casUpdate(accountStore(DEVICE_STORE, accountId), 'signals', current => {
    const rows = Array.isArray(current?.rows) ? current.rows : [];
    return {rows: [...rows, {...signal, deviceId, deviceName: device.name}].slice(-SIGNAL_INBOX_CAP)};
  });
  await recordAction(accountId, {action: `proactive signal ${monitor.kind}`, outcome: 'ALLOW', reason: signal.event, deviceId});
  return {recorded: true, signal};
}

export async function readSignals(accountId) {
  const record = await accountStore(DEVICE_STORE, accountId).get('signals', {type: 'json', consistency: 'strong'});
  return Array.isArray(record?.rows) ? record.rows : [];
}
