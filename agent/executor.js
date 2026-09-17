// ==========================================================================
// SAMVIT V12 — DESKTOP AGENT EXECUTOR
// --------------------------------------------------------------------------
// Turns a validated capability into a real effect on THIS computer, and
// reports a real observation back.
//
// Three independent defences, in order:
//
//   1. STRUCTURED ONLY. The agent never receives a shell string. `dev.run`
//      arrives as {executable, args[]} and is spawned with shell:false, so
//      shell metacharacters are inert rather than filtered — there is nothing
//      to escape into.
//   2. SCOPE, TWICE. The requested path is checked against the authorised
//      folders, and then the RESOLVED REAL path is checked again. A symlink or
//      NTFS junction inside an approved folder that points outside it is
//      caught by the second check.
//   3. NO AMBIENT AUTHORITY. Nothing here is reachable except through
//      executeAction(), which validates arguments and re-checks scopes itself
//      rather than trusting the caller.
// ==========================================================================
import {promises as fs, existsSync} from 'node:fs';
import {spawn} from 'node:child_process';
import {dirname, join} from 'node:path';
import {
  canonicalPath, checkScopeAccess, validateDesktopArgs, checkCommandAccess,
  describeScopeRefusal, DESKTOP_CAPABILITIES
} from '../shared/desktop.js';

export const MAX_READ_BYTES = 400000;
export const MAX_LIST_ENTRIES = 500;
export const MAX_OUTPUT_BYTES = 200000;

const text = buffer => buffer.toString('utf8');

/** Walk up to the nearest existing ancestor, resolve it, then re-append. */
async function realpathOfNearestExisting(target) {
  const parts = canonicalPath(target).split('\\');
  for (let i = parts.length; i >= 1; i--) {
    const candidate = i === 1 ? `${parts[0]}\\` : parts.slice(0, i).join('\\');
    try {
      const real = await fs.realpath(candidate);
      const tail = parts.slice(i).join('\\');
      return tail ? join(real, tail) : real;
    } catch { /* keep walking up */ }
  }
  throw Error('That path cannot be resolved on this computer');
}

/**
 * Containment that survives symlinks and junctions.
 * Returns {allowed, path, real} or a refusal.
 */
export async function containedPath(target, scopes, needed = 'read') {
  const pre = checkScopeAccess(scopes, target, needed);
  if (!pre.allowed) return pre;
  let real;
  try {
    real = await realpathOfNearestExisting(pre.path);
  } catch (error) {
    return {allowed: false, reason: 'unresolvable_path', detail: error.message};
  }
  const post = checkScopeAccess(scopes, real, needed);
  if (!post.allowed) {
    return {allowed: false, reason: 'symlink_escape', detail: 'That path resolves outside the authorised folders'};
  }
  return {allowed: true, path: pre.path, real: post.path, mode: pre.mode};
}

const assertContained = async (target, scopes, needed) => {
  const result = await containedPath(target, scopes, needed);
  if (!result.allowed) {
    // Say WHY, using the same wording as the cloud policy engine.
    throw Object.assign(Error(result.detail || describeScopeRefusal(result.reason, target)), {reason: result.reason});
  }
  return result.real;
};

// --------------------------------------------------------------------------
// Command resolution — never a shell
// --------------------------------------------------------------------------
const nodeModulesBin = cwd => join(cwd, 'node_modules');

/**
 * Map an approved executable to something spawnable with shell:false.
 *
 * On Windows `npm`, `tsc` and `eslint` are .cmd shims, which Node refuses to
 * spawn without a shell (deliberately — see CVE-2024-27980). Rather than
 * enabling a shell, they are launched through the Node runtime with their
 * real JavaScript entry point. If the entry point cannot be found we FAIL
 * CLOSED instead of falling back to a shell.
 */
