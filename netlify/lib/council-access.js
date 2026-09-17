// ==========================================================================
// SAMVIT — COUNCIL ACCESS CHECK (v4 Priority 5)
// --------------------------------------------------------------------------
// The single place council.js asks "is this account allowed to run THIS
// Council request" -- subscription retrieval + subscription validation +
// entitlement check + Council's own plan-scoped limits (provider count,
// critique), combined into one call so council.js's handler doesn't
// re-implement this sequencing itself, and so any future premium endpoint
// reusing this service gets the exact same ordering for free. Mirrors the
// brief's own architecture diagram:
//
//   Authentication -> Subscription Service -> Entitlement Service
//     -> Council Access Check -> Rate Limiter -> AI Council -> Providers
//
// Deliberately does NOT perform authentication -- requireSession() already
// covers that identically for every endpoint (chat/council/workflow/...),
// and re-implementing it here would be exactly the kind of duplicated
// auth/subscription logic the brief says not to do. This module starts
// from an already-authenticated `accountId`.
// ==========================================================================
import { getSubscription, isSubscriptionServiceUnavailable } from "./subscriptions.js";
import { getCouncilEntitlements, isSubscriptionActive, planIncludesCouncil } from "./entitlements.js";

// "Examples" per the brief's own error-handling section, not an exhaustive
// enum -- these add two more, similarly safe codes for the other genuinely
// distinct reasons a request gets denied here. Every one of these is safe
// to return to the client as-is: none names an internal constant, a
// stored value, or anything about any OTHER account.
export const COUNCIL_ERRORS = {
  NOT_ENTITLED: "COUNCIL_NOT_ENTITLED", // subscription isn't currently active/valid (e.g. past_due/canceled), even if the plan would otherwise qualify
  UPGRADE_REQUIRED: "COUNCIL_UPGRADE_REQUIRED", // plan itself doesn't include Council (free/pro)
  PROVIDER_LIMIT_EXCEEDED: "COUNCIL_PROVIDER_LIMIT_EXCEEDED", // asked for more providers than the plan allows
  CRITIQUE_NOT_ENTITLED: "COUNCIL_CRITIQUE_NOT_ENTITLED", // asked for the critique round without plan support
  // v4 Priority 5 (production-hardening pass): the subscription STORE
  // itself was unreachable, not "this account has no paid plan." Kept
  // distinct from UPGRADE_REQUIRED for the same reason NOT_ENTITLED is
  // kept distinct from UPGRADE_REQUIRED -- telling a possibly-genuinely-
  // entitled caller "try again shortly" is more honest, and more useful
  // support signal, than telling them "upgrade your plan" when we simply
  // couldn't verify what plan they're already on. Never returned for a
  // "no record found yet" account (see subscriptions.js's own comment on
  // the distinction) -- only for a real infra failure.
  SERVICE_UNAVAILABLE: "COUNCIL_SUBSCRIPTION_UNAVAILABLE",
};

/**
 * The pure decision core, given an ALREADY-RETRIEVED subscription. Split
 * out from authorizeCouncilRequest() below specifically so every branch is
 * directly unit-testable against a hand-built subscription object -- the
 * same way entitlements.test.js tests getCouncilEntitlements() -- without
 * needing to round-trip a hypothetical shape through getSubscription().
 * That matters because getSubscription() deliberately RE-DERIVES
 * entitlements/limits from the real plan table on every read (see
 * subscriptions.js's own comment on why that's correct, not a gap), which
 * means a store can never be made to produce a plan/entitlement
 * combination that today's real PLAN_CAPABILITIES table doesn't actually
 * have -- so a couple of branches below (the provider-limit and
 * critique-not-entitled checks) are, honestly, unreachable through the
 * store-backed path with any of TODAY's real plans, the same documented
 * situation as ai-limits.js's provider-window backstop (see its own
 * comment) and this same file's PROVIDER_LIMIT_EXCEEDED branch. Exporting
 * this pure function is what makes their comparison logic itself provable
 * anyway -- see council-access.test.js.
 *
 * Order matters and is deliberate: plan-level entitlement is checked
 * BEFORE subscription status, so a Free/Pro account that also happens to
 * be past_due still gets COUNCIL_UPGRADE_REQUIRED (the plan itself is the
 * reason), while an Ultra/Ultimate account that's past_due gets
 * COUNCIL_NOT_ENTITLED (the plan would qualify; the subscription
 * currently doesn't) -- this is the real, distinct value of the brief's
 * "Subscription Validation" step existing separately from "Entitlement
 * Check" (see entitlements.js's planIncludesCouncil/isSubscriptionActive).
 *
 * @param {object} subscription  A normalized Subscription record (see shared/models.js).
 * @param {{providerCount?: number, critiqueRequested?: boolean}} request  Only the SHAPE of the request that matters for entitlement -- never plan/entitlement values themselves (those are never trusted from the client).
 * @returns {
 *   {ok: true, subscription: object, entitlements: object} |
 *   {ok: false, status: number, error: string, reason: string, subscription: object, entitlements?: object}
 * }
 *   `error` is the safe, client-facing code (see COUNCIL_ERRORS above).
 *   `reason` is a human-readable detail for SERVER-SIDE logging only --
 *   callers must never put `reason` in an HTTP response body (see the
 *   brief's "do not expose internal subscription data" requirement).
 */
