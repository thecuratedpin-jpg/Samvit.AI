// SAMVIT V14 — EMAIL CHANNEL (durable outbox + verification challenges)
// --------------------------------------------------------------------
// Durable outbox (leases, attempts, idempotency keys) kept from V12/V13 —
// the response-uniformity it gives is what makes /api/email
// enumeration-resistant: unknown addresses do the same work as known ones.
// What changed for V14:
//   * Delivery goes through lib/email/service.js — a provider abstraction
//     (resend | dev-capture) selected by environment. Never a pretend-send.
//   * Verification is its own challenge: `kind=verify` confirms the inbox and
//     activates the account WITHOUT forcing a password change. `reset` and
//     `enable` are the only kinds that take a new password.
//   * Resend has a per-account cooldown + daily cap (P2), applied at enqueue,
//     and the worker suppresses stale jobs (e.g. already verified) rather
//     than sending anything at all.
//   * Tokens stay crypto-random, SHA-256-hashed at rest, single-use (burned
//     on consume), 30-minute, and are never logged or returned to clients.
import {getStore} from '@netlify/blobs';
import {casUpdate} from './storage/concurrency.js';
import {sealKey, openKey} from './connection-store.js';
import {listKeys} from './store-inventory.js';
import {hashPassword, validatePassword} from './passwords.js';
import {resendAllowed, noteVerificationSent, provisionVerifiedAccount, ACCOUNT_STORE} from './accounts.js';
import {emailProvider, sendVerificationEmail, sendPasswordResetEmail} from './email/service.js';

export const EMAIL_STORE = 'samvit-email-outbox';
export const CHALLENGE_TTL_MS = 30 * 60 * 1000;
export const MAX_DELIVERY_ATTEMPTS = 5;

export const acceptedEmail = {
  accepted: true,
  message: 'If that address can be used, the email is on its way. It may take a few minutes to arrive.'
};

const digest = async s => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))), b => b.toString(16).padStart(2, '0')).join('');

/** Back-compat alias: is email runnable at all? (throws 503 when not) */
export function emailConfig(env) { return emailProvider(env); }

/**
 * Queue an account email. Always answers the same acceptance shape; sends
 * nothing for unknown addresses beyond bookkeeping. `kind` ∈ verify|reset|enable.
 */
export async function enqueueEmail(to, accountId, kind, env, {now = Date.now()} = {}) {
  emailProvider(env); // fail closed when email cannot run at all
  if (kind === 'verify' && accountId) {
    const account = await getStore(ACCOUNT_STORE).get('account:' + accountId, {type: 'json', consistency: 'strong'});
    if (account && !account.deleting) {
      const gate = resendAllowed(account, {now});
      if (!gate.allowed) return acceptedEmail; // cooldown, daily cap, or already verified
      await noteVerificationSent(accountId, {now});
    }
  }
  const id = crypto.randomUUID();
  const payload = await sealKey(JSON.stringify({to, accountId, kind, at: now}), env, 'email:' + id);
  await casUpdate(getStore(EMAIL_STORE), id, r => r || {id, accountId, payload, status: 'pending', attempts: 0, createdAt: now});
  return acceptedEmail;
}

/** Mint a single-use challenge for an account. Returns `usr_id.raw` — the ONLY place the raw exists. */
export async function issueEmailToken(accountId, kind, now = Date.now()) {
  const raw = Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2, '0')).join('');
  const hash = await digest(raw);
  await casUpdate(getStore(ACCOUNT_STORE), 'account:' + accountId, r => {
    if (!r || r.deleting) throw Error('Account unavailable');
    return {...r, emailChallenges: {
      ...Object.fromEntries(Object.entries(r.emailChallenges || {}).filter(([, v]) => v.expiresAt > now).slice(-4)),
      [hash]: {kind, expiresAt: now + CHALLENGE_TTL_MS, version: r.sessionVersion}
    }};
  });
  return accountId + '.' + raw;
}

/**
 * Consume a challenge. Single-use: a successful consume burns every live
 * challenge and bumps the session version, so a replayed link dies with the
 * session cohort that minted it. New passwords are only involved for
 * `reset` and `enable`; `verify` is pure inbox confirmation (P2).
 */
