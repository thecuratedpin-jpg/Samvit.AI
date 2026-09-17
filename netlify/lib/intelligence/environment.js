// ==========================================================================
// SAMVIT V11 — ENVIRONMENT VERIFICATION (Phase 9, computer actions)
// --------------------------------------------------------------------------
// Model review can tell you whether an answer *reads* correctly. It cannot
// tell you whether a file was actually written. This module closes that gap
// for computer actions by observing the real environment before and after
// work, then checking it against what the actions said they would do.
//
// Three properties that make this genuinely stronger than model review:
//
//   1. IT READS REAL STATE. A verdict comes from the virtual filesystem, not
//      from a model's opinion about its own output.
//   2. IT IS INDEPENDENT BY CONSTRUCTION. Nothing the model said feeds into
//      the check, so `independentlyProven: true` here means what it says —
//      unlike claim verification, which is model-reviewed.
//   3. IT DETECTS THE UNEXPLAINED. Changes nobody asked for are reported
//      rather than silently accepted (Phase 4: "detect unexpected
//      environment changes").
// ==========================================================================
import {VFS_ROOT, resolvePath} from './vfs.js';
import {parseCommand} from './terminal.js';

// Tool name -> the shape of effect it promises. Read-only tools are absent
// on purpose: they promise nothing about the environment, so they are never
// "missing" and never produce a false alarm.
const TOOL_EFFECTS = Object.freeze({
  fs_write: {action: 'write_file', kind: 'present', args: ['path']},
  fs_mkdir: {action: 'create_folder', kind: 'present', args: ['path']},
  fs_delete: {action: 'delete_file', kind: 'absent', args: ['path']},
  fs_copy: {action: 'copy_file', kind: 'present', args: ['to']},
  fs_move: {action: 'move_file', kind: 'moved', args: ['to'], fromArg: 'from'}
});

// Sandboxed terminal verb -> the effect it promises. Mirrors COMMANDS in
// terminal.js; verbs not listed here are read-only.
const TERMINAL_EFFECTS = Object.freeze({
  write: {action: 'write_file', kind: 'present', arg: 0},
  touch: {action: 'write_file', kind: 'present', arg: 0},
  mkdir: {action: 'create_folder', kind: 'present', arg: 0},
  rm: {action: 'delete_file', kind: 'absent', arg: 0},
  cp: {action: 'copy_file', kind: 'present', arg: 1},
  mv: {action: 'move_file', kind: 'moved', arg: 1, fromArg: 0}
});

/**
 * Derive the observable effect a single tool call promises, or null if the
 * call promises nothing about the environment.
 *
 * Pure and defensive: an unrecognised or unparseable call yields null rather
 * than a guess, because a wrong expectation would produce a wrong verdict.
 */
export function effectFor(call, {cwd = VFS_ROOT} = {}) {
  if (!call || typeof call.name !== 'string') return null;
  const args = call.arguments && typeof call.arguments === 'object' ? call.arguments : {};

  const spec = TOOL_EFFECTS[call.name];
  if (spec) {
    const path = args[spec.args[0]];
    if (typeof path !== 'string' || !path) return null;
    try {
      const effect = {action: spec.action, kind: spec.kind, path: resolvePath(cwd, path), tool: call.name};
      if (spec.fromArg) {
        const from = args[spec.fromArg];
        if (typeof from !== 'string' || !from) return null;
        effect.from = resolvePath(cwd, from);
      }
      return effect;
    } catch {
      return null; // invalid path: the tool itself will reject it
    }
  }

  if (call.name === 'terminal') {
    const command = args.command;
    if (typeof command !== 'string') return null;
    let parsed;
    try {
      parsed = parseCommand(command);
    } catch {
      return null;
    }
    const verb = TERMINAL_EFFECTS[parsed.name];
    if (!verb) return null;
    const target = parsed.args[verb.arg];
    if (typeof target !== 'string' || !target) return null;
    try {
      const effect = {action: verb.action, kind: verb.kind, path: resolvePath(cwd, target), tool: 'terminal'};
      if (verb.fromArg !== undefined) {
        const from = parsed.args[verb.fromArg];
        if (typeof from !== 'string' || !from) return null;
        effect.from = resolvePath(cwd, from);
      }
      return effect;
    } catch {
      return null;
    }
  }

  return null;
}

