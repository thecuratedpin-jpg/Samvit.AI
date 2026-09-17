// SAMVIT V14 — ACCOUNT NOTIFICATIONS (P16)
// ------------------------------------------------------------------------
// Best-effort user notification entry points. Every call:
//   * is subject to the recipient's notification preferences
//     (security emails default ON — a user may opt out; mission emails
//     default OFF — a user must opt in),
//   * fails silently into structured logs, never into the request path,
//   * contains no secrets: events are described, token values never are.
import {getStore} from '@netlify/blobs';
import {ACCOUNT_STORE} from './accounts.js';
import {sendSecurityNotification, sendMissionNotification} from './email/service.js';

const prefsOf = account => ({emailMissionNotifications: false, emailSecurityNotifications: true, ...(account?.preferences || {})});

/**
 * Security-relevant account event → email. On by default because it alerts
 * the owner to actions they might not have taken.
 */
export async function notifySecurityEvent(account, env, {headline, detail}) {
  try {
    if (!account?.email || account.emailVerified !== true) return false;
    if (!prefsOf(account).emailSecurityNotifications) return false;
    return (await sendSecurityNotification({to: account.email, headline, detail}, env)).delivered;
  } catch { return false; }
}

/** Convenience: load the account then notify. */
export async function notifySecurityEventById(accountId, env, event) {
  try {
    const account = await getStore(ACCOUNT_STORE).get('account:' + accountId, {type: 'json', consistency: 'strong'});
    return await notifySecurityEvent(account, env, event);
  } catch { return false; }
}

/**
 * Background mission completion → email. Opt-in only (P16), once per job —
 * the caller passes the already-finalized job and we stamp `notifiedAt` so
 * retries cannot double-send.
 */
export async function notifyMissionOutcome(job, env, {store, key, casUpdate, now = Date.now()}) {
  try {
    if (!job?.notification || job.notifiedAt) return false;
    const account = await getStore(ACCOUNT_STORE).get('account:' + job.accountId, {type: 'json', consistency: 'strong'});
    if (!account?.email || account.emailVerified !== true || account.disabled) return false;
    if (!prefsOf(account).emailMissionNotifications) return false;
    const ok = (await sendMissionNotification({
      to: account.email,
      headline: job.status === 'completed' ? 'Mission completed' : 'Mission needs attention',
      goal: job.goal,
      outcome: job.status,
      detail: job.error || String(job.output || '').slice(0, 400)
    }, env, {idempotencyKey: 'samvit-mission-' + job.id})).delivered;
    await casUpdate(store, key, r => r && !r.notifiedAt ? {...r, notifiedAt: now} : r);
    return ok;
  } catch { return false; }
}
