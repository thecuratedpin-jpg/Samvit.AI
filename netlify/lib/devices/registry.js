// ==========================================================================
// SAMVIT V12 — DEVICE REGISTRY (Phase 2)
// --------------------------------------------------------------------------
// Pairing, authentication, scopes and revocation for local computers.
//
// The trust model, stated plainly:
//
//   * The cloud NEVER holds a credential that can act as a device. It stores
//     only a SHA-256 hash of the device token, so a storage leak cannot be
//     replayed against a paired computer. (A stored HMAC key would be worse:
//     the leak itself would become the ability to impersonate.)
//   * The long-lived device token is used for exactly ONE thing: minting a
//     short-lived session token. Polling then uses the session token, which
//     expires in 10 minutes, so the credential in active use is short-lived.
//   * Requests carry a timestamp and single-use nonce, so a captured request
//     cannot be replayed inside the clock-skew window.
//   * Pairing uses a short-lived (5 min), single-use, high-entropy code.
//   * Revocation is a single server-side flag that also bumps the session
//     version, invalidating anything already issued.
//
// Storage: the auth index lives in a GLOBAL store because a device id must be
// resolvable without knowing its account. Each entry carries `accountId`, so
// account deletion removes it automatically (account-lifecycle.js matches on
// `value.accountId`).
// ==========================================================================
import {getStore} from '@netlify/blobs';
import {MAX_ORIGIN_RECORDS} from '../../../shared/browser.js';
import {casUpdate} from '../storage/concurrency.js';
import {accountStore} from '../storage/accounts.js';
import {timingSafeEqual} from '../security.js';

export const DEVICE_STORE = 'samvit-devices';
export const DEVICE_AUTH_STORE = 'samvit-device-auth';
export const PAIRING_STORE = 'samvit-device-pairing';

export const PAIRING_TTL_MS = 5 * 60 * 1000;
export const SESSION_TTL_MS = 10 * 60 * 1000;
export const MAX_CLOCK_SKEW_MS = 90 * 1000;
export const MAX_DEVICES = 10;
export const NONCE_WINDOW = 200;

// Unambiguous alphabet: no O/0, no I/1. 32 symbols => unbiased byte mapping.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const encoder = new TextEncoder();

const b64url = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes)))
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export function randomToken(bytes = 32) {
  const buffer = new Uint8Array(bytes);
  crypto.getRandomValues(buffer);
  return b64url(buffer);
}

export function pairingCode() {
  const buffer = new Uint8Array(8);
  crypto.getRandomValues(buffer);
  return [...buffer].map(byte => ALPHABET[byte % ALPHABET.length]).join('');
}

const hex = buffer => [...new Uint8Array(buffer)].map(b => b.toString(16).padStart(2, '0')).join('');

export async function sha256Hex(text) {
  return hex(await crypto.subtle.digest('SHA-256', encoder.encode(String(text))));
}

/** Constant-time comparison of two hex digests. */
export async function tokenMatches(storedHash, presented) {
  if (typeof storedHash !== 'string' || typeof presented !== 'string') return false;
  return timingSafeEqual(storedHash, await sha256Hex(presented));
}

const cleanName = value => {
  const name = typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 80) : '';
  return name || 'Unnamed computer';
};

export const publicDevice = device => {
  if (!device) return null;
  const {tokenHash, ...safe} = device;
  return safe;
};

// --------------------------------------------------------------------------
// Pairing
// --------------------------------------------------------------------------

/** Issue a single-use pairing code for a signed-in account. */
export async function beginPairing(accountId, {now = Date.now()} = {}) {
  const store = getStore(PAIRING_STORE);
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = pairingCode();
    const key = 'pair:' + await sha256Hex(code);
    try {
      // updateFn throwing aborts without writing — that is how a collision is
      // rejected rather than silently overwriting someone else's code.
      const {value} = await casUpdate(store, key, current => {
        if (current && !current.usedAt && current.expiresAt > now) throw Error('collision');
        return {accountId, createdAt: now, expiresAt: now + PAIRING_TTL_MS, usedAt: null};
      });
      return {code, expiresAt: value.expiresAt};
    } catch (error) {
      if (!/collision/.test(error.message)) throw error;
    }
  }
  throw Error('Could not allocate a pairing code; please retry');
}

