// ==========================================================================
// SAMVIT V14 — EMAIL SERVICE ABSTRACTION (P3)
// --------------------------------------------------------------------------
// One server-side interface for every email Samvit sends:
//
//   sendVerificationEmail   account verification links (P2)
//   sendPasswordResetEmail  recovery links
//   sendSecurityNotification sign-ins from changes, device pairing/revocation
//   sendMissionNotification  background mission completions (opt-in, P16)
//
// Providers are selected by environment, server-side only:
//
//   RESEND_API_KEY set          -> the Resend provider (production path)
//   SAMVIT_EMAIL_PROVIDER=dev   -> the dev-capture provider (explicit opt-in)
//   nothing configured+dev mode -> dev-capture, loudly labelled
//   nothing configured+prod     -> configuration error (503), NEVER a silent
//                                  pretend-send.
//
// The dev-capture provider writes each message to a blob store so local
// development and the test-suite can read it back — that is the safe local
// verification mechanism the brief allows. Production without a provider
// fails closed.
// ==========================================================================
import {getStore} from '@netlify/blobs';
import {isDevelopmentMode} from '../security.js';

export const DEV_OUTBOX_STORE = 'samvit-email-dev-outbox';
export const MAX_DEV_MESSAGES = 50;

const fail = (message, status = 503) => Object.assign(new Error(message), {status});

/** Resolve the configured provider. Throws (503) when email cannot run. */
export function emailProvider(env) {
  const wanted = (env.get('SAMVIT_EMAIL_PROVIDER') || '').toLowerCase();
  const resendKey = env.get('RESEND_API_KEY');
  const from = env.get('SAMVIT_EMAIL_FROM');
  const origin = publicOrigin(env);

  // A configured production provider ALWAYS wins. An explicit dev request can
  // only capture mail when no real provider is configured — a production
  // deployment can never be accidentally muted into pretend-send mode.
  if (!resendKey && (wanted === 'dev' || isDevelopmentMode(env))) {
    return {name: 'dev-capture', from: from || 'samvit@localhost', origin};
  }
  if (!resendKey) {
    throw fail('Email is not configured for this deployment. Set RESEND_API_KEY (and SAMVIT_EMAIL_FROM), or SAMVIT_EMAIL_PROVIDER=dev for development.');
  }
  if (!from || !/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(from)) {
    throw fail('SAMVIT_EMAIL_FROM must be a plain email address.');
  }
  if (!origin) {
    throw fail('SAMVIT_PUBLIC_ORIGIN must be an HTTPS origin for email links.');
  }
  return {name: 'resend', key: resendKey, from, origin};
}

/** The origin used in links. HTTPS in production; loopback allowed in dev. */
export function publicOrigin(env) {
  const raw = env.get('SAMVIT_PUBLIC_ORIGIN');
  try {
    const url = new URL(raw);
    const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
    if (url.protocol !== 'https:' && !(loopback && isDevelopmentMode(env))) return null;
    if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) return null;
    return url.origin;
  } catch {
    return null;
  }
}

// --------------------------------------------------------------------------
// Delivery
// --------------------------------------------------------------------------

/**
 * The one send entry point. `message` = {to, subject, text}.
 * Returns {delivered, provider, id}. Throws on hard config errors;
 * provider rejections return {delivered:false} so the outbox queue can retry.
 */
export async function deliverEmail(message, env, {fetcher = fetch, idempotencyKey = null} = {}) {
  const provider = emailProvider(env);
  const delivery = {
    from: provider.from,
    to: [message.to],
    subject: String(message.subject || '').slice(0, 200),
    text: String(message.text || '').slice(0, 20000)
  };

  if (provider.name === 'dev-capture') {
    // Real, inspectable delivery into a blob outbox — inspectable by tests
    // and local development, impossible to confuse with a provider send.
    const id = crypto.randomUUID();
    try {
      const store = getStore(DEV_OUTBOX_STORE);
      const existing = await store.get('messages', {type: 'json', consistency: 'strong'});
      const rows = Array.isArray(existing?.rows) ? existing.rows : [];
      rows.push({id, ...delivery, capturedAt: Date.now(), provider: 'dev-capture'});
      await store.setJSON('messages', {rows: rows.slice(-MAX_DEV_MESSAGES)});
    } catch (error) {
      throw fail(`Dev email capture is unavailable: ${error.message}`);
    }
    return {delivered: true, provider: 'dev-capture', id};
  }

  try {
    const response = await fetcher('https://api.resend.com/emails', {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(20000),
      headers: {
        authorization: `Bearer ${provider.key}`,
        'content-type': 'application/json',
        ...(idempotencyKey ? {'idempotency-key': idempotencyKey} : {})
      },
      body: JSON.stringify(delivery)
    });
    const body = await response.json().catch(() => null);
    if (!response.ok || !body?.id) return {delivered: false, provider: 'resend', id: null};
    return {delivered: true, provider: 'resend', id: body.id};
  } catch {
    return {delivered: false, provider: 'resend', id: null};
  }
}

/** Read captured messages (dev provider only). Empty for real providers. */
export async function readDevOutbox() {
  try {
    const record = await getStore(DEV_OUTBOX_STORE).get('messages', {type: 'json', consistency: 'strong'});
    return Array.isArray(record?.rows) ? record.rows : [];
  } catch {
    return [];
  }
}

// --------------------------------------------------------------------------
// Typed senders — the ONLY message shapes Samvit produces
// --------------------------------------------------------------------------
export async function sendVerificationEmail({to, link}, env, options) {
  return deliverEmail({
    to,
    subject: 'Verify your Samvit account',
    text: [
      'Welcome to Samvit.',
      '',
      `Verify this email address to activate your account: ${link}`,
      '',
      'This single-use link expires in 30 minutes. If you did not create a Samvit account, you can ignore this email — nothing will happen.'
    ].join('\n')
  }, env, options);
}

export async function sendPasswordResetEmail({to, link}, env, options) {
  return deliverEmail({
    to,
    subject: 'Reset your Samvit password',
    text: [
      `Reset your Samvit password here: ${link}`,
      '',
      'This single-use link expires in 30 minutes. If you did not ask for a reset, ignore this email — your password stays unchanged.'
    ].join('\n')
  }, env, options);
}

export async function sendSecurityNotification({to, headline, detail}, env, options) {
  return deliverEmail({
    to,
    subject: `Samvit security notice: ${String(headline || 'account change').slice(0, 80)}`,
    text: [
      String(headline || 'A security-relevant change happened on your Samvit account.'),
      '',
      String(detail || '').slice(0, 1500),
      '',
      'If this was not you, sign in and change your password immediately, then review your connected computers.'
    ].join('\n')
  }, env, options);
}

export async function sendMissionNotification({to, headline, goal, outcome, detail}, env, options) {
  return deliverEmail({
    to,
    subject: `Samvit mission: ${String(headline || 'update').slice(0, 80)}`,
    text: [
      String(headline || 'Your background mission has an update.'),
      '',
      goal ? `Goal: ${String(goal).slice(0, 300)}` : '',
      outcome ? `Outcome: ${String(outcome).slice(0, 300)}` : '',
      detail ? String(detail).slice(0, 1000) : '',
      '',
      'Open Samvit for the full mission trace. You can turn mission emails off in Account settings.'
    ].filter(line => line !== '').join('\n')
  }, env, options);
}
