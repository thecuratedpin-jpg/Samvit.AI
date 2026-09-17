// ==========================================================================
// SAMVIT V14 — ACCOUNTS (P1: production identity, P4: hardening)
// --------------------------------------------------------------------------
// The account model in plain terms:
//
//   * Anyone may register with an email and password. There is NO invitation
//     code, NO owner-claim code, and NO "first user becomes the owner"
//     bootstrap. Registration itself is ungated; *email verification* is the
//     proof that activates the account.
//   * The authenticated account is the identity boundary. Nothing inherits
//     authority from creation order. Administrative access, where it exists,
//     is operator-configured (SAMVIT_ADMIN_EMAILS), never claimed.
//   * Sign-in hardening: per-account failure counting with a timed lockout
//     on top of the IP rate limits in the function layer, a constant-shape
//     "Email or password is incorrect" for every failure, and a dummy KDF
//     run for unknown emails (via passwords.js) so timing leaks less.
// ==========================================================================
import {getStore} from '@netlify/blobs';
import {casUpdate} from './storage/concurrency.js';
import {hashPassword, verifyPassword, validatePassword} from './passwords.js';
import {normalizeSubscription, SUBSCRIPTION_STORE_NAME} from './subscriptions.js';

export const ACCOUNT_STORE = 'samvit-accounts';

// Lockout: 8 consecutive failures puts the account on a timed hold. This is
// deliberately per-account as well as per-IP (the function layer): a botnet
// rotating addresses must not get unlimited guesses at one inbox.
export const MAX_SIGNIN_FAILURES = 8;
export const SIGNIN_LOCKOUT_MS = 15 * 60 * 1000;
// Resend cooldown for verification email (per account).
export const VERIFY_RESEND_COOLDOWN_MS = 60 * 1000;
export const VERIFY_RESEND_DAILY_CAP = 6;

export function normalizeEmail(value) {
  if (typeof value !== 'string' || value.length > 254 || !/^\S+@[^\s@]+\.[^\s@]+$/.test(value)) throw new Error('Enter a valid email address.');
  return value.trim().toLowerCase();
}

export async function emailKey(email) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(email));
  return 'email:' + Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');
}

const DEFAULT_PREFERENCES = Object.freeze({emailMissionNotifications: false, emailSecurityNotifications: true});

/** Is this address an operator-designated administrator? Config, not claim. */
export function isAdminEmail(email, env) {
  const list = (env.get('SAMVIT_ADMIN_EMAILS') || '').split(',').map(entry => entry.trim().toLowerCase()).filter(Boolean);
  return list.includes(String(email || '').toLowerCase());
}

/**
 * Register: create an UNVERIFIED account. No invitation, no owner claim, no
 * exceptions. Duplicate addresses resolve to the same account id (the claim
 * index) without revealing which case occurred — the caller always responds
 * with the same generic acceptance message.
 *
 * @returns {Promise<{id: string, email: string, created: boolean, alreadyVerified: boolean}>}
 */
export async function registerAccount(body, env) {
  const email = normalizeEmail(body.email);
  validatePassword(body.password);
  const password = await hashPassword(body.password);
  const store = getStore(ACCOUNT_STORE);
  const index = await emailKey(email);
  const id = 'usr_' + crypto.randomUUID();
  const account = {
    id,
    email,
    password,
    sessionVersion: 1,
    createdAt: Date.now(),
    disabled: false,
    emailVerified: false,
    signinFailures: 0,
    lockoutUntil: 0,
    preferences: {...DEFAULT_PREFERENCES},
    admin: isAdminEmail(email, env)
  };
  const {value: claimed} = await casUpdate(store, index, r => r || {id});
  const existing = await store.get('account:' + claimed.id, {type: 'json', consistency: 'strong'});
  if (existing) {
    return {id: claimed.id, email: existing.email, created: false, alreadyVerified: existing.emailVerified === true};
  }
  const deleted = await getStore('samvit-account-deletions').get(claimed.id, {type: 'json', consistency: 'strong'});
  if (!deleted) {
    await casUpdate(store, 'account:' + claimed.id, r => r || {...account, id: claimed.id});
  }
  return {id: claimed.id, email, created: true, alreadyVerified: false};
}

/**
 * Completion of account construction after email verification. There is no
 * ownership bootstrap: the verified account is simply active, gets the free
 * workspace allowance (only-if-new), and that's all.
 */