export function resolveCommand(executable, cwd) {
  if (executable === 'node') return {command: process.execPath, args: []};
  if (executable === 'git') return {command: process.platform === 'win32' ? 'git.exe' : 'git', args: []};
  if (executable === 'npm') {
    const candidates = [
      process.env.npm_execpath,
      join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
      join(dirname(dirname(process.execPath)), 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')
    ].filter(candidate => typeof candidate === 'string' && candidate.endsWith('.js'));
    const found = candidates.find(candidate => existsSync(candidate));
    if (!found) throw Error('npm could not be located without a shell; use "npm run <script>" from an approved working folder');
    return {command: process.execPath, args: [found]};
  }
  if (executable === 'tsc') {
    const entry = join(nodeModulesBin(cwd), 'typescript', 'bin', 'tsc');
    if (!existsSync(entry)) throw Error('TypeScript is not installed in this project');
    return {command: process.execPath, args: [entry]};
  }
  if (executable === 'eslint') {
    const entry = join(nodeModulesBin(cwd), 'eslint', 'bin', 'eslint.js');
    if (!existsSync(entry)) throw Error('ESLint is not installed in this project');
    return {command: process.execPath, args: [entry]};
  }
  throw Error(`"${executable}" cannot be run without a shell, so it is not permitted`);
}

function runProcess(command, args, {cwd, timeoutMs}) {
  return new Promise(resolve => {
    let child;
    try {
      child = spawn(command, args, {cwd, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']});
    } catch (error) {
      resolve({exitCode: -1, stdout: '', stderr: error.message, timedOut: false});
      return;
    }
    const out = {stdout: '', stderr: ''};
    const collect = (chunk, key) => { if (out[key].length < MAX_OUTPUT_BYTES) out[key] += text(chunk); };
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
    }, timeoutMs);
    child.stdout?.on('data', chunk => collect(chunk, 'stdout'));
    child.stderr?.on('data', chunk => collect(chunk, 'stderr'));
    child.on('error', error => {
      clearTimeout(timer);
      resolve({exitCode: -1, stdout: out.stdout, stderr: error.message, timedOut: false});
    });
    child.on('close', code => {
      clearTimeout(timer);
      resolve({exitCode: typeof code === 'number' ? code : -1, stdout: out.stdout, stderr: out.stderr, timedOut});
    });
  });
}

// --------------------------------------------------------------------------
// Capability handlers
// --------------------------------------------------------------------------
async function statObservation(real) {
  try {
    const info = await fs.stat(real);
    return {exists: true, type: info.isDirectory() ? 'dir' : 'file', size: info.size, modifiedAt: info.mtimeMs};
  } catch {
    return {exists: false};
  }
}

async function listDirectory(real, depth) {
  const entries = [];
  const walk = async (dir, level, prefix) => {
    if (entries.length >= MAX_LIST_ENTRIES) return;
    const children = await fs.readdir(dir, {withFileTypes: true});
    for (const child of children) {
      if (entries.length >= MAX_LIST_ENTRIES) return;
      const relative = prefix ? `${prefix}/${child.name}` : child.name;
      entries.push({name: relative, type: child.isDirectory() ? 'dir' : 'file'});
      if (child.isDirectory() && level < depth) await walk(join(dir, child.name), level + 1, relative);
    }
  };
  await walk(real, 1, '');
  return entries;
}

async function searchDirectory(real, query, maxResults) {
  const needle = query.toLowerCase();
  const matches = [];
  const walk = async dir => {
    if (matches.length >= maxResults) return;
    for (const child of await fs.readdir(dir, {withFileTypes: true})) {
      if (matches.length >= maxResults) return;
      const full = join(dir, child.name);
      if (child.isDirectory()) { await walk(full); continue; }
      if (!child.isFile()) continue;
      try {
        const info = await fs.stat(full);
        if (info.size > MAX_READ_BYTES) continue;
        const content = await fs.readFile(full, 'utf8');
        const index = content.toLowerCase().indexOf(needle);
        if (index >= 0) matches.push({path: full, excerpt: content.slice(Math.max(0, index - 80), index + 160)});
      } catch { /* unreadable file: skip rather than fail the search */ }
    }
  };
  await walk(real);
  return matches;
}

/**
 * Execute one capability. Throws on refusal; returns {observation, result}.
 * `scopes` and `approvedCommands` come from the device policy.
 */
export async function executeAction({capability, args, scopes, approvedCommands = [], roots = []}) {
  const spec = DESKTOP_CAPABILITIES[capability];
  if (!spec) throw Error(`Unknown capability: ${capability}`);
  const normalised = validateDesktopArgs(capability, args);

  switch (capability) {
    case 'env.inspect': {
      return {
        observation: {exists: true},
        result: {
          platform: process.platform,
          arch: process.arch,
          node: process.version,
          cwd: process.cwd(),
          authorisedFolders: scopes,
          approvedCommands,
          note: 'Read-only local environment report. No file contents are included.'
        }
      };
    }

    case 'fs.list': {
      const real = await assertContained(normalised.path, scopes, 'read');
      const entries = await listDirectory(real, normalised.depth);
      return {observation: {exists: true}, result: {path: normalised.path, entries, truncated: entries.length >= MAX_LIST_ENTRIES}};
    }

    case 'fs.stat': {
      const real = await assertContained(normalised.path, scopes, 'read');
      return {observation: await statObservation(real), result: {path: normalised.path}};
    }

    case 'fs.read': {
      const real = await assertContained(normalised.path, scopes, 'read');
      const info = await fs.stat(real);
      if (info.isDirectory()) throw Error('That is a folder, not a file');
      if (info.size > MAX_READ_BYTES) throw Error(`That file is larger than ${Math.round(MAX_READ_BYTES / 1000)} KB`);
      const buffer = await fs.readFile(real);
      if (buffer.includes(0)) throw Error('That looks like a binary file');
      const content = text(buffer);
      return {observation: {exists: true, content}, result: {path: normalised.path, content, bytes: info.size}};
    }

    case 'fs.search': {
      const real = await assertContained(normalised.path, scopes, 'read');
      const matches = await searchDirectory(real, normalised.query, normalised.maxResults);
      return {observation: {exists: true}, result: {path: normalised.path, query: normalised.query, matches}};
    }

    case 'fs.write': {
      const real = await assertContained(normalised.path, scopes, 'write');
      const parent = dirname(real);
      if (normalised.createFolders) await fs.mkdir(parent, {recursive: true});
      await fs.writeFile(real, normalised.content, 'utf8');
      const info = await fs.stat(real);
      return {observation: {exists: true, size: info.size}, result: {path: normalised.path, bytes: info.size}};
    }

    case 'fs.mkdir': {
      const real = await assertContained(normalised.path, scopes, 'write');
      await fs.mkdir(real, {recursive: true});
      return {observation: {exists: true}, result: {path: normalised.path}};
    }

    case 'fs.copy': {
      const from = await assertContained(normalised.from, scopes, 'read');
      const to = await assertContained(normalised.to, scopes, 'write');
      if (!normalised.overwrite && existsSync(to)) throw Error('The destination already exists');
      await fs.cp(from, to, {recursive: true, force: normalised.overwrite, errorOnExist: !normalised.overwrite});
      return {observation: {exists: true}, result: {from: normalised.from, to: normalised.to}};
    }

    case 'fs.move': {
      const from = await assertContained(normalised.from, scopes, 'write');
      const to = await assertContained(normalised.to, scopes, 'write');
      if (!normalised.overwrite && existsSync(to)) throw Error('The destination already exists');
      try {
        await fs.rename(from, to);
      } catch (error) {
        if (error.code !== 'EXDEV') throw error;
        await fs.cp(from, to, {recursive: true});
        await fs.rm(from, {recursive: true, force: true});
      }
      const observation = {...await statObservation(to), fromExists: existsSync(from)};
      return {observation, result: {from: normalised.from, to: normalised.to}};
    }

    case 'fs.delete': {
      const real = await assertContained(normalised.path, scopes, 'write');
      const info = await fs.stat(real);
      await fs.rm(real, {recursive: info.isDirectory(), force: false});
      return {observation: {exists: false}, result: {path: normalised.path, removed: info.isDirectory() ? 'folder' : 'file'}};
    }

    case 'dev.run': {
      const access = checkCommandAccess(approvedCommands, normalised.executable, normalised.args);
      if (!access.allowed) throw Object.assign(Error(access.detail || `"${normalised.executable}" is not approved`), {reason: access.reason});
      const cwd = normalised.cwd ? await assertContained(normalised.cwd, scopes, 'write') : (scopes[0]?.path ?? process.cwd());
      const {command, args: prefix} = resolveCommand(access.executable, cwd);
      const run = await runProcess(command, [...prefix, ...access.args], {cwd, timeoutMs: normalised.timeoutMs});
      return {
        observation: {exitCode: run.exitCode},
        result: {
          command: access.command,
          cwd,
          exitCode: run.exitCode,
          timedOut: run.timedOut,
          stdout: run.stdout.slice(-20000),
          stderr: run.stderr.slice(-8000)
        }
      };
    }

    default:
      throw Error(`"${capability}" cannot be executed on this computer`);
  }
}