/**
 * Redeem a pairing code on behalf of the local agent.
 * Returns the device token exactly once — it is never stored in plaintext.
 */
export async function completePairing({code, deviceName, platform, arch}, {now = Date.now(), env = null} = {}) {
  const cleaned = String(code || '').replace(/[\s-]/g, '').toUpperCase();
  if (!/^[A-Z2-9]{8}$/.test(cleaned)) throw Error('Enter the 8-character pairing code');
  const store = getStore(PAIRING_STORE);
  const key = 'pair:' + await sha256Hex(cleaned);
  const record = await store.get(key, {type: 'json', consistency: 'strong'});
  if (!record) throw Error('That pairing code is not valid');
  if (record.usedAt) throw Error('That pairing code has already been used');
  if (record.expiresAt <= now) throw Error('That pairing code has expired');

  const accountId = record.accountId;
  const index = await readDeviceIndex(accountId);
  if (index.length >= MAX_DEVICES) throw Error(`You can pair up to ${MAX_DEVICES} computers`);

  // Burn the code atomically before creating anything.
  await casUpdate(store, key, current => {
    if (!current || current.usedAt) throw Error('That pairing code has already been used');
    return {...current, usedAt: now};
  });

  const id = crypto.randomUUID();
  const token = randomToken(32);
  const device = {
    id,
    accountId,
    name: cleanName(deviceName),
    platform: cleanName(platform) || 'unknown',
    arch: cleanName(arch) || 'unknown',
    createdAt: now,
    lastSeenAt: null,
    revoked: false,
    revokedAt: null,
    scopes: [],
    approvedCommands: [],
    sessionVersion: 1
  };
  await accountStore(DEVICE_STORE, accountId).setJSON('device:' + id, device);
  await casUpdate(accountStore(DEVICE_STORE, accountId), 'index', current => ({
    devices: [...(current?.devices || []), publicDevice(device)]
  }));
  await getStore(DEVICE_AUTH_STORE).setJSON('auth:' + id, {
    accountId,
    tokenHash: await sha256Hex(token),
    revoked: false,
    sessionVersion: 1,
    lastSeenAt: null
  });
  // V14 P16: pairing a physical computer is security-relevant — tell the
  // account owner (best-effort; pairing must never fail because email did).
  if (env) {
    const {notifySecurityEventById} = await import('../notifications.js');
    await notifySecurityEventById(accountId, env, {
      headline: 'A new computer was paired to your account',
      detail: `"${device.name}" (${device.platform}/${device.arch}) was connected with a pairing code. If you did not do this, sign in and revoke the computer immediately.`
    });
  }
  return {deviceId: id, deviceToken: token, device: publicDevice(device)};
}

export async function readDeviceIndex(accountId) {
  const record = await accountStore(DEVICE_STORE, accountId).get('index', {type: 'json', consistency: 'strong'});
  return Array.isArray(record?.devices) ? record.devices : [];
}

export async function getDevice(accountId, deviceId) {
  if (!/^[0-9a-f-]{36}$/.test(String(deviceId || ''))) return null;
  return accountStore(DEVICE_STORE, accountId).get('device:' + deviceId, {type: 'json', consistency: 'strong'});
}

export async function listDevices(accountId) {
  const index = await readDeviceIndex(accountId);
  return Promise.all(index.map(entry => getDevice(accountId, entry.id).then(device => publicDevice(device || entry))));
}

