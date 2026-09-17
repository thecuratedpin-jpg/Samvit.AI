// ==========================================================================
// SAMVIT V11 — SANDBOXED TERMINAL (computer agent foundation, part 2)
// --------------------------------------------------------------------------
// A command interpreter, NOT a shell. It exists so the agent can operate
// the virtual filesystem the way a person operates a computer, while the
// blast radius stays exactly one account's sandbox.
//
// Three deliberate constraints, each enforced in source rather than by
// convention:
//
//   1. ALLOW-LISTED VERBS. `parseCommand()` only recognises the commands in
//      COMMANDS below. Anything else is rejected before any code runs.
//   2. NO SHELL SURFACE. Pipes, redirection, substitution, chaining,
//      backgrounding and globs are rejected outright by `tokenize()`. There
//      is no eval, no child_process, no host filesystem call anywhere in
//      this file's import graph.
//   3. STRUCTURED ACTIONS. Every command maps to a permission CATEGORY
//      (ACTION_POLICY in permissions.js), so the same policy layer that
//      governs every other tool governs the terminal too. The model cannot
//      name a level; it can only choose a verb.
// ==========================================================================
import {VFS_ROOT, resolvePath, listDir, readFile, writeFile, makeDir, moveEntry, copyEntry, deleteEntry, walk, statEntry} from './vfs.js';
import {authorizeAction, levelFor, levelName} from './permissions.js';

export const MAX_COMMAND_LENGTH = 500;
export const MAX_OUTPUT_BYTES = 6000;

// The complete command surface. `action` is the permission category the
// command exercises — this mapping is the reason a model cannot smuggle a
// destructive operation through a benign verb.
export const COMMANDS = Object.freeze({
  pwd: {action: 'inspect_environment', usage: 'pwd', summary: 'Print the working directory'},
  ls: {action: 'list_files', usage: 'ls [path]', summary: 'List directory contents'},
  tree: {action: 'list_files', usage: 'tree [path]', summary: 'List every path under a directory'},
  find: {action: 'list_files', usage: 'find [path]', summary: 'List every path under a directory'},
  stat: {action: 'inspect_environment', usage: 'stat <path>', summary: 'Show details for one entry'},
  cat: {action: 'read_file', usage: 'cat <path>', summary: 'Print a file'},
  head: {action: 'read_file', usage: 'head <path> [lines]', summary: 'Print the first lines of a file'},
  wc: {action: 'read_file', usage: 'wc <path>', summary: 'Count bytes and lines in a file'},
  grep: {action: 'search_files', usage: 'grep <pattern> [path]', summary: 'Search file contents'},
  mkdir: {action: 'create_folder', usage: 'mkdir <path>', summary: 'Create a directory'},
  touch: {action: 'write_file', usage: 'touch <path>', summary: 'Create an empty file'},
  write: {action: 'write_file', usage: 'write <path> <content…>', summary: 'Write text to a file'},
  cp: {action: 'copy_file', usage: 'cp <from> <to>', summary: 'Copy a file or directory'},
  mv: {action: 'move_file', usage: 'mv <from> <to>', summary: 'Move or rename an entry'},
  rm: {action: 'delete_file', usage: 'rm <path>', summary: 'Delete a file or directory (destructive)'},
  help: {action: 'inspect_environment', usage: 'help', summary: 'List available commands'}
});

export const COMMAND_NAMES = Object.freeze(Object.keys(COMMANDS));

/**
 * Split a command line into tokens, honouring single/double quotes.
 * Rejects every shell metacharacter: without them there is no way to
 * compose a second command, redirect output, or expand a variable.
 */
