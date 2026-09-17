// SAMVIT V12 — desktop agent transport.
//
// The agent POLLS; the cloud never dials in. Netlify Functions are
// request-scoped, so there is no way for the cloud to open a connection to
// this computer — and that is the safer shape anyway: no listening port, no
// inbound firewall rule, and revoking the computer is one server-side flag.
//
// Credential use is deliberately layered:
//   deviceToken  long-lived, revocable, used ONLY to mint a session
//   sessionToken 10-minute lifetime, used for polling and reporting
import {randomBytes} from 'node:crypto';

export const AGENT_PATH = '/api/device-agent';

export function createTransport({cloudUrl, deviceId, deviceToken, pollMs = 3000, fetcher = fetch, now = Date.now}) {
  let session = null;

  async function post(payload, {auth}) {
    const body = JSON.stringify(payload);
    const headers = {'content-type': 'application/json'};
    if (deviceId) headers['x-samvit-device'] = deviceId;
    if (auth === 'device') {
      headers.authorization = `Bearer ${deviceToken}`;
      // Replay protection: a captured request cannot be reused.
      headers['x-samvit-timestamp'] = String(now());
      headers['x-samvit-nonce'] = randomBytes(16).toString('base64url');
    } else if (auth === 'session') {
      if (!session) throw Error('No session token has been issued yet');
      headers['x-samvit-session'] = session.token;
    }
    // auth === 'none' (pairing) sends the code in the body and no credential.
    const response = await fetcher(`${cloudUrl}${AGENT_PATH}`, {method: 'POST', headers, body, redirect: 'error'});
    const raw = await response.text();
    let parsed = null;
    try { parsed = raw ? JSON.parse(raw) : null; } catch { /* non-JSON error page */ }
    if (!response.ok) {
      const error = Error(parsed?.error || `Samvit request failed (${response.status})`);
      error.status = response.status;
      throw error;
    }
    return parsed;
  }

  const api = {
    /** Exchange a short-lived pairing code for a device token. Shown once. */
    pair: ({code, deviceName, platform, arch}) =>
      post({action: 'pair', code, deviceName, platform, arch}, {auth: 'none'}),

    /** Refresh the short-lived session token when it is close to expiring. */
    async ensureSession() {
      if (session && session.expiresAt - now() > 60000) return session;
      const result = await post({action: 'session'}, {auth: 'device'});
      session = {token: result.sessionToken, expiresAt: result.expiresAt, policy: result.policy, device: result.device};
      return session;
    },

    /** Claim queued work. Returns {actions, monitors, halted}. */
    async poll() {
      await api.ensureSession();
      return post({action: 'poll'}, {auth: 'session'});
    },

    /** Post one proactive watch signal (P14). Validated + rate-limited server-side. */
    async sendSignal(signal) {
      await api.ensureSession();
      return post({action: 'event', signal}, {auth: 'session'});
    },

    /** Report the real observation AND the result the model needs. */
    async complete(actionId, {observation = null, report = null, error = null} = {}) {
      await api.ensureSession();
      return post({action: 'complete', actionId, observation, report, error}, {auth: 'session'});
    },

    get policy() { return session?.policy || null; },
    get pollMs() { return pollMs; }
  };
  return api;
}
