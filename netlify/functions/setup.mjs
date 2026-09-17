// SAMVIT V14 — /api/setup (operator readiness, no ownership checks)
// ------------------------------------------------------------------
// V14 removes the OWNER_CLAIM readiness check entirely: there is no owner,
// so there is nothing hidden to establish. Signup is open and email
// verification is the activation step.
import {emailConfig} from '../lib/email-channel.js';
import {getStore} from '@netlify/blobs';
import {runtimeSecret} from '../lib/runtime-secrets.js';
import {nodeEnv as env, json} from '../lib/new-api.js';

export default async req => {
  if (req.method !== 'GET') return json({error: 'Method not allowed.'}, 405);
  const checks = [];
  for (const [key, purpose] of [['SESSION_SECRET', 'Signs account sessions.'], ['SAMVIT_KEY_ENCRYPTION_SECRET', 'Encrypts your saved provider keys.']]) {
    let ok = false;
    try { ok = (await runtimeSecret(env, key))?.length >= 32; } catch {}
    checks.push({key, required: true, ok, message: ok ? purpose + ' Ready.' : purpose + ' Set 32+ random characters, or enable SAMVIT_AUTO_SECRETS=true with working Netlify Blobs.'});
  }
  let storage = false;
  try { await getStore('samvit-accounts').list({paginate: true}); storage = true; } catch {}
  checks.push({key: 'NETLIFY_BLOBS', required: true, ok: storage, message: storage ? 'Account storage is reachable.' : 'Connect Netlify Blobs before setting up accounts.'});
  let emailReady = false, emailNote = 'Set RESEND_API_KEY, SAMVIT_EMAIL_FROM and HTTPS SAMVIT_PUBLIC_ORIGIN (production), or SAMVIT_EMAIL_PROVIDER=dev for development.';
  try { const provider = emailConfig(env); emailReady = true; emailNote = provider.name === 'dev-capture' ? 'Dev email capture is active. Messages are written to a local outbox — never to real inboxes. Configure Resend for production.' : 'Email delivery is configured (resend); verify delivery with the provider.'; } catch {}
  checks.push({key: 'EMAIL_DELIVERY', required: true, ok: emailReady, message: emailNote});
  return json({ready: checks.filter(c => c.required).every(c => c.ok), checks, demo: 'You can explore the interface without signing in. Account setup requires the configured services.'});
};
export const config = {path: '/api/setup'};
