// ==========================================================================
// SAMVIT V11 — VIRTUAL FILESYSTEM (computer agent foundation, part 1)
// --------------------------------------------------------------------------
// Samvit runs on serverless functions: it cannot and must not touch the
// host machine's real disk. This module is the honest, secure substitute —
// a real, persistent, per-account filesystem with real semantics
// (directories, files, move, copy, recursive delete) that the agent can
// genuinely operate on, backed by Netlify Blobs.
//
// Everything here is a STRUCTURED operation. There is no path string
// interpolation into a shell, no host filesystem call, and no way to name
// a file outside the account's own root. Path validation is a pure,
// unit-tested function so the containment guarantee is provable rather
// than assumed.
// ==========================================================================
import {accountStore} from '../storage/accounts.js';
import {casUpdate} from '../storage/concurrency.js';
import {createHash} from 'node:crypto';

export const VFS_STORE = 'samvit-vfs';
export const VFS_ROOT = '/';

// Quotas keep one account's workspace bounded — an autonomous loop can
// never fill storage, and every write is a constant-size CAS update.
export const VFS_LIMITS = Object.freeze({
  maxFiles: 200,
  maxFileBytes: 100000,
  maxTotalBytes: 2000000,
  maxPathLength: 200,
  maxDepth: 8,
  maxSegmentLength: 64
});

// --------------------------------------------------------------------------
// Path handling — pure functions, exported for direct testing
// --------------------------------------------------------------------------

/**
 * Split a raw path into safe segments. Rejects traversal, absolute host
 * paths, control characters, backslashes and over-long input. This is the
 * ONLY place a path is turned into segments, so containment is enforced
 * once rather than re-checked at each call site.
 */
export function splitPath(raw) {
  if (typeof raw !== 'string') throw Error('Path must be text');
  if (raw.length > VFS_LIMITS.maxPathLength) throw Error('Path is too long');
  if (/[\u0000-\u001f\u007f]/.test(raw)) throw Error('Path contains control characters');
  if (raw.includes('\\')) throw Error('Use forward slashes in paths');
  const segments = [];
  for (const part of raw.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') throw Error('Parent directory traversal is not allowed');
    if (part.length > VFS_LIMITS.maxSegmentLength) throw Error('Path segment is too long');
    segments.push(part);
  }
  if (segments.length > VFS_LIMITS.maxDepth) throw Error('Path is nested too deeply');
  return segments;
}

export const normalizePath = raw => VFS_ROOT + splitPath(raw).join('/');

/** Resolve `raw` against `cwd`. Absolute input ignores the working directory. */
export function resolvePath(cwd, raw) {
  const base = typeof raw === 'string' && raw.startsWith('/') ? [] : splitPath(cwd || VFS_ROOT);
  const suffix = splitPath(raw === undefined || raw === null ? '.' : raw);
  return VFS_ROOT + [...base, ...suffix].join('/');
}

const parentOf = path => {
  const index = path.lastIndexOf('/');
  return index <= 0 ? VFS_ROOT : path.slice(0, index);
};
const baseOf = path => path.slice(path.lastIndexOf('/') + 1);
const isWithin = (path, ancestor) => path === ancestor || path.startsWith(ancestor === VFS_ROOT ? VFS_ROOT : ancestor + '/');

// --------------------------------------------------------------------------
// Tree storage — one bounded document per account, CAS-protected
// --------------------------------------------------------------------------
const emptyTree = () => ({entries: {[VFS_ROOT]: {type: 'dir', createdAt: 0}}, totalBytes: 0});

async function readTree(accountId) {
  const record = await accountStore(VFS_STORE, accountId).get('tree', {type: 'json', consistency: 'strong'});
  return record && record.entries && record.entries[VFS_ROOT] ? record : emptyTree();
}

async function mutate(accountId, updateFn) {
  const {value} = await casUpdate(accountStore(VFS_STORE, accountId), 'tree', current =>
    updateFn(current && current.entries && current.entries[VFS_ROOT] ? current : emptyTree()));
  return value;
}

const entry = (tree, path) => tree.entries[path] || null;
const requireDir = (tree, path) => {
  const node = entry(tree, path);
  if (!node) throw Error(`Directory not found: ${path}`);
  if (node.type !== 'dir') throw Error(`Not a directory: ${path}`);
  return node;
};
const requireParentDir = (tree, path) => {
  const parent = parentOf(path);
  requireDir(tree, parent);
  return parent;
};

// --------------------------------------------------------------------------
// Operations
// --------------------------------------------------------------------------