export function decideCouncilAccess(subscription, { providerCount = 0, critiqueRequested = false } = {}) {
  // v4 Priority 5 (production-hardening pass): checked FIRST, before any
  // entitlement logic -- a subscription resolved from a broken/unreachable
  // store is not a real "this account's plan is X" answer at all, so it
  // must never be allowed to fall through into the normal plan/status
  // comparisons below, even though the fallback subscription's SHAPE looks
  // just like a real (if unentitled) free account. See subscriptions.js's
  // getSubscription()/isSubscriptionServiceUnavailable() for exactly what
  // sets this and why it's kept distinct from "no record found."
  if (isSubscriptionServiceUnavailable(subscription)) {
    return {
      ok: false,
      status: 503,
      error: COUNCIL_ERRORS.SERVICE_UNAVAILABLE,
      reason: "subscription store unavailable -- failed closed, not treated as an entitlement decision",
      subscription,
    };
  }

  if (!planIncludesCouncil(subscription)) {
    return {
      ok: false,
      status: 403,
      error: COUNCIL_ERRORS.UPGRADE_REQUIRED,
      reason: `plan "${subscription?.planId}" does not include Council`,
      subscription,
    };
  }

  if (!isSubscriptionActive(subscription)) {
    return {
      ok: false,
      status: 403,
      error: COUNCIL_ERRORS.NOT_ENTITLED,
      reason: `subscription status is "${subscription?.status}", not active`,
      subscription,
    };
  }

  // Both checks above passed, so canUseCouncil(subscription) is guaranteed
  // true here -- getCouncilEntitlements() re-derives that internally, but
  // never returns anything nonzero unless it independently agrees.
  const entitlements = getCouncilEntitlements(subscription);

  if (providerCount > entitlements.maxProviders) {
    return {
      ok: false,
      status: 403,
      error: COUNCIL_ERRORS.PROVIDER_LIMIT_EXCEEDED,
      reason: `requested ${providerCount} providers, plan "${subscription.planId}" allows ${entitlements.maxProviders}`,
      subscription,
      entitlements,
    };
  }

  if (critiqueRequested && !entitlements.councilCritique) {
    return {
      ok: false,
      status: 403,
      error: COUNCIL_ERRORS.CRITIQUE_NOT_ENTITLED,
      reason: `plan "${subscription.planId}" does not include the critique round`,
      subscription,
      entitlements,
    };
  }

  return { ok: true, subscription, entitlements };
}

/**
 * The real, store-backed entry point council.js calls: resolves the
 * account's actual subscription (see subscriptions.js's getSubscription --
 * fail-closed, never throws) and hands it to decideCouncilAccess() above.
 * Kept as a thin wrapper so there is exactly one place that combines
 * "which subscription" with "what does it decide" -- see that function's
 * own comment for why the two are split.
 *
 * @param {object} store  Netlify Blobs store (getStore(SUBSCRIPTION_STORE_NAME))
 * @param {string} accountId  From requireSession()'s resolved accountId -- never from the request body/headers/query.
 * @param {{get(key:string):string|undefined}} env
 * @param {{providerCount?: number, critiqueRequested?: boolean}} request
 * @returns {Promise<ReturnType<typeof decideCouncilAccess>>}
 */
export async function authorizeCouncilRequest(store, accountId, env, request = {}) {
  const subscription = await getSubscription(store, accountId, env);
  return decideCouncilAccess(subscription, request);
}