/** Update what a computer is allowed to do. Scopes are validated by the caller. */
export async function setDevicePolicy(accountId, deviceId, {scopes, approvedCommands, browserOrigins} = {}) {
  const device = await getDevice(accountId, deviceId);
  if (!device) throw Error('Computer not found');
  if (device.revoked) throw Error('That computer has been disconnected');
  const next = {
    ...device,
    scopes: Array.isArray(scopes) ? scopes : device.scopes,
    approvedCommands: Array.isArray(approvedCommands) ? approvedCommands.map(String).slice(0, 50) : device.approvedCommands,
    ...(browserOrigins !== undefined ? {browserOrigins: cleanBrowserOrigins(browserOrigins)} : {}),
    updatedAt: Date.now()
  };
  await accountStore(DEVICE_STORE, accountId).setJSON('device:' + deviceId, next);
  await casUpdate(accountStore(DEVICE_STORE, accountId), 'index', current => ({
    devices: (current?.devices || []).map(entry => (entry.id === deviceId ? publicDevice(next) : entry))
  }));
  return publicDevice(next);
}

/** Per-origin lists are operators of last resort: every entry must BE a bare https/http origin. */
function cleanBrowserOrigins(value) {
  const clean = list => [...new Set((Array.isArray(list) ? list : []).map(String).filter(origin => {
    try {
      const url = new URL(origin);
      return url.origin === origin && ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password;
    } catch { return false; }
  }))].slice(-MAX_ORIGIN_RECORDS);
  return {allow: clean(value?.allow), deny: clean(value?.deny)};
}

/** Disconnect a computer. Also invalidates any session already issued to it. */
export async function revokeDevice(accountId, deviceId, {now = Date.now(), env = null} = {}) {
  const device = await getDevice(accountId, deviceId);
  if (!device) throw Error('Computer not found');
  const revoked = {...device, revoked: true, revokedAt: now, sessionVersion: (device.sessionVersion || 1) + 1};
  await accountStore(DEVICE_STORE, accountId).setJSON('device:' + deviceId, revoked);
  await casUpdate(accountStore(DEVICE_STORE, accountId), 'index', current => ({
    devices: (current?.devices || []).map(entry => (entry.id === deviceId ? publicDevice(revoked) : entry))
  }));
  const auth = await getStore(DEVICE_AUTH_STORE).get('auth:' + deviceId, {type: 'json', consistency: 'strong'});
  if (auth) {
    await getStore(DEVICE_AUTH_STORE).setJSON('auth:' + deviceId, {
      ...auth, revoked: true, revokedAt: now, sessionVersion: revoked.sessionVersion
    });
  }
  await getStore(DEVICE_AUTH_STORE).delete('session:' + deviceId);
  if (env) {
    const {notifySecurityEventById} = await import('../notifications.js');
    await notifySecurityEventById(accountId, env, {
      headline: 'A computer was disconnected from your account',
      detail: `"${device.name || deviceId}" was revoked and can no longer act for you. Its credentials are burned.`
    });
  }
  return publicDevice(revoked);
}

// --------------------------------------------------------------------------
// Authentication
// --------------------------------------------------------------------------
const fail = (reason, message, status = 401) => Object.assign(Error(message), {reason, status});

/**
 * Verify a device request that presents the long-lived device token.
 *
 * Used only to mint a session. The token arrives as `Authorization: Bearer`,
 * is hashed, and is compared in constant time against the stored hash.
 *
 * @param {Request} req
 * @param {object} [options]
 * @param {boolean} [options.touch] update lastSeenAt (throttled to 60s)
 */