export async function listDir(accountId, rawPath = VFS_ROOT) {
  const path = normalizePath(rawPath);
  const tree = await readTree(accountId);
  requireDir(tree, path);
  const children = Object.keys(tree.entries)
    .filter(key => key !== VFS_ROOT && parentOf(key) === path)
    .map(key => ({name: baseOf(key), type: tree.entries[key].type, bytes: tree.entries[key].bytes || 0, path: key}))
    .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
  return {path, entries: children, totalBytes: tree.totalBytes};
}

export async function statEntry(accountId, rawPath) {
  const path = normalizePath(rawPath);
  const tree = await readTree(accountId);
  const node = entry(tree, path);
  if (!node) throw Error(`Not found: ${path}`);
  return {path, type: node.type, bytes: node.bytes || 0, createdAt: node.createdAt || 0, updatedAt: node.updatedAt || 0};
}

export async function readFile(accountId, rawPath) {
  const path = normalizePath(rawPath);
  const tree = await readTree(accountId);
  const node = entry(tree, path);
  if (!node) throw Error(`Not found: ${path}`);
  if (node.type !== 'file') throw Error(`Not a file: ${path}`);
  return {path, content: node.content, bytes: node.bytes || 0, updatedAt: node.updatedAt || 0};
}

export async function writeFile(accountId, rawPath, content) {
  const path = normalizePath(rawPath);
  if (path === VFS_ROOT) throw Error('Cannot write to the root directory');
  if (typeof content !== 'string') throw Error('File content must be text');
  const bytes = Buffer.byteLength(content, 'utf8');
  if (bytes > VFS_LIMITS.maxFileBytes) throw Error(`File exceeds the ${VFS_LIMITS.maxFileBytes}-byte limit`);

  return mutate(accountId, tree => {
    requireParentDir(tree, path);
    const existing = entry(tree, path);
    if (existing?.type === 'dir') throw Error(`Not a file: ${path}`);
    const fileCount = Object.values(tree.entries).filter(n => n.type === 'file').length;
    if (!existing && fileCount >= VFS_LIMITS.maxFiles) throw Error(`File limit of ${VFS_LIMITS.maxFiles} reached`);
    const totalBytes = tree.totalBytes - (existing?.bytes || 0) + bytes;
    if (totalBytes > VFS_LIMITS.maxTotalBytes) throw Error('Workspace storage limit reached');
    const now = Date.now();
    return {
      ...tree,
      totalBytes,
      entries: {...tree.entries, [path]: {type: 'file', content, bytes, createdAt: existing?.createdAt || now, updatedAt: now}}
    };
  }).then(tree => ({path, bytes, totalBytes: tree.totalBytes}));
}

export async function makeDir(accountId, rawPath) {
  const path = normalizePath(rawPath);
  if (path === VFS_ROOT) throw Error('The root directory already exists');
  return mutate(accountId, tree => {
    requireParentDir(tree, path);
    const existing = entry(tree, path);
    if (existing) {
      if (existing.type === 'dir') return tree; // idempotent, like `mkdir -p`
      throw Error(`A file already exists at ${path}`);
    }
    return {...tree, entries: {...tree.entries, [path]: {type: 'dir', createdAt: Date.now()}}};
  }).then(() => ({path, type: 'dir'}));
}

/** Remap every entry under `from` to live under `to` instead. */
function remap(entries, from, to) {
  const moved = {};
  for (const key of Object.keys(entries)) {
    if (!isWithin(key, from)) {
      moved[key] = entries[key];
      continue;
    }
    moved[to + key.slice(from.length)] = entries[key];
  }
  return moved;
}

export async function moveEntry(accountId, rawFrom, rawTo) {
  const from = normalizePath(rawFrom);
  const to = normalizePath(rawTo);
  if (from === VFS_ROOT) throw Error('Cannot move the root directory');
  if (from === to) throw Error('Source and destination are the same');
  return mutate(accountId, tree => {
    const node = entry(tree, from);
    if (!node) throw Error(`Not found: ${from}`);
    requireParentDir(tree, to);
    if (entry(tree, to)) throw Error(`Destination already exists: ${to}`);
    if (node.type === 'dir' && isWithin(to, from)) throw Error('Cannot move a directory into itself');
    return {...tree, entries: remap(tree.entries, from, to)};
  }).then(() => ({from, to}));
}

