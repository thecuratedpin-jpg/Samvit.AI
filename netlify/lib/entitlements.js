// ==========================================================================
// SAMVIT — ENTITLEMENTS (v4 Priority 5)
// --------------------------------------------------------------------------
// Pure functions deriving what a subscription is currently allowed to do.
// Reads the entitlements/limits normalizeSubscription() already computes
// (shared/models.js, added in v4 Priority 3) rather than re-deriving plan
// capabilities a second time here -- there is exactly one place in this
// codebase that knows "what does plan X unlock" (PLAN_CAPABILITIES in
// shared/models.js), and this file is a thin, safe-to-use wrapper around
// it, not a second copy of it. That's what "do not duplicate subscription
// logic" (the brief's own non-negotiable rule) means in practice here.
//
// Deliberately generic (not council.js-specific) so a future premium
// feature (SAMVIT Prime, Advanced Research, premium agents/automation --
// all explicitly named in the brief as things this should stay reusable
// for) can reuse isSubscriptionActive()/canUseCouncil()'s pattern the same
// way Council does -- see council-access.js for the Council-specific
// request-level check built on top of these.
// ==========================================================================

/**
 * A subscription must be in "active" status to grant ANY entitlement, even
 * if its plan would otherwise qualify. This is the "Subscription
 * Validation" step from Priority 5's brief, kept distinct from the
 * entitlement check below: an Ultra account that's `past_due` still HAS
 * an Ultra plan on record, but shouldn't get Council while payment is
 * failing -- a real, meaningful distinction a real product needs, not
 * just plan-tier gating collapsed into one check. `status` has no real
 * billing lifecycle driving it yet (see shared/models.js's own comment on
 * SUBSCRIPTION_STATUSES), but this check is correct and ready for the day
 * a real payment webhook can actually set it to `past_due`/`canceled`.
 */
export function isSubscriptionActive(subscription) {
  return Boolean(subscription) && subscription.status === "active";
}

/** Does this subscription's PLAN include Council at all -- independent of
 * whether the subscription is currently active? Deliberately separate
 * from canUseCouncil() below: council-access.js needs to tell "your plan
 * doesn't include this" (COUNCIL_UPGRADE_REQUIRED) apart from "your plan
 * would include this, but your subscription isn't currently valid"
 * (COUNCIL_NOT_ENTITLED) -- and it can only make that distinction if the
 * plan-level question can be asked on its own, without status folded in. */
export function planIncludesCouncil(subscription) {
  return Boolean(subscription?.entitlements?.council);
}

/** Can this subscription use AI Council at all, right now? Requires BOTH
 * the subscription to be currently valid (see isSubscriptionActive) AND
 * the plan itself to include Council (see planIncludesCouncil) -- either
 * one failing means no access, so a caller that just wants a single yes/no
 * answer only ever needs this one function. council-access.js calls the
 * two halves separately instead, specifically to produce the right error
 * code for which half failed -- see its own comment. */
export function canUseCouncil(subscription) {
  return isSubscriptionActive(subscription) && planIncludesCouncil(subscription);
}

/**
 * Returns a safe-to-use, fully-resolved set of Council limits for a
 * subscription. Everything is zeroed out (not just `council: false`) when
 * the subscription can't use Council at all, so a caller can't
 * accidentally read a nonzero `maxProviders` off an inactive/ineligible
 * subscription and act on it -- one gate (canUseCouncil) governs every
 * field returned here.
 *
 * `maxCritiqueRounds` is deliberately 0-or-1: there is no multi-round
 * critique concept in the real implementation (council.js's critique
 * step is a single opt-in on/off round -- see its own file comment), so
 * this honestly reflects that as a round *count* rather than inventing
 * support for a feature that doesn't exist. The field exists so a future
 * real multi-round critique feature has a natural, already-plumbed-through
 * place to report a larger number, per the brief's own ask ("the design
 * must allow future limits such as ... Maximum critique rounds") --
 * without Samvit pretending today that number is ever anything but 0 or 1.
 */
export function getCouncilEntitlements(subscription) {
  const allowed = canUseCouncil(subscription);
  const critique = allowed && Boolean(subscription?.entitlements?.councilCritique);
  const maxProviders = allowed ? Number(subscription?.limits?.councilMaxProviders) || 0 : 0;
  return {
    council: allowed,
    councilCritique: critique,
    maxProviders,
    maxCritiqueRounds: critique ? 1 : 0,
  };
}

import { normalizeSubscription } from '../../shared/models.js';
export function getEntitlements(value) {
  const sub = typeof value === 'string' ? normalizeSubscription({planId:value}) : value;
  const active = isSubscriptionActive(sub);
  const council = getCouncilEntitlements(sub);
  return { features: {council:council.council, councilCritique:council.councilCritique, advanced_analytics:active && Boolean(sub?.entitlements?.advancedAnalytics)}, limits: {...sub?.limits, councilMaxProviders:council.maxProviders} };
}
