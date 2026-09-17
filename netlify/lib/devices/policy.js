// ==========================================================================
// SAMVIT V12 — LOCAL ACTION POLICY ENGINE (Phase 4)
// --------------------------------------------------------------------------
// The layer between model output and the user's real computer.
//
//   MODEL OUTPUT → ACTION REQUEST → POLICY → ALLOW | DENY | ASK_USER → AGENT
//
// Two rules this file exists to enforce:
//
//   1. A model NEVER names a permission level. It names a capability from
//      shared/desktop.js and typed arguments. The level comes from source.
//   2. The answer is one of exactly three outcomes. "ASK_USER" is a real
//      outcome, not a failure — the brief is explicit that the agent must not
//      guess when the decision belongs to the user.
//
// Structured exactly like council-access.js: a PURE decision function that is
// fully unit-testable with no store, plus a store-backed entry point that adds
// the persisted stops and writes the audit trail.
// ==========================================================================
import {DESKTOP_CAPABILITIES, validateDesktopArgs, checkScopeAccess, checkCommandAccess, describeScopeRefusal} from '../../../shared/desktop.js';
import {LEVELS, levelName, readGlobalStop, recordAction} from '../intelligence/permissions.js';

export const OUTCOMES = Object.freeze(['ALLOW', 'DENY', 'ASK_USER']);

/** Every path a capability touches, so each one can be scope-checked. */
export function pathsFor(capability, args = {}) {
  if (capability === 'fs.move' || capability === 'fs.copy') return [args.from, args.to].filter(Boolean);
  if (typeof args.path === 'string') return [args.path];
  return [];
}

/**
 * Pure policy decision. No storage, no side effects, no model input.
 *
 * @param {object} input
 * @param {string} input.capability    a name from DESKTOP_CAPABILITIES
 * @param {object} input.args          untrusted, model-supplied
 * @param {object} input.device        the paired computer (scopes, approvedCommands, revoked)
 * @param {string[]} [input.confirmed] capabilities the user pre-approved for this mission
 * @param {boolean} [input.halted]     per-account kill switch OR global stop
 */
export function decideLocalAction({capability, args = {}, device = null, confirmed = [], halted = false} = {}) {
  const spec = DESKTOP_CAPABILITIES[capability];
  if (!spec) return {outcome: 'DENY', reason: 'unknown_capability'};
  if (!spec.device) return {outcome: 'DENY', reason: 'not_a_device_capability'};
  if (!device) return {outcome: 'DENY', reason: 'no_paired_computer'};
  if (device.revoked) return {outcome: 'DENY', reason: 'device_revoked'};

  const level = LEVELS[spec.level];

  // The stops outrank every grant and every capability.
  //
  // Note the deliberate difference from the cloud-side engine: there, OBSERVE
  // survives the kill switch so the user can still inspect Samvit's own state.
  // Here, EVERY device capability is halted — because every device capability
  // reaches into the user's real computer. An emergency stop that still let
  // Samvit read files on someone's machine would not be an emergency stop.
  if (halted) return {outcome: 'DENY', reason: 'kill_switch', level, levelName: levelName(level)};

  let normalised;
  try {
    normalised = validateDesktopArgs(capability, args);
  } catch (error) {
    return {outcome: 'DENY', reason: 'invalid_arguments', detail: error.message};
  }

  // Scope containment: every path the action touches must sit inside an
  // authorised folder, at the required mode.
  if (spec.scope !== 'none') {
    for (const target of pathsFor(capability, normalised)) {
      const access = checkScopeAccess(device.scopes || [], target, spec.scope);
      if (!access.allowed) {
        return {
          outcome: 'DENY',
          reason: access.reason,
          detail: access.detail || describeScopeRefusal(access.reason, target),
          path: target
        };
      }
    }
  }

  // Commands: the hard floor is a DENY; the user's own approval list is an ASK.
  if (capability === 'dev.run') {
    const access = checkCommandAccess(device.approvedCommands, normalised.executable, normalised.args);
    if (!access.allowed) {
      if (access.reason === 'command_not_approved_for_device') {
        return {
          outcome: 'ASK_USER',
          reason: access.reason,
          detail: `Approve "${access.command}" for this computer before it can run`,
          command: access.command
        };
      }
      return {outcome: 'DENY', reason: access.reason, detail: access.detail};
    }
    normalised = {...normalised, command: access.command};
  }

  // Sensitive and above need a confirmation the user recorded in advance.
  if (level >= LEVELS.SENSITIVE_ACTION && !confirmed.includes(capability)) {
    return {
      outcome: 'ASK_USER',
      reason: 'confirmation_required',
      detail: `${spec.summary} needs your approval`,
      level,
      levelName: levelName(level)
    };
  }

  return {outcome: 'ALLOW', level, levelName: levelName(level), args: normalised};
}

/**
 * Store-backed entry point. Layers the persisted stops on top of the pure
 * decision and writes one audit row per request.
 *
 * Both stops are consulted: the account's own kill switch and the
 * deployment-wide emergency stop. Either one halts state-changing actions.
 */
export async function authorizeLocalAction(accountId, {capability, args, device, confirmed = [], accountHalted = false, audit = true} = {}) {
  if (!accountId) throw Object.assign(Error('Authentication required'), {reason: 'unauthenticated'});
  const global = await readGlobalStop();
  const decision = decideLocalAction({
    capability,
    args,
    device,
    confirmed,
    halted: accountHalted || global.halted === true
  });
  if (audit) {
    try {
      await recordAction(accountId, {
        action: capability,
        level: decision.level ?? null,
        levelName: decision.levelName || null,
        outcome: decision.outcome,
        reason: decision.reason || null
      });
    } catch { /* the queue record remains the authoritative action log */ }
  }
  return {...decision, deviceId: device?.id || null, globalStop: global.halted === true};
}

export const describeOutcome = decision => {
  if (!decision) return 'No decision recorded';
  if (decision.outcome === 'ALLOW') return `${decision.args ? '' : ''}permitted at ${decision.levelName}`.trim();
  if (decision.outcome === 'ASK_USER') return `needs your decision: ${decision.detail || decision.reason}`;
  return `refused: ${decision.detail || decision.reason}`;
};
