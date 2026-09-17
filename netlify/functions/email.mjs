// SAMVIT V14 — /api/email (P2 verification / recovery / re-enable)
// ------------------------------------------------------------------
// action=complete  {token, kind, newPassword?}  — consume a single-use
//   challenge. `verify` activates the account (no password required);
//   `reset`/`enable` require a new password.
// action=verify|reset|enable {email}  — request a link. The response is the
//   same acceptance shape for known, unknown, verified, and nonexistent
//   addresses (enumeration resistance), with a per-account resend cooldown
//   enforced at enqueue.
import {getStore} from '@netlify/blobs';
import {json, readBody, nodeEnv as env} from '../lib/new-api.js';
import {normalizeEmail, emailKey, ACCOUNT_STORE} from '../lib/accounts.js';
import {accountLimits} from '../lib/account-limits.js';
import {emailConfig, enqueueEmail, consumeEmailToken} from '../lib/email-channel.js';

export default async (req, context) => {
  if (req.method !== 'POST') return json({error: 'Method not allowed.'}, 405);
  if (req.headers.get('origin') && req.headers.get('origin') !== new URL(req.url).origin) return json({error: 'Invalid request origin.'}, 403);
  try {
    emailConfig(env); // fail closed when email cannot run at all
    await accountLimits(req, context);
    const b = await readBody(req, 5000);
    if (b.action === 'complete') {
      await consumeEmailToken(b.token, b.kind, {newPassword: b.newPassword || null});
      return json({ok: true, message: b.kind === 'verify' ? 'Email verified. You can sign in now.' : 'Account confirmed. Sign in using your new password.'});
    }
    if (!['verify', 'reset', 'enable'].includes(b.action)) return json({error: 'Invalid email action.'}, 400);
    const email = normalizeEmail(b.email);
    const index = await getStore(ACCOUNT_STORE).get(await emailKey(email), {type: 'json', consistency: 'strong'});
    return json(await enqueueEmail(email, index?.id || null, b.action, env), 202);
  } catch (e) {
    return json({error: e.status ? e.message : 'Account email service is unavailable. Try again later.'}, e.status || 503);
  }
};
export const config = {path: '/api/email'};