export async function copyEntry(accountId, rawFrom, rawTo) {
  const from = normalizePath(rawFrom);
  const to = normalizePath(rawTo);
  if (from === VFS_ROOT) throw Error('Cannot copy the root directory');
  if (from === to) throw Error('Source and destination are the same');
  return mutate(accountId, tree => {
    const node = entry(tree, from);
    if (!node) throw Error(`Not found: ${from}`);
    requireParentDir(tree, to);
    if (entry(tree, to)) throw Error(`Destination already exists: ${to}`);
    if (node.type === 'dir' && isWithin(to, from)) throw Error('Cannot copy a directory into itself');

    const copied = {};
    let addedBytes = 0, addedFiles = 0;
    for (const key of Object.keys(tree.entries)) {
      if (!isWithin(key, from)) continue;
      const target = to + key.slice(from.length);
      const source = tree.entries[key];
      copied[target] = {...source, createdAt: Date.now(), updatedAt: Date.now()};
      if (source.type === 'file') {addedBytes += source.bytes || 0; addedFiles++;}
    }
    const fileCount = Object.values(tree.entries).filter(n => n.type === 'file').length;
    if (fileCount + addedFiles > VFS_LIMITS.maxFiles) throw Error(`File limit of ${VFS_LIMITS.maxFiles} reached`);
    if (tree.totalBytes + addedBytes > VFS_LIMITS.maxTotalBytes) throw Error('Workspace storage limit reached');
    return {...tree, totalBytes: tree.totalBytes + addedBytes, entries: {...tree.entries, ...copied}};
  }).then(() => ({from, to}));
}

/** Recursive delete. Classified SENSITIVE_ACTION — the caller must have been authorized first. */
export async function deleteEntry(accountId, rawPath) {
  const path = normalizePath(rawPath);
  if (path === VFS_ROOT) throw Error('Cannot delete the root directory');
  return mutate(accountId, tree => {
    const node = entry(tree, path);
    if (!node) throw Error(`Not found: ${path}`);
    const entries = {};
    let removedBytes = 0, removedFiles = 0;
    for (const key of Object.keys(tree.entries)) {
      if (isWithin(key, path)) {
        if (tree.entries[key].type === 'file') {removedBytes += tree.entries[key].bytes || 0; removedFiles++;}
        continue;
      }
      entries[key] = tree.entries[key];
    }
    return {entries, totalBytes: tree.totalBytes - removedBytes, removedFiles};
  }).then(tree => ({path, removedFiles: tree.removedFiles}));
}

/** Bounded recursive walk, used by search and the sandboxed terminal. */
export async function walk(accountId, rawPath = VFS_ROOT) {
  const path = normalizePath(rawPath);
  const tree = await readTree(accountId);
  requireDir(tree, path);
  const found = [];
  for (const key of Object.keys(tree.entries)) {
    if (key !== VFS_ROOT && isWithin(key, path)) found.push({path: key, type: tree.entries[key].type, bytes: tree.entries[key].bytes || 0});
  }
  return found.sort((a, b) => a.path.localeCompare(b.path));
}

/** Search file contents. Bounded result count and excerpt size. */
export async function searchFiles(accountId, query, {maxResults = 8, excerptBytes = 400} = {}) {
  if (typeof query !== 'string' || !query.trim()) throw Error('A search term is required');
  const tree = await readTree(accountId);
  const needle = query.toLowerCase();
  const matches = [];
  for (const key of Object.keys(tree.entries)) {
    const node = tree.entries[key];
    if (node.type !== 'file') continue;
    const index = node.content.toLowerCase().indexOf(needle);
    if (index < 0) continue;
    matches.push({path: key, excerpt: node.content.slice(Math.max(0, index - 60), Math.max(0, index - 60) + excerptBytes)});
    if (matches.length >= maxResults) break;
  }
  return {query, matches};
}

export async function usage(accountId) {
  const tree = await readTree(accountId);
  const files = Object.values(tree.entries).filter(n => n.type === 'file');
  return {files: files.length, dirs: Object.values(tree.entries).filter(n => n.type === 'dir').length, bytes: tree.totalBytes, limits: VFS_LIMITS};
}

/**
 * Observe the real environment: a compact, bounded digest of every entry.
 *
 * This is what makes computer actions *verifiable* rather than merely
 * claimed — the caller can snapshot before an action, snapshot after, and
 * compare against what the action said it would do. Content is reduced to a
 * short hash so a "modified" verdict is trustworthy without storing the file
 * twice; the whole tree is capped by VFS_LIMITS (200 files / 2 MB), so a
 * snapshot is always cheap.
 */
export async function snapshot(accountId) {
  const tree = await readTree(accountId);
  const entries = {};
  for (const path of Object.keys(tree.entries)) {
    if (path === VFS_ROOT) continue;
    const node = tree.entries[path];
    entries[path] = node.type === 'dir'
      ? {type: 'dir'}
      : {type: 'file', bytes: node.bytes || 0, hash: createHash('sha256').update(node.content || '').digest('hex').slice(0, 16), updatedAt: node.updatedAt || 0};
  }
  return {entries, totalBytes: tree.totalBytes, at: Date.now()};
}
