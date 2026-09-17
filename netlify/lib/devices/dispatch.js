// ==========================================================================
// SAMVIT V12 — DEVICE DISPATCH (P0)
// --------------------------------------------------------------------------
// The bridge from a cloud mission tool to a real computer. This is the ONLY
// path a model can take to reach a paired PC, and it reuses the existing
// policy engine and device queue — it does not add a second pipeline.
//
// The full path for one action:
//
//   tool args → validate → resolve device → pairing/revocation check
//   → policy (capability level + scopes + approved commands)
//   → enqueue structured action → agent polls → executes on the PC
//   → real observation + report → verification → back to the model
//
// Two properties worth stating explicitly:
//
//   * It NEVER claims success without a device observation. A timeout is
//     reported as a timeout; a verification mismatch is reported as one.
//   * ASK_USER does not fail the mission. It returns an awaiting_decision
//     result so the mission can pause and resume from its checkpoint.
// ==========================================================================
import {getDevice} from './registry.js';
import {authorizeLocalAction} from './policy.js';
import {enqueueAction, readAction} from './queue.js';
import {expectationFor, DEVICE_CAPABILITIES} from '../../../shared/desktop.js';

export const DEFAULT_WAIT_MS = 45000;
export const DEFAULT_POLL_MS = 1500;
// The agent polls every 3s, so a minute of silence means the computer is gone.
export const STALE_AFTER_MS = 60000;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * What a specific computer can currently do. Read-only, and deliberately
 * limited to what the mission needs — there is no full-machine scan here.
 */
export async function deviceAvailability(accountId, deviceId, {now = Date.now()} = {}) {
  const device = await getDevice(accountId, deviceId);
  if (!device) return {available: false, reason: 'unknown_device', detail: 'No such computer is paired with this workspace'};
  if (device.revoked) return {available: false, reason: 'device_revoked', name: device.name, detail: 'That computer has been disconnected'};
  const lastSeenAt = device.lastSeenAt || null;
  const online = Boolean(lastSeenAt) && now - lastSeenAt <= STALE_AFTER_MS;
  return {
    available: true,
    online,
    stale: Boolean(lastSeenAt) && !online,
    neverConnected: !lastSeenAt,
    id: device.id,
    name: device.name,
    platform: device.platform,
    arch: device.arch,
    lastSeenAt,
    capabilities: DEVICE_CAPABILITIES,
    authorisedFolders: (device.scopes || []).map(scope => ({path: scope.path, mode: scope.mode})),
    approvedCommands: device.approvedCommands || [],
    // Said plainly so the model cannot confuse the two environments.
    environment: 'local_pc'
  };
}

/** Every paired computer, for device selection. */
export async function listAvailableDevices(accountId, {now = Date.now()} = {}) {
  const {listDevices} = await import('./registry.js');
  const devices = await listDevices(accountId);
  return devices.map(device => ({
    id: device.id,
    name: device.name,
    platform: device.platform,
    revoked: device.revoked === true,
    online: Boolean(device.lastSeenAt) && now - device.lastSeenAt <= STALE_AFTER_MS,
    authorisedFolders: (device.scopes || []).length,
    approvedCommands: (device.approvedCommands || []).length
  }));
}

/**
 * Perform one structured action on a paired computer and wait for the real
 * observation.
 *
 * @returns {Promise<{status, actionId, observation?, report?, verification?, error?, detail?, decision?}>}
 *   status: completed | failed | timeout | awaiting_decision | denied | expired
 * @throws on a hard refusal (unknown/revoked device, or a policy DENY)
 */
export async function requestDeviceAction(accountId, {
  deviceId,
  capability,
  args = {},
  confirmed = [],
  missionId = null,
  waitMs = DEFAULT_WAIT_MS,
  pollMs = DEFAULT_POLL_MS,
  now = Date.now,
  sleepFn = sleep
} = {}) {
  if (!deviceId) throw Object.assign(Error('This mission has no computer selected. Choose one, or pair a computer first.'), {reason: 'no_device'});
  const device = await getDevice(accountId, deviceId);
  if (!device) throw Object.assign(Error('That computer is not paired with this workspace'), {reason: 'unknown_device'});
  if (device.revoked) throw Object.assign(Error('That computer has been disconnected'), {reason: 'device_revoked'});

  const decision = await authorizeLocalAction(accountId, {capability, args, device, confirmed});
  if (decision.outcome === 'DENY') {
    throw Object.assign(Error(decision.detail || `Refused: ${decision.reason}`), {reason: decision.reason, capability, decision});
  }

  if (decision.outcome === 'ASK_USER') {
    // Enqueued but NOT dispatched: the agent only claims `pending` actions, and
    // an ASK_USER action stays parked until the user approves it.
    const parked = await enqueueAction(accountId, {deviceId, capability, args, expected: null, decision, missionId});
    return {status: 'awaiting_decision', actionId: parked.id, decision, detail: decision.detail};
  }

  const resolved = decision.args || args;
  const expected = expectationFor(capability, resolved);
  const action = await enqueueAction(accountId, {deviceId, capability, args: resolved, expected, decision, missionId});

  const deadline = now() + waitMs;
  while (now() < deadline) {
    await sleepFn(pollMs);
    const current = await readAction(accountId, action.id);
    if (!current) break;
    if (current.status === 'completed' || current.status === 'failed') {
      return {
        status: current.status,
        actionId: action.id,
        observation: current.observation,
        report: current.report,
        verification: current.verification,
        error: current.error,
        expected
      };
    }
    if (current.status === 'denied') return {status: 'denied', actionId: action.id, decision: current.decision, detail: 'You declined this action'};
    if (current.status === 'expired') return {status: 'expired', actionId: action.id, error: current.error, detail: 'The computer never reported back'};
  }

  // Honest timeout. The action may still complete later; we do not guess.
  return {
    status: 'timeout',
    actionId: action.id,
    expected,
    detail: 'The computer has not reported back yet. It may be offline.'
  };
}

/** Resolve which device a mission should use. Explicit choice wins. */
export async function resolveTargetDevice(accountId, requestedDeviceId, {now = Date.now()} = {}) {
  const devices = await listAvailableDevices(accountId, {now});
  const usable = devices.filter(device => !device.revoked);
  if (requestedDeviceId) {
    const match = usable.find(device => device.id === requestedDeviceId);
    if (!match) return {ok: false, reason: 'unknown_device', detail: 'That computer is not paired with this workspace', devices};
    return {ok: true, deviceId: match.id, device: match, devices};
  }
  if (!usable.length) {
    return {ok: false, reason: 'no_device', detail: 'No computer is paired yet. Open Computers, pair one, and authorise a folder.', devices};
  }
  if (usable.length === 1) return {ok: true, deviceId: usable[0].id, device: usable[0], devices};
  // Several computers and no explicit choice: do not guess which machine to
  // touch. Ask instead of silently picking one.
  return {ok: false, reason: 'ambiguous_device', detail: `Choose which computer to use: ${usable.map(d => d.name).join(', ')}`, devices};
}
