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
// Presence is heartbeat-driven: the agent polls and the registry touches
// lastSeenAt at most once a minute. Two missed touch windows means the
// computer is gone — generous enough that a healthy agent never flaps.
export const STALE_AFTER_MS = 120000;

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

// --------------------------------------------------------------------------
// P1 — what a mission needs versus what a computer currently offers
// --------------------------------------------------------------------------
/**
 * What one capability needs the device to already have. Pure — a capability
 * never needs "more trust", it needs a specific kind of authorisation:
 *   * read capabilities  → at least one folder authorised for reading
 *   * write capabilities → at least one folder authorised for writing
 *   * dev.run            → at least one approved command
 *   * env.inspect        → nothing (it inspects only the agent itself)
 */
export function requirementFor(capability) {
  const spec = DEVICE_CAPABILITIES.includes(capability) ? capability : null;
  if (!spec) return null;
  if (capability === 'env.inspect') return null;
  if (capability === 'dev.run') return {kind: 'command', label: 'an approved development command (Computers page → Approved commands)'};
  const mode = ({'fs.write': 1, 'fs.mkdir': 1, 'fs.move': 1, 'fs.copy': 1, 'fs.delete': 1})[capability] ? 'write' : 'read';
  return {kind: 'scope', mode, label: mode === 'write' ? 'a folder authorised for reading AND writing' : 'a folder authorised for reading'};
}

/**
 * The exact requirements a device does NOT currently satisfy for the given
 * capabilities. Pure and deliberately precise: "no computer is online" and
 * "the computer has no writable folder" lead a user to very different fixes.
 *
 * @param {object} device   the paired computer (scopes, approvedCommands, revoked, lastSeenAt)
 * @param {string[]} capabilities  device capabilities the mission intends to use
 * @returns {string[]} human-actionable gaps; empty when the device is ready
 */
export function missingRequirements(device, capabilities = [], {now = Date.now()} = {}) {
  if (!device || typeof device !== 'object') return ['pair a computer first'];
  const gaps = [];
  if (device.revoked) gaps.push('the computer has been disconnected — pair it again');
  const scopes = Array.isArray(device.scopes) ? device.scopes : [];
  const hasRead = scopes.some(scope => scope && typeof scope.path === 'string');
  const hasWrite = scopes.some(scope => scope && scope.mode === 'write');
  const hasCommands = Array.isArray(device.approvedCommands) && device.approvedCommands.length > 0;
  for (const capability of [...new Set(capabilities)]) {
    const need = requirementFor(capability);
    if (!need) continue;
    if (need.kind === 'scope' && need.mode === 'write' && !hasWrite) gaps.push(`"${capability}" needs ${need.label}`);
    if (need.kind === 'scope' && need.mode === 'read' && !hasRead) gaps.push(`"${capability}" needs ${need.label}`);
    if (need.kind === 'command' && !hasCommands) gaps.push(`"${capability}" needs ${need.label}`);
  }
  return gaps;
}

/**
 * A bounded, planner-facing summary of one computer. This is the ONLY
 * discovery the planner gets: what the device offers, never a scan of it.
 */
export function deviceContextSummary(availability, {maxPaths = 6} = {}) {
  if (!availability || availability.available !== true) return 'No usable computer is selected for this mission.';
  const folders = (availability.authorisedFolders || []).slice(0, maxPaths).map(scope => `${scope.path} (${scope.mode})`).join('; ') || 'none';
  const commands = (availability.approvedCommands || []).slice(0, maxPaths).join(', ') || 'none';
  const presence = availability.online ? 'online now' : availability.neverConnected ? 'paired but has never connected' : 'appears offline';
  return [
    `Target computer: ${availability.name} (${availability.platform}/${availability.arch}), ${presence}.`,
    `Environment: local_pc — a real computer, NOT Samvit's sandbox. Use computer_* tools for it; fs_* tools act on the sandbox.`,
    `Authorised folders: ${folders}. Paths outside them are refused; do not attempt them.`,
    `Approved commands: ${commands}. Other commands will pause for user approval or be refused.`,
    `Available device capabilities: ${(availability.capabilities || []).join(', ')}.`
  ].join(' ');
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
  requireOnline = false,
  now = Date.now,
  sleepFn = sleep
} = {}) {
  if (!deviceId) throw Object.assign(Error('This mission has no computer selected. Choose one, or pair a computer first.'), {reason: 'no_device'});
  const device = await getDevice(accountId, deviceId);
  if (!device) throw Object.assign(Error('That computer is not paired with this workspace'), {reason: 'unknown_device'});
  if (device.revoked) throw Object.assign(Error('That computer has been disconnected'), {reason: 'device_revoked'});

  // P6: fail fast instead of queueing work at a computer that is provably
  // dark. Queueing and waiting out the lease timeout (×attempts) would burn
  // the mission's time budget for a guaranteed no-response; an honest
  // 'offline' lets the mission park and resume when the computer reconnects.
  // Nothing is enqueued, so there is also nothing to retry wastefully.
  if (requireOnline) {
    const lastSeenAt = device.lastSeenAt || null;
    const online = Boolean(lastSeenAt) && now() - lastSeenAt <= STALE_AFTER_MS;
    if (!online) {
      return {
        status: 'offline',
        deviceId,
        deviceName: device.name,
        lastSeenAt,
        neverConnected: !lastSeenAt,
        detail: lastSeenAt
          ? `"${device.name}" has not reported in for over ${Math.round(STALE_AFTER_MS / 60000)} minute(s) and appears to be offline`
          : `"${device.name}" is paired but its agent has never connected — start it with: node agent/main.js`
      };
    }
  }

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
