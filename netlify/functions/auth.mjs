// SAMVIT V14 — /api/auth (P1 ungated registration, P4 hardened sign-in)
// ---------------------------------------------------------------------
// Registration is open: email + password, nothing else. The response is a
// fixed 202 acceptance shape whether the address was new, pending, already
// verified, or unusable — response content must never reveal which.
import {runtimeSecret} from '../lib/runtime-secrets.js';
import {signToken, sessionCookieHeader, SESSION_TTL_MS, checkRateLimit, clientIdentifier, isDevelopmentMode, requireSession} from '../lib/security.js';
import {registerAccount, signInAccount, emailKey, normalizeEmail} from '../lib/accounts.js';
import {enqueueEmail} from '../lib/email-channel.js';
import {getStore} from '@netlify/blobs';
import {readBody, json, nodeEnv as env} from '../lib/new-api.js';

const REGISTER_ACCEPTED = {accepted: true, message: 'If that address can be used, a verification link is on its way. It expires in 30 minutes.'};

export default async (req, context) => {
  if (req.method === 'GET') {
    const auth = await requireSession(req, env);
    return auth.ok ? json({account: {id: auth.accountId, email: auth.email, role: auth.role, emailVerified: auth.emailVerified, preferences: auth.preferences || {emailMissionNotifications: false, emailSecurityNotifications: true}}}) : json({error: auth.message}, auth.status);
  }
  if (req.method !== 'POST') return json({error: 'Method not allowed.'}, 405);
  const origin = req.headers.get('origin');
  if (origin && origin !== new URL(req.url).origin) return json({error: 'Invalid request origin.'}, 403);
  let body;
  try { body = await readBody(req, 5000); } catch { return json({error: 'Enter valid sign-in details.'}, 400); }
  if (body.logout) return new Response(JSON.stringify({ok: true}), {headers: {'content-type': 'application/json', 'cache-control': 'no-store', 'set-cookie': sessionCookieHeader('', {clear: true})}});
  if (!env.get('ACCESS_CODE') && isDevelopmentMode(env) && !body.email) return json({ok: true, open: true});
  let secret;
  try { secret = await runtimeSecret(env, 'SESSION_SECRET'); } catch { return json({error: 'Session storage is unavailable.'}, 503); }
  if (!secret || secret.length < 32) return json({error: 'Account sign-in is not configured. A session secret of at least 32 characters is required.'}, 503);
  try {
    const store = getStore('samvit-ratelimits');
    const isRegister = body.action === 'register';
    const caps = isRegister
      ? [[`account-register:${clientIdentifier(req, context)}`, 3], ['account-kdf-global', 60]]
      : [[`account-login:${clientIdentifier(req, context)}`, 5], ['account-kdf-global', 60]];
    for (const [id, max] of caps) {
      const limit = await checkRateLimit(store, id, {windowMs: 60000, max});
      if (limit.degraded) return json({error: 'Sign-in is temporarily unavailable.'}, 503);
      if (!limit.allowed) return json({error: 'Too many attempts. Try again in a minute.'}, 429);
    }
  } catch { return json({error: 'Sign-in is temporarily unavailable.'}, 503); }

  // ---- Registration: open, ungated, response-shape constant. ----
  if (body.action === 'register') {
    try {
      const registration = await registerAccount(body, env);
      if (!registration.alreadyVerified) {
        await enqueueEmail(registration.email, registration.id, 'verify', env);
      }
    } catch (err) {
      // Weak passwords and malformed emails are the only safe-to-say reasons.
      if (!err.status) return json({error: 'Account setup could not finish. Try again later.'}, 503);
      return json({error: err.message}, err.status);
    }
    return json(REGISTER_ACCEPTED, 202);
  }

  // ---- Sign-in. ----
  try {
    const account = await signInAccount(body, env);
    const token = await signToken(secret, {sub: account.id, version: account.sessionVersion, exp: Date.now() + SESSION_TTL_MS});
    return new Response(JSON.stringify({ok: true, account: {id: account.id, email: account.email, role: account.role, emailVerified: account.emailVerified}}), {
      headers: {'content-type': 'application/json', 'cache-control': 'no-store', 'set-cookie': sessionCookieHeader(token)}
    });
  } catch (err) {
    const status = err.status || 400;
    const payload = {error: status ? err.message : 'Account setup could not finish. Try again later.'};
    if (err.needsVerification) payload.needsVerification = true;
    return json(payload, status);
  }
};
export const config = {path: '/api/auth'};