export function effectsFor(calls = []) {
  const effects = [];
  for (const call of Array.isArray(calls) ? calls.slice(0, 40) : []) {
    const effect = effectFor(call);
    if (effect) effects.push(effect);
  }
  return effects;
}

/** Compare two snapshots. Pure. */
export function diffSnapshots(before, after) {
  const a = before?.entries || {};
  const b = after?.entries || {};
  const added = [], removed = [], modified = [];
  let unchanged = 0;
  for (const path of Object.keys(b)) {
    if (!(path in a)) added.push(path);
    else if (a[path].type !== b[path].type || a[path].hash !== b[path].hash) modified.push(path);
    else unchanged++;
  }
  for (const path of Object.keys(a)) if (!(path in b)) removed.push(path);
  return {added: added.sort(), removed: removed.sort(), modified: modified.sort(), unchanged};
}

export const describeDiff = diff =>
  `+${diff.added.length} added, ~${diff.modified.length} modified, -${diff.removed.length} removed`;

/**
 * Verify observed environment state against the effects the mission's own
 * actions promised.
 *
 * @param {object} before snapshot taken before the actions
 * @param {object} after  snapshot taken after the actions
 * @param {Array}  effects output of effectsFor()
 */
export function verifyEnvironment({before, after, effects = []} = {}) {
  const entries = after?.entries || {};
  const present = path => Boolean(entries[path]);
  const diff = diffSnapshots(before, after);

  const observations = effects.map(effect => {
    let observed = false, note;
    if (effect.kind === 'present') {
      observed = present(effect.path);
      note = observed ? 'present after the action' : 'was not present after the action';
    } else if (effect.kind === 'absent') {
      observed = !present(effect.path);
      note = observed ? 'absent after the action' : 'still present after the action';
    } else if (effect.kind === 'moved') {
      observed = !present(effect.from) && present(effect.path);
      note = observed ? 'moved as expected' : `source ${present(effect.from) ? 'still present' : 'gone'} / destination ${present(effect.path) ? 'present' : 'missing'}`;
    } else {
      note = 'unrecognised effect';
    }
    return {action: effect.action, tool: effect.tool || null, path: effect.path, from: effect.from || null, observed, note};
  });

  const missing = observations.filter(o => !o.observed);

  // Any change no effect accounts for is reported, not silently accepted.
  const covered = new Set();
  for (const effect of effects) {
    if (effect.path) covered.add(effect.path);
    if (effect.from) covered.add(effect.from);
  }
  const unexpected = [...diff.added, ...diff.removed, ...diff.modified].filter(path => !covered.has(path)).slice(0, 20);

  const status = !observations.length ? 'not-applicable' : missing.length ? 'unresolved' : 'verified';

  return {
    status,
    method: 'environment-observation',
    checked: observations.length,
    matched: observations.length - missing.length,
    observations: observations.slice(0, 30),
    missing: missing.slice(0, 20),
    unexpected,
    diff: {added: diff.added.length, removed: diff.removed.length, modified: diff.modified.length, unchanged: diff.unchanged},
    // Established by reading real state, with no model input in the loop.
    independentlyProven: status === 'verified'
  };
}

/** Fold several per-task environment verifications into one mission-level record. */
export function mergeEnvironmentVerifications(reports = []) {
  const usable = reports.filter(report => report && report.status !== 'not-applicable');
  if (!usable.length) return null;
  const missing = usable.flatMap(report => report.missing || []);
  const unexpected = [...new Set(usable.flatMap(report => report.unexpected || []))].slice(0, 20);
  const checked = usable.reduce((n, report) => n + (report.checked || 0), 0);
  const matched = usable.reduce((n, report) => n + (report.matched || 0), 0);
  return {
    status: missing.length ? 'unresolved' : 'verified',
    method: 'environment-observation',
    tasks: usable.length,
    checked,
    matched,
    missing: missing.slice(0, 20),
    unexpected,
    diff: usable.reduce((acc, report) => ({
      added: acc.added + (report.diff?.added || 0),
      removed: acc.removed + (report.diff?.removed || 0),
      modified: acc.modified + (report.diff?.modified || 0)
    }), {added: 0, removed: 0, modified: 0}),
    independentlyProven: missing.length === 0
  };
}
