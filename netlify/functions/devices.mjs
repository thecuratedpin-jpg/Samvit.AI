import {authorize,json,readBody,nodeEnv as env} from '../lib/new-api.js';
import {beginPairing,listDevices,revokeDevice,setDevicePolicy} from '../lib/devices/registry.js';
import {listActions,markActionDecision} from '../lib/devices/queue.js';
import {normalizeScopes} from '../../shared/desktop.js';
import {readGlobalStop} from '../lib/intelligence/permissions.js';
// ==========================================================================
// SAMVIT V12 — /api/devices   (the user-facing side of the desktop bridge)
// --------------------------------------------------------------------------
//   GET  /api/devices                       computers + recent actions
//   POST /api/devices {action:'pair'}       issue a short-lived pairing code
//   POST /api/devices {action:'policy'}     set authorised folders + commands
//   POST /api/devices {action:'revoke'}     disconnect a computer
//   POST /api/devices {action:'approve'}    resolve an action awaiting a decision
//
// Nothing here executes anything on a computer. This endpoint only manages
// authorisation; the computer does the work after polling /api/device-agent.
// ==========================================================================
export default async (req, context) => {
  if (!['GET', 'POST'].includes(req.method)) return json({error: 'Method not allowed'}, 405);
  const {auth, response} = await authorize(req, env, context);
  if (response) return response;
  if (auth.open) return json({error: 'Sign in with a verified account to manage computers'}, 403);

  try {
    if (req.method === 'GET') {
      const [devices, actions, global] = await Promise.all([
        listDevices(auth.accountId),
        listActions(auth.accountId, {limit: 20}),
        readGlobalStop()
      ]);
      return json({devices, actions, globalStop: {halted: global.halted === true, reason: global.reason || null}});
    }

    const body = await readBody(req, 32000);
    switch (body.action) {
      case 'pair': {
        const {code, expiresAt} = await beginPairing(auth.accountId);
        return json({
          code,
          expiresAt,
          instructions: `On the computer you want to connect, run:  node agent/pair.js ${code}`,
          note: 'The code is single-use and expires in 5 minutes.'
        });
      }
      case 'policy': {
        if (!body.deviceId) return json({error: '`deviceId` is required.'}, 400);
        const scopes = body.scopes === undefined ? undefined : normalizeScopes(body.scopes);
        const device = await setDevicePolicy(auth.accountId, body.deviceId, {scopes, approvedCommands: body.approvedCommands, browserOrigins: body.browserOrigins});
        return json({device});
      }
      case 'revoke': {
        if (!body.deviceId) return json({error: '`deviceId` is required.'}, 400);
        return json({device: await revokeDevice(auth.accountId, body.deviceId, {env})});
      }
      case 'approve': {
        if (!body.actionId) return json({error: '`actionId` is required.'}, 400);
        return json({action: await markActionDecision(auth.accountId, body.actionId, {approved: body.approved === true})});
      }
      default:
        return json({error: 'Unknown action.'}, 400);
    }
  } catch (error) {
    return json({error: error.message}, 400);
  }
};

export const config = {path: '/api/devices'};