export async function provisionVerifiedAccount(accountId, env) {
  await getStore(SUBSCRIPTION_STORE_NAME).setJSON(
    'sub:' + accountId,
    normalizeSubscription({planId: 'free'}),
    {onlyIfNew: true}
  );
}

export function accountRole(account, env) {
  if (!account || account.emailVerified !== true) return 'unverified';
  return account.admin === true || isAdminEmail(account.email, env) ? 'admin' : 'member';
}

/** Generic credential failure — the same words for every failure mode. */
const badCredentials = () => Object.assign(new Error('Email or password is incorrect.'), {status: 400});

/**
 * Sign in with email + password. Unverified accounts CANNOT use Samvit:
 * verification of the inbox is the activation step (P2). A correct password
 * on an unverified account is therefore an error that points at resending —
 * it is not a session.
 */
export async function signInAccount(body, env, {now = Date.now()} = {}) {
  const email = normalizeEmail(body.email);
  const store = getStore(ACCOUNT_STORE);
  const claim = await store.get(await emailKey(email), {type: 'json', consistency: 'strong'});
  const current = claim ? await store.get('account:' + claim.id, {type: 'json', consistency: 'strong'}) : null;

  const passwordOk = await verifyPassword(body.password, current?.password);
  if (!current || current.deleting || !passwordOk) {
    if (current && !current.deleting) await noteSignInFailure(current, {now});
    throw badCredentials();
  }
  if (current.disabled) throw Object.assign(new Error('This account is disabled. Use the email recovery flow to re-enable it.'), {status: 403});
  if (Number(current.lockoutUntil) > now) {
    throw Object.assign(new Error('Too many failed attempts. This account is temporarily locked; use the password reset flow or wait.'), {status: 429});
  }
  // Success: clear any failure counter, then gate on verification.
  if (current.signinFailures || current.lockoutUntil) {
    try {
      await casUpdate(store, 'account:' + current.id, r => r ? {...r, signinFailures: 0, lockoutUntil: 0} : r);
    } catch { /* best-effort hygiene; never block sign-in on it */ }
  }
  if (current.emailVerified !== true) {
    throw Object.assign(
      new Error('Verify your email before signing in. Use "Verify email, reset password" below to resend the verification link.'),
      {status: 403, needsVerification: true, accountId: current.id}
    );
  }
  return {id: current.id, email: current.email, emailVerified: true, sessionVersion: current.sessionVersion, role: accountRole(current, env)};
}

async function noteSignInFailure(account, {now}) {
  try {
    await casUpdate(getStore(ACCOUNT_STORE), 'account:' + account.id, r => {
      if (!r) return r;
      const count = (r.signinFailures || 0) + 1;
      return {...r, signinFailures: count, lockoutUntil: count >= MAX_SIGNIN_FAILURES ? now + SIGNIN_LOCKOUT_MS : 0};
    });
  } catch { /* the failure counter is defence in depth, never a login blocker */ }
}

/** Resend bookkeeping for the verification email (P2). Pure decisions here. */
export function resendAllowed(account, {now = Date.now()} = {}) {
  if (!account) return {allowed: true}; // unknown address: generic acceptance, nothing sent
  if (account.emailVerified === true) return {allowed: false, reason: 'already_verified'};
  const dayAgo = now - 86400000;
  const sends = (Array.isArray(account.verifyEmailSends) ? account.verifyEmailSends : []).filter(at => at > dayAgo);
  const last = sends.at(-1) || 0;
  if (now - last < VERIFY_RESEND_COOLDOWN_MS) return {allowed: false, reason: 'cooldown', retryAfterMs: VERIFY_RESEND_COOLDOWN_MS - (now - last)};
  if (sends.length >= VERIFY_RESEND_DAILY_CAP) return {allowed: false, reason: 'daily_cap'};
  return {allowed: true};
}

export async function noteVerificationSent(accountId, {now = Date.now()} = {}) {
  await casUpdate(getStore(ACCOUNT_STORE), 'account:' + accountId, r => {
    if (!r) return r;
    const dayAgo = now - 86400000;
    const sends = (Array.isArray(r.verifyEmailSends) ? r.verifyEmailSends : []).filter(at => at > dayAgo);
    return {...r, verifyEmailSends: [...sends, now].slice(-VERIFY_RESEND_DAILY_CAP)};
  });
}