export async function consumeEmailToken(token, kind, {newPassword = null, now = Date.now()} = {}) {
  if (typeof token !== 'string' || !/^usr_[a-f0-9-]{36}\.[a-f0-9]{64}$/.test(token) || !['verify', 'reset', 'enable'].includes(kind)) {
    throw Object.assign(Error('Invalid or expired link.'), {status: 400});
  }
  let password = null;
  if (kind === 'verify') {
    if (typeof newPassword === 'string' && newPassword.length) {
      // Accept-but-equal: a password supplied on verify is set just like a reset.
      validatePassword(newPassword);
      password = await hashPassword(newPassword);
    }
  } else {
    validatePassword(newPassword);
    password = await hashPassword(newPassword);
  }
  const [id, raw] = token.split('.');
  const hash = await digest(raw);
  const {value: account} = await casUpdate(getStore(ACCOUNT_STORE), 'account:' + id, r => {
    const challenge = r?.emailChallenges?.[hash];
    if (!r || r.deleting || !challenge || challenge.kind !== kind || challenge.expiresAt <= now || challenge.version !== r.sessionVersion) {
      throw Object.assign(Error('Invalid or expired link.'), {status: 400});
    }
    if (r.disabled && kind !== 'enable') {
      throw Object.assign(Error('Account disabled. Use the re-enable email flow.'), {status: 400});
    }
    return {
      ...r,
      ...(password ? {password} : {}),
      emailVerified: true,
      emailVerifiedAt: now,
      disabled: kind === 'enable' ? false : r.disabled,
      sessionVersion: r.sessionVersion + 1,
      emailChallenges: {},
      signinFailures: 0,
      lockoutUntil: 0,
      updatedAt: now
    };
  });
  // Verification activates the workspace allowance. No ownership bootstrap:
  // every verified account gets the same free baseline, only-if-new.
  if (kind === 'verify') await provisionVerifiedAccount(id);
  return account;
}

/** Is this job's delivery still warranted? Unknown/stale cases are suppressed silently. */
function deliveryGate(account, kind) {
  if (!account || account.deleting) return false;
  if (kind === 'verify') return account.emailVerified !== true && !account.disabled;
  if (kind === 'enable') return account.disabled === true;
  return !account.disabled; // reset
}

export async function deliverQueuedEmail(job, env, {now = Date.now(), fetcher = fetch} = {}) {
  const store = getStore(EMAIL_STORE);
  const lease = crypto.randomUUID();
  const {value: held} = await casUpdate(store, job.id, r => {
    if (!r || r.status === 'sent' || r.status === 'suppressed' || r.leaseUntil > now || r.attempts >= MAX_DELIVERY_ATTEMPTS) return r;
    return {...r, status: 'sending', lease, leaseUntil: now + 120000, attempts: r.attempts + 1};
  });
  if (held?.lease !== lease) return false;
  try {
    const payload = JSON.parse(await openKey(held.payload, env, 'email:' + job.id));
    const kind = payload.kind === 'register' ? 'verify' : payload.kind; // legacy jobs
    const account = payload.accountId
      ? await getStore(ACCOUNT_STORE).get('account:' + payload.accountId, {type: 'json', consistency: 'strong'})
      : null;
    if (!deliveryGate(account, kind)) {
      await casUpdate(store, job.id, r => r?.lease === lease ? {...r, status: 'suppressed', lease: null, leaseUntil: 0, payload: null, suppressedAt: Date.now()} : r);
      return true;
    }
    const {origin} = emailProvider(env);
    const link = origin + '/#email?kind=' + kind + '&token=' + encodeURIComponent(await issueEmailToken(account.id, kind));
    const sender = kind === 'verify' ? sendVerificationEmail : sendPasswordResetEmail;
    const result = await sender({to: payload.to, link}, env, {idempotencyKey: 'samvit-email-' + job.id, fetcher});
    if (!result.delivered) throw Error('Email provider could not deliver.');
    await casUpdate(store, job.id, r => r?.lease === lease ? {...r, status: 'sent', lease: null, leaseUntil: 0, payload: null, sentAt: Date.now(), provider: result.provider} : r);
    return true;
  } catch {
    await casUpdate(store, job.id, r => r?.lease === lease ? {...r, status: 'failed', lease: null, leaseUntil: 0, lastError: 'Email delivery failed; check provider configuration.'} : r);
    return false;
  }
}

export async function runEmailQueue(env) {
  const store = getStore(EMAIL_STORE);
  let count = 0;
  for await (const key of listKeys(store)) {
    const job = await store.get(key, {type: 'json', consistency: 'strong'});
    if (job && job.status !== 'sent' && job.status !== 'suppressed' && job.attempts < MAX_DELIVERY_ATTEMPTS) {
      await deliverQueuedEmail(job, env);
      if (++count >= 10) break;
    }
  }
  return count;
}
