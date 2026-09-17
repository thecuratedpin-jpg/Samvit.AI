// ==========================================================================
// SAMVIT V11 — PERMISSION & SAFETY ENGINE
// --------------------------------------------------------------------------
// The single policy layer every state-changing action must pass through.
// Nothing in the intelligence layer may execute a side-effecting action
// without an explicit decision from decideAction().
//
// Deliberately structured like council-access.js: a PURE decision function
// (decideAction) that is fully unit-testable with no store at all, plus a
// store-backed entry point (authorizeAction) that layers in the persisted
// kill switch, the fail-closed outage rule and the audit trail.
//
// The model never chooses a permission level. It chooses a tool and
// arguments; the level comes from ACTION_POLICY below, in source.
// ==========================================================================
import {getStore} from '@netlify/blobs';
import {accountStore} from '../storage/accounts.js';
import {casUpdate} from '../storage/concurrency.js';

// Ordered least -> most dangerous. Numeric so comparisons are explicit
// rather than string matching, and so new levels can be inserted safely.
export const LEVELS = Object.freeze({OBSERVE: 0, SAFE_ACTION: 1, SENSITIVE_ACTION: 2, HIGH_IMPACT_ACTION: 3});
export const LEVEL_NAMES = Object.freeze(['OBSERVE', 'SAFE_ACTION', 'SENSITIVE_ACTION', 'HIGH_IMPACT_ACTION']);

// Every action category this system can perform, classified exactly once,
// here. A tool's own `risk` field is only a fallback for categories that
// are intentionally not listed (see RISK_FALLBACK).
export const ACTION_POLICY = Object.freeze({
  // --- OBSERVE: read-only, no state change, no external side effect. ---
  calculate: 'OBSERVE',
  // Existing v9/v10 tool names, classified in place so their grant names and
  // therefore their behaviour are completely unchanged.
  fetch_url: 'OBSERVE',
  web_search: 'OBSERVE',
  file_read: 'OBSERVE',
  file_search: 'OBSERVE',
  memory_search: 'OBSERVE',
  read_file: 'OBSERVE',
  list_files: 'OBSERVE',
  search_files: 'OBSERVE',
  inspect_environment: 'OBSERVE',
  read_memory: 'OBSERVE',
  search_web: 'OBSERVE',
  read_url: 'OBSERVE',
  read_output: 'OBSERVE',
  // --- V12: actions on a PAIRED LOCAL COMPUTER. ---
  // Same four levels and the same engine as everything else; the device policy
  // engine (devices/policy.js) then narrows them further using the computer's
  // authorised folders and approved commands. Two independent gates, never one.
  computer_inspect: 'OBSERVE',
  computer_read: 'OBSERVE',
  request_user_decision: 'OBSERVE',

  // --- SAFE_ACTION: reversible, confined to the account's own sandbox. ---
  write_file: 'SAFE_ACTION',
  create_folder: 'SAFE_ACTION',
  copy_file: 'SAFE_ACTION',
  move_file: 'SAFE_ACTION',
  run_command: 'SAFE_ACTION',
  computer_write: 'SAFE_ACTION',

  // --- SENSITIVE_ACTION: destructive, or leaves the sandbox. Needs explicit confirmation. ---
  delete_file: 'SENSITIVE_ACTION',
  computer_delete: 'SENSITIVE_ACTION',
  computer_run: 'SENSITIVE_ACTION',
  execute_code: 'SENSITIVE_ACTION',
  install_software: 'SENSITIVE_ACTION',
  send_message: 'SENSITIVE_ACTION',
  publish_content: 'SENSITIVE_ACTION',
  external_request: 'SENSITIVE_ACTION',

  // --- HIGH_IMPACT_ACTION: irreversible consequences outside the sandbox. ---
  purchase: 'HIGH_IMPACT_ACTION',
  financial_transaction: 'HIGH_IMPACT_ACTION',
  change_account_security: 'HIGH_IMPACT_ACTION',
  delete_account: 'HIGH_IMPACT_ACTION'
});

