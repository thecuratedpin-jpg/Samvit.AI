import {json,nodeEnv as env} from '../lib/new-api.js';
import {checkRateLimit,clientIdentifier} from '../lib/security.js';
import {getStore} from '@netlify/blobs';
import {completePairing,authenticateDevice,issueSession,verifySession,getDevice} from '../lib/devices/registry.js';
import {claimActions,completeAction,DEFAULT_LEASE_MS} from '../lib/devices/queue.js';
import {readGlobalStop} from '../lib/intelligence/permissions.js';
// ==========================================================================
// SAMVIT V12 — /api/device-agent   (the paired computer's side)
// --------------------------------------------------------------------------
// The cloud cannot dial a process on the user's machine — Netlify Functions
// are request-scoped — so the agent polls this endpoint. That is also the
// safer shape: no listening port on the user's PC, no inbound firewall rule,
// and revoking a computer is one server-side flag.
//
//   POST {action:'pair'}      redeem a pairing code          (code is the credential)
//   POST {action:'session'}   signature -> short-lived token (signature auth)
//   POST {action:'poll'}      claim queued actions           (session auth)
//   POST {action:'complete'}  report real observations       (session auth)
//
// Every request carries a structured capability. There is no endpoint here
// that accepts a shell string, and none that accepts a raw filesystem call.
// ==========================================================================
const pairRateLimit = async (req, context) => {
  try {
    const result = await checkRateLimit(getStore('samvit-ratelimits'), `device-pair:${clientIdentifier(req, context)}`, {windowMs: 60000, max: 10});
    return result.allowed === true;
  } catch {
    return false; // fail closed: pairing is the one credential-guessing surface
  }
};

const sessionIdentity = async req => {
  const deviceId = req.headers.get('x-samvit-device') || '';
  const session = req.headers.get('x-samvit-session') || '';
  return verifySession(deviceId, session);
};

export default async (req, context) => {
  if (req.method !== 'POST') return json({error: 'Method not allowed'}, 405);

  const raw = await req.text();
  let body;
  try {
    body = raw ? JSON.parse(raw) : {};
  } catch {
    return json({error: 'Malformed request body.'}, 400);
  }
  if (!body || typeof body !== 'object') return json({error: 'Malformed request body.'}, 400);

  try {
    if (body.action === 'pair') {
      if (!(await pairRateLimit(req, context))) return json({error: 'Too many pairing attempts. Try again shortly.'}, 429);
      const result = await completePairing({
        code: body.code,
        deviceName: body.deviceName,
        platform: body.platform,
        arch: body.arch
      }, {env});
      return json({
        deviceId: result.deviceId,
        deviceToken: result.deviceToken,
        device: result.device,
        note: 'Store the token securely. It is shown once and cannot be retrieved again.'
      }, 201);
    }

    if (body.action === 'session') {
      const identity = await authenticateDevice(req);
      const device = await getDevice(identity.accountId, identity.deviceId);
      if (!device) return json({error: 'This computer is not connected to Samvit'}, 401);
      const session = await issueSession(identity.accountId, identity.deviceId);
      return json({
        ...session,
        device: {id: device.id, name: device.name, revoked: device.revoked},
        // The agent enforces this locally too — defence in depth, so a bug or
        // a compromise on the cloud side cannot widen what the PC will do.
        policy: {scopes: device.scopes || [], approvedCommands: device.approvedCommands || []}
      });
    }

    const identity = await sessionIdentity(req);
    const global = await readGlobalStop();

    if (body.action === 'poll') {
      // While a stop is engaged the agent is told to stop taking new work,
      // but can still report on anything already in flight.
      if (global.halted) return json({actions: [], halted: true, reason: global.reason || 'Emergency stop is engaged'});
      const actions = await claimActions(identity.accountId, identity.deviceId, {
        limit: 5,
        leaseMs: DEFAULT_LEASE_MS
      });
      return json({
        actions: actions.map(action => ({
          id: action.id,
          capability: action.capability,
          args: action.args,
          expected: action.expected
        })),
        leaseMs: DEFAULT_LEASE_MS,
        halted: false
      });
    }

    if (body.action === 'complete') {
      if (!body.actionId) return json({error: '`actionId` is required.'}, 400);
      const record = await completeAction(identity.accountId, identity.deviceId, body.actionId, {
        observation: body.observation || null,
        report: body.report || null,
        error: body.error || null
      });
      return json({ok: true, verification: record.verification, status: record.status});
    }

    return json({error: 'Unknown action.'}, 400);
  } catch (error) {
    return json({error: error.message}, error.status || 400);
  }
};

export const config = {path: '/api/device-agent'};