export function tokenize(line) {
  if (typeof line !== 'string') throw Error('Command must be text');
  if (line.length > MAX_COMMAND_LENGTH) throw Error(`Command exceeds ${MAX_COMMAND_LENGTH} characters`);
  if (/[|&;`$><(){}\n\r]/.test(line)) throw Error('Pipes, redirection, chaining, substitution and globbing are not supported');
  if (/[*?[\]]/.test(line)) throw Error('Wildcards are not supported; name each path explicitly');
  const tokens = [];
  let current = '', quote = null, started = false;
  for (const char of line) {
    if (quote) {
      if (char === quote) quote = null; else current += char;
      continue;
    }
    if (char === '"' || char === "'") {quote = char; started = true; continue;}
    if (/\s/.test(char)) {
      if (started || current) {tokens.push(current); current = ''; started = false;}
      continue;
    }
    current += char;
    started = true;
  }
  if (quote) throw Error('Unterminated quote');
  if (started || current) tokens.push(current);
  return tokens;
}

/** Parse a command line into a structured action. Pure, no side effects. */
export function parseCommand(line) {
  const tokens = tokenize(line);
  if (!tokens.length) throw Error('Enter a command');
  const name = tokens[0].toLowerCase();
  const spec = COMMANDS[name];
  if (!spec) throw Error(`Unknown command "${tokens[0]}". Available: ${COMMAND_NAMES.join(', ')}`);
  const args = tokens.slice(1);
  const minimum = {cat: 1, head: 1, wc: 1, stat: 1, mkdir: 1, touch: 1, rm: 1, write: 2, cp: 2, mv: 2, grep: 1}[name] || 0;
  if (args.length < minimum) throw Error(`Usage: ${spec.usage}`);
  return {name, args, action: spec.action, usage: spec.usage};
}

const truncate = text => {
  const value = String(text ?? '');
  return Buffer.byteLength(value) > MAX_OUTPUT_BYTES
    ? value.slice(0, MAX_OUTPUT_BYTES) + '\n… output truncated'
    : value;
};

function render(command, args, body) {
  return truncate(`${command}${args.length ? ' ' + args.join(' ') : ''}\n${body}`);
}

/**
 * Execute one command against the account's virtual filesystem.
 *
 * @param {string} accountId
 * @param {string} line              the raw command line
 * @param {object} options
 * @param {string} [options.cwd]     working directory for relative paths
 * @param {(action: string) => Promise<object>} [options.authorize]
 *        Permission callback. Defaults to authorizeAction() with no grants,
 *        which denies everything — a caller must opt in explicitly.
 * @returns {Promise<{command, action, level, levelName, cwd, exitCode, output}>}
 */
export async function runCommand(accountId, line, {cwd = VFS_ROOT, authorize} = {}) {
  const parsed = parseCommand(line);
  const level = levelFor(parsed.action);
  const decide = authorize || (action => authorizeAction(accountId, {action, risk: 'low'}));

  const decision = await decide(parsed.action);
  if (!decision?.allowed) {
    // A denial is a hard failure: the agent must see it and revise, never
    // silently continue as though the command succeeded.
    throw Object.assign(
      Error(`Command denied: ${parsed.name} requires ${parsed.action} (${decision?.levelName || levelName(level)})${decision?.reason === 'confirmation_required' ? ' — explicit confirmation was not granted' : decision?.reason === 'kill_switch' ? ' — the safety kill switch is on' : ''}`),
      {reason: decision?.reason || 'not_granted', action: parsed.action, level: decision?.levelName || levelName(level)}
    );
  }

  const workdir = resolvePath(VFS_ROOT, cwd || VFS_ROOT);
  const target = index => resolvePath(workdir, parsed.args[index]);
  const reply = (exitCode, output) => ({
    command: parsed.name, action: parsed.action, level, levelName: levelName(level), cwd: workdir, exitCode, output: truncate(output)
  });

  try {
    switch (parsed.name) {
      case 'help':
        return reply(0, COMMAND_NAMES.map(n => `${COMMANDS[n].usage.padEnd(26)}${COMMANDS[n].summary}`).join('\n'));
      case 'pwd':
        return reply(0, workdir);
      case 'ls': {
        const result = await listDir(accountId, parsed.args[0] ? target(0) : workdir);
        if (!result.entries.length) return reply(0, '(empty)');
        return reply(0, render(parsed.name, parsed.args, result.entries.map(e => `${e.type === 'dir' ? 'd' : '-'} ${String(e.bytes).padStart(7)}  ${e.name}${e.type === 'dir' ? '/' : ''}`).join('\n')));
      }
      case 'tree':
      case 'find': {
        const base = parsed.args[0] ? target(0) : workdir;
        const rows = await walk(accountId, base);
        return reply(0, render(parsed.name, parsed.args, rows.length ? rows.map(r => `${r.type === 'dir' ? 'd' : '-'} ${String(r.bytes).padStart(7)}  ${r.path}`).join('\n') : '(empty)'));
      }
      case 'stat': {
        const info = await statEntry(accountId, target(0));
        return reply(0, `${info.type} ${info.bytes} bytes ${info.path}`);
      }
      case 'cat': {
        const file = await readFile(accountId, target(0));
        return reply(0, render(parsed.name, parsed.args, file.content));
      }
      case 'head': {
        const file = await readFile(accountId, target(0));
        const lines = parsed.args[1] ? Number(parsed.args[1]) : 10;
        if (!Number.isSafeInteger(lines) || lines < 1 || lines > 500) return reply(1, 'Line count must be a whole number between 1 and 500');
        return reply(0, render(parsed.name, parsed.args, file.content.split('\n').slice(0, lines).join('\n')));
      }
      case 'wc': {
        const file = await readFile(accountId, target(0));
        return reply(0, `${file.bytes} bytes  ${file.content.split('\n').length} lines  ${file.path}`);
      }
      case 'grep': {
        const pattern = parsed.args[0].toLowerCase();
        const scope = parsed.args[1] ? target(1) : workdir;
        const rows = await walk(accountId, scope);
        const hits = [];
        for (const row of rows) {
          if (row.type !== 'file') continue;
          const file = await readFile(accountId, row.path);
          const lines = file.content.split('\n').filter(l => l.toLowerCase().includes(pattern));
          if (lines.length) hits.push(`${row.path}: ${lines.slice(0, 3).map(l => l.trim().slice(0, 160)).join(' | ')}`);
          if (hits.length >= 20) break;
        }
        return reply(0, hits.length ? hits.join('\n') : 'No matches');
      }
      case 'mkdir':
        await makeDir(accountId, target(0));
        return reply(0, `created ${target(0)}`);
      case 'touch':
        await writeFile(accountId, target(0), '');
        return reply(0, `created ${target(0)}`);
      case 'write':
        await writeFile(accountId, target(0), parsed.args.slice(1).join(' '));
        return reply(0, `wrote ${target(0)}`);
      case 'cp':
        await copyEntry(accountId, target(0), target(1));
        return reply(0, `copied ${target(0)} -> ${target(1)}`);
      case 'mv':
        await moveEntry(accountId, target(0), target(1));
        return reply(0, `moved ${target(0)} -> ${target(1)}`);
      case 'rm':
        await deleteEntry(accountId, target(0));
        return reply(0, `deleted ${target(0)}`);
      default:
        return reply(1, `Unsupported command: ${parsed.name}`);
    }
  } catch (error) {
    // A command-level failure (missing file, bad path) is reported the way a
    // shell reports it — non-zero exit plus a message — so the agent can
    // observe the outcome and adapt instead of treating it as a crash.
    return reply(1, error.message);
  }
}