// Fallback for categories deliberately left out of the policy table. The
// tool's declared risk is the author's own statement about the tool; it is
// trusted because it lives in source, never in model output.
export const RISK_FALLBACK = Object.freeze({low: 'SAFE_ACTION', medium: 'SENSITIVE_ACTION', high: 'HIGH_IMPACT_ACTION'});

// Anything unclassified and undeclared is treated as SENSITIVE, never SAFE.
export const DEFAULT_LEVEL = 'SENSITIVE_ACTION';

export function levelFor(action, risk) {
  const named = ACTION_POLICY[action];
  if (named) return LEVELS[named];
  if (risk && RISK_FALLBACK[risk]) return LEVELS[RISK_FALLBACK[risk]];
  return LEVELS[DEFAULT_LEVEL];
}

export const levelName = level => LEVEL_NAMES[level] ?? DEFAULT_LEVEL;
export const requiresConfirmation = level => level >= LEVELS.SENSITIVE_ACTION;

/**
 * Pure policy decision. No storage, no side effects, no model input.
 * Returns a structured verdict so callers can surface a precise reason
 * instead of a generic "denied".
 */
export function decideAction({action, risk, grants = [], confirmed = [], halted = false, declaredConfirmation = false} = {}) {
  if (typeof action !== 'string' || !action) throw Error('Action name is required');
  if (!Array.isArray(grants) || !Array.isArray(confirmed)) throw Error('Malformed permission context');
  // A tool may declare `confirmationRequired` explicitly; that declaration can
  // only ever RAISE the level, never lower it. This is what lets the engine
  // adopt pre-existing tool declarations without loosening any of them.
  const level = Math.max(levelFor(action, risk), declaredConfirmation ? LEVELS.SENSITIVE_ACTION : LEVELS.OBSERVE);
  const name = levelName(level);

  // 1. Grant check first: an ungranted action is never reachable, at any level.
  if (!grants.includes(action)) return {allowed: false, level, levelName: name, requiresConfirmation: false, reason: 'not_granted'};

  // 2. Kill switch stops everything that could change state. Observation stays
  //    available so a user can still inspect what already happened.
  if (halted && level > LEVELS.OBSERVE) return {allowed: false, level, levelName: name, requiresConfirmation: false, reason: 'kill_switch'};

  // 3. Sensitive and above need an explicit, previously recorded confirmation.
  if (requiresConfirmation(level) && !confirmed.includes(action)) return {allowed: false, level, levelName: name, requiresConfirmation: true, reason: 'confirmation_required'};

  return {allowed: true, level, levelName: name, requiresConfirmation: false, reason: 'permitted'};
}

// --------------------------------------------------------------------------
// Store-backed layer: kill switch + audit trail
// --------------------------------------------------------------------------
export const SAFETY_STORE = 'samvit-safety';
export const AUDIT_LIMIT = 200;

const emptySafety = () => ({halted: false, reason: null, updatedAt: 0});

/**
 * Read the persisted safety state. Throws if storage is unreachable —
 * deliberately NOT swallowed here, because authorizeAction() must be able
 * to tell "no state yet" apart from "cannot reach the state".
 */
export async function readSafety(accountId) {
  const record = await accountStore(SAFETY_STORE, accountId).get('state', {type: 'json', consistency: 'strong'});
  return record && typeof record.halted === 'boolean' ? record : emptySafety();
}

export async function setKillSwitch(accountId, {halted, reason = null, by = null} = {}) {
  if (typeof halted !== 'boolean') throw Error('Kill switch requires an explicit boolean');
  const {value} = await casUpdate(accountStore(SAFETY_STORE, accountId), 'state', () => ({
    halted,
    reason: typeof reason === 'string' ? reason.slice(0, 200) : null,
    by: typeof by === 'string' ? by.slice(0, 120) : null,
    updatedAt: Date.now()
  }));
  return value;
}

/**
 * Append one entry to the bounded audit trail. Stores only what a human
 * needs to reconstruct what happened — never hidden reasoning.
 */