export async function authenticateDevice(req, {now = Date.now(), touch = true} = {}) {
  const deviceId = req.headers.get('x-samvit-device') || '';
  const authorization = req.headers.get('authorization') || '';
  if (!/^[0-9a-f-]{36}$/.test(deviceId)) throw fail('bad_device', 'Device authentication required');
  if (!authorization.startsWith('Bearer ')) throw fail('bad_credential', 'Device authentication required');
  const presented = authorization.slice(7).trim();
  if (presented.length < 16 || presented.length > 200) throw fail('bad_credential', 'Device authentication required');

  // Replay protection: a captured request cannot be re-used inside the window.
  await burnNonce(req, deviceId, {now});

  const authStore = getStore(DEVICE_AUTH_STORE);
  const auth = await authStore.get('auth:' + deviceId, {type: 'json', consistency: 'strong'});
  if (!auth || auth.revoked) throw fail('unknown_device', 'This computer is not connected to Samvit');
  if (!(await tokenMatches(auth.tokenHash, presented))) throw fail('bad_credential', 'Device authentication failed');

  if (touch && (!auth.lastSeenAt || now - auth.lastSeenAt > 60000)) {
    try {
      await authStore.setJSON('auth:' + deviceId, {...auth, lastSeenAt: now});
      const device = await getDevice(auth.accountId, deviceId);
      if (device) await accountStore(DEVICE_STORE, auth.accountId).setJSON('device:' + deviceId, {...device, lastSeenAt: now});
    } catch { /* presence tracking is best-effort */ }
  }

  return {accountId: auth.accountId, deviceId, sessionVersion: auth.sessionVersion || 1};
}

/**
 * Reject a request whose timestamp/nonce has already been seen.
 * A missing nonce is accepted (older clients) but a REPEATED one never is.
 */
async function burnNonce(req, deviceId, {now}) {
  const nonce = req.headers.get('x-samvit-nonce');
  if (!nonce) return;
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(nonce)) throw fail('bad_nonce', 'Device authentication required');
  const timestamp = Number(req.headers.get('x-samvit-timestamp'));
  if (!Number.isFinite(timestamp)) throw fail('bad_timestamp', 'Device authentication required');
  if (Math.abs(now - timestamp) > MAX_CLOCK_SKEW_MS) throw fail('clock_skew', 'Device clock is too far from the server; check the system time');
  await casUpdate(getStore(DEVICE_AUTH_STORE), 'nonce:' + deviceId, current => {
    const items = (Array.isArray(current?.items) ? current.items : []).filter(item => item.exp > now);
    if (items.some(item => item.n === nonce)) throw fail('replay', 'This request was already used');
    return {items: [...items, {n: nonce, exp: now + MAX_CLOCK_SKEW_MS * 2}].slice(-NONCE_WINDOW)};
  });
}

// --------------------------------------------------------------------------
// Short-lived session tokens
// --------------------------------------------------------------------------
/** Exchange a valid signature for a short-lived token used by polling. */
export async function issueSession(accountId, deviceId, {now = Date.now()} = {}) {
  const token = randomToken(24);
  await getStore(DEVICE_AUTH_STORE).setJSON('session:' + deviceId, {
    accountId,
    hash: await sha256Hex(token),
    issuedAt: now,
    expiresAt: now + SESSION_TTL_MS
  });
  return {sessionToken: token, expiresAt: now + SESSION_TTL_MS, ttlMs: SESSION_TTL_MS};
}

export async function verifySession(deviceId, token, {now = Date.now()} = {}) {
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(String(token || ''))) throw fail('bad_session', 'A valid session token is required');
  // Revocation is checked FIRST so a disconnected computer gets the accurate
  // reason rather than a confusing "no session".
  const auth = await getStore(DEVICE_AUTH_STORE).get('auth:' + deviceId, {type: 'json', consistency: 'strong'});
  if (!auth || auth.revoked) throw fail('unknown_device', 'This computer is not connected to Samvit');
  const record = await getStore(DEVICE_AUTH_STORE).get('session:' + deviceId, {type: 'json', consistency: 'strong'});
  if (!record) throw fail('no_session', 'Request a session token first');
  if (record.expiresAt <= now) throw fail('expired_session', 'Session token expired; request a new one');
  if (!(await tokenMatches(record.hash, token))) throw fail('bad_session', 'Session token rejected');
  return {accountId: record.accountId, deviceId, expiresAt: record.expiresAt};
}
