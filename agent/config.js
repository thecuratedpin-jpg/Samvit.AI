// SAMVIT V12 — desktop agent configuration.
// Stored outside the project so a repository clone never carries credentials.
import {readFileSync, writeFileSync, mkdirSync, existsSync} from 'node:fs';
import {homedir} from 'node:os';
import {join, dirname} from 'node:path';

export const configPath = () =>
  process.env.SAMVIT_AGENT_CONFIG || join(process.env.SAMVIT_AGENT_HOME || join(homedir(), '.samvit'), 'agent.json');

export function loadConfig(path = configPath()) {
  if (!existsSync(path)) return null;
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw Error(`The agent config at ${path} is not valid JSON`);
  }
  if (!parsed || typeof parsed !== 'object') throw Error('The agent config is malformed');
  return parsed;
}

export function saveConfig(config, path = configPath()) {
  mkdirSync(dirname(path), {recursive: true, mode: 0o700});
  writeFileSync(path, JSON.stringify(config, null, 2) + '\n', {mode: 0o600});
  return path;
}

export function requireConfig(path = configPath()) {
  const config = loadConfig(path);
  if (!config?.deviceId || !config?.deviceToken || !config?.cloudUrl) {
    throw Error('This computer is not paired yet. Run:  node agent/pair.js <PAIRING-CODE>');
  }
  return config;
}

/** The agent only ever talks to an HTTPS origin (or loopback for local dev). */
export function normalizeCloudUrl(raw) {
  if (!raw) throw Error('A Samvit address is required, for example https://your-site.netlify.app');
  const url = new URL(String(raw));
  const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (url.protocol !== 'https:' && !loopback) throw Error('The Samvit address must be HTTPS');
  if (url.username || url.password) throw Error('Do not put credentials in the Samvit address');
  return url.origin;
}