export async function recordAction(accountId, entry = {}) {
  const row = {
    at: Date.now(),
    action: String(entry.action || '').slice(0, 80),
    level: Number.isInteger(entry.level) ? entry.level : null,
    levelName: entry.levelName || null,
    outcome: entry.outcome || null,
    reason: entry.reason || null,
    deviceId: typeof entry.deviceId === 'string' ? entry.deviceId.slice(0, 40) : null
  };
  const {value} = await casUpdate(accountStore(SAFETY_STORE, accountId), 'audit', current => {
    const rows = Array.isArray(current?.rows) ? current.rows : [];
    return {rows: [...rows, row].slice(-AUDIT_LIMIT)};
  });
  return value;
}

export async function readAudit(accountId, limit = 50) {
  const record = await accountStore(SAFETY_STORE, accountId).get('audit', {type: 'json', consistency: 'strong'});
  const rows = Array.isArray(record?.rows) ? record.rows : [];
  return rows.slice(-Math.max(1, Math.min(limit, AUDIT_LIMIT)));
}

/**
 * The one entry point a real action path should call. Layers the persisted
 * kill switch and the fail-closed outage rule on top of decideAction().
 *
 * Fail-closed rule: if the safety state cannot be read, every action above
 * OBSERVE is denied. A storage outage must never silently grant authority.
 */
export async function authorizeAction(accountId, {action, risk, grants = [], confirmed = [], audit = true, declaredConfirmation = false} = {}) {
  if (!accountId) throw Object.assign(Error('Authentication required'), {reason: 'unauthenticated'});

  let safety, unavailable = false;
  try {
    safety = await readSafety(accountId);
  } catch {
    safety = emptySafety();
    unavailable = true;
  }

  const decision = decideAction({action, risk, grants, confirmed, halted: safety.halted, declaredConfirmation});
  const final = unavailable && decision.level > LEVELS.OBSERVE
    ? {...decision, allowed: false, requiresConfirmation: false, reason: 'safety_unavailable'}
    : decision;

  // Audit failures must not be able to block (or, worse, silently permit) the
  // action itself; the caller already records the same event on the job trace.
  if (audit) {
    try {
      await recordAction(accountId, {action, ...final, outcome: final.allowed ? 'allowed' : 'denied'});
    } catch { /* trace remains the authoritative in-mission record */ }
  }
  return final;
}

/** Human-readable one-liner for the mission trace / notifications. */
export function describeDecision(decision) {
  if (!decision) return 'No decision recorded';
  if (decision.allowed) return `${decision.action || 'action'} permitted at ${decision.levelName}`;
  const why = {
    not_granted: 'not granted for this mission',
    kill_switch: 'blocked by the safety kill switch',
    confirmation_required: 'waiting for explicit confirmation',
    safety_unavailable: 'blocked because safety state was unreachable'
  }[decision.reason] || 'denied';
  return `${decision.action || 'action'} ${why}`;
}

// --------------------------------------------------------------------------
// GLOBAL emergency stop (V12, Phase 15)
// --------------------------------------------------------------------------
// The per-account kill switch stops one workspace. This stops the whole
// deployment — the operator's emergency brake, including every paired
// computer. It lives in its own store so account deletion can never remove it.
export const GLOBAL_SAFETY_STORE = 'samvit-global-safety';

/**
 * Read the deployment-wide stop.
 *
 * Fails CLOSED: if the stop state cannot be read, it is reported as engaged.
 * A storage outage must never be the reason something ran.
 */
export async function readGlobalStop() {
  try {
    const record = await getStore(GLOBAL_SAFETY_STORE).get('stop', {type: 'json', consistency: 'strong'});
    return record && typeof record.halted === 'boolean' ? record : {halted: false, reason: null, updatedAt: 0};
  } catch {
    return {halted: true, unavailable: true, reason: 'Global safety state unreachable', updatedAt: 0};
  }
}

export async function setGlobalStop({halted, reason = null, by = null} = {}) {
  if (typeof halted !== 'boolean') throw Error('The global stop requires an explicit boolean');
  const {value} = await casUpdate(getStore(GLOBAL_SAFETY_STORE), 'stop', () => ({
    halted,
    reason: typeof reason === 'string' ? reason.slice(0, 200) : null,
    by: typeof by === 'string' ? by.slice(0, 120) : null,
    updatedAt: Date.now()
  }));
  return value;
}
