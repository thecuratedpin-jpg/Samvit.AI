import {authorize,json,readBody,nodeEnv as env} from '../lib/new-api.js';
import {readSafety,setKillSwitch,readAudit,LEVEL_NAMES,readGlobalStop,setGlobalStop} from '../lib/intelligence/permissions.js';
import {timingSafeEqual} from '../lib/security.js';
// ==========================================================================
// SAMVIT V11/V12 — /api/safety
// --------------------------------------------------------------------------
//   GET  /api/safety   kill-switch state + recent action audit trail
//   POST /api/safety   { halted: boolean, reason?: string }              account
//   POST /api/safety   { global: true, halted, operatorSecret }          deployment
//
// Two brakes, deliberately different in scope:
//
//   ACCOUNT kill switch  — the account holder stops their own workspace.
//                          Observation stays available so they can inspect.
//   GLOBAL stop          — the operator stops the whole deployment, including
//                          every paired computer. Requires an operator secret,
//                          and halts even observation, because every device
//                          capability reaches into someone's real machine.
//
// Turning either one off is itself an authenticated, audited action.
// ==========================================================================
export default async (req, context) => {
  if (!['GET', 'POST'].includes(req.method)) return json({error: 'Method not allowed'}, 405);
  const {auth, response} = await authorize(req, env, context);
  if (response) return response;
  if (auth.open) return json({error: 'Sign in with a verified account to control the safety switch'}, 403);
  try {
    if (req.method === 'GET') {
      const [safety, audit, global] = await Promise.all([readSafety(auth.accountId), readAudit(auth.accountId, 40), readGlobalStop()]);
      return json({safety, levels: LEVEL_NAMES, audit, globalStop: {halted: global.halted === true, reason: global.reason || null, unavailable: global.unavailable === true}});
    }
    const body = await readBody(req, 2000);

    if (body.global === true) {
      const secret = env.get('SAMVIT_OPERATOR_SECRET');
      if (!secret || secret.length < 16) {
        return json({error: 'The global emergency stop is unavailable until SAMVIT_OPERATOR_SECRET (16+ characters) is configured.'}, 503);
      }
      if (!timingSafeEqual(String(body.operatorSecret || ''), secret)) {
        return json({error: 'Operator secret rejected.'}, 403);
      }
      if (typeof body.halted !== 'boolean') return json({error: '`halted` must be true or false.'}, 400);
      const stop = await setGlobalStop({halted: body.halted, reason: body.reason, by: auth.accountId});
      return json({globalStop: stop, message: stop.halted ? 'Emergency stop engaged. Every paired computer and account is halted.' : 'Emergency stop released.'});
    }

    if (typeof body.halted !== 'boolean') return json({error: '`halted` must be true or false.'}, 400);
    const safety = await setKillSwitch(auth.accountId, {halted: body.halted, reason: body.reason, by: auth.accountId});
    return json({safety, message: safety.halted ? 'Kill switch engaged. New state-changing actions are blocked.' : 'Kill switch released. Actions are permitted again.'});
  } catch (error) {
    return json({error: error.message}, 400);
  }
};

export const config = {path: '/api/safety'};
