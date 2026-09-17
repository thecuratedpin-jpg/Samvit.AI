export const BILLING_EVENT_TYPES = {
  CHECKOUT_COMPLETED: "checkout.session.completed",
  SUBSCRIPTION_CREATED: "customer.subscription.created",
  SUBSCRIPTION_UPDATED: "customer.subscription.updated",
  SUBSCRIPTION_DELETED: "customer.subscription.deleted",
  INVOICE_PAYMENT_FAILED: "invoice.payment_failed",
  INVOICE_PAYMENT_SUCCEEDED: "invoice.payment_succeeded",
};

const SUBSCRIPTION_EVENT_TYPES = new Set([
  BILLING_EVENT_TYPES.SUBSCRIPTION_CREATED,
  BILLING_EVENT_TYPES.SUBSCRIPTION_UPDATED,
  BILLING_EVENT_TYPES.SUBSCRIPTION_DELETED,
]);

export const BILLING_EVENTS_STORE_NAME = "samvit-billing-events";

// -------------------------------------------------------------------------
// Signature verification -- a real implementation of Stripe's documented
// scheme (https://stripe.com/docs/webhooks#verify-manually), independent
// of Stripe's own SDK (this app has no build step / npm SDK dependency for
// any provider -- see providers.js's own header for why that's deliberate
// throughout this codebase). The header looks like:
//   Stripe-Signature: t=1690000000,v1=<hex hmac>,v1=<hex hmac for rolled secret>
// -------------------------------------------------------------------------

async function hmacHex(secret, message) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Constant-time hex-string compare (same reasoning as security.js's
 * timingSafeEqual, duplicated locally rather than imported so this file
 * has zero dependency on session/auth internals -- webhook verification
 * and session verification are different trust boundaries that happen to
 * use the same primitive, not the same concern). */
function timingSafeEqualHex(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const maxLen = Math.max(a.length, b.length);
  let diff = a.length === b.length ? 0 : 1;
  for (let i = 0; i < maxLen; i++) {
    diff |= (i < a.length ? a.charCodeAt(i) : 0) ^ (i < b.length ? b.charCodeAt(i) : 0);
  }
  return diff === 0;
}

/**
 * Verifies a Stripe-style webhook signature against the RAW request body
 * (signature verification must happen on the exact bytes Stripe sent --
 * never on a re-serialized JSON.parse().then(JSON.stringify()) copy,
 * which can differ in whitespace/key order and would make every signature
 * fail to verify, or worse, be "fixed" by skipping verification).
 *
 * @param {string} rawBody  The exact, unparsed request body text.
 * @param {string} signatureHeader  The `Stripe-Signature` header value.
 * @param {string} secret  STRIPE_WEBHOOK_SECRET.
 * @param {{toleranceSeconds?: number, now?: number}} [opts]
 * @returns {Promise<{valid: boolean, reason?: string}>}
 */
export async function verifyStripeSignature(rawBody, signatureHeader, secret, { toleranceSeconds = 300, now = Date.now() } = {}) {
  if (!secret) return { valid: false, reason: "no webhook secret configured" };
  if (typeof signatureHeader !== "string" || !signatureHeader) return { valid: false, reason: "missing signature header" };

  const parts = Object.fromEntries(
    signatureHeader.split(",").map((kv) => {
      const idx = kv.indexOf("=");
      return idx === -1 ? [kv, ""] : [kv.slice(0, idx).trim(), kv.slice(idx + 1).trim()];
    })
  );
  const timestamp = parts.t;
  const signatures = signatureHeader.split(",").map(v=>v.trim()).filter(v=>v.startsWith("v1=")).map(v=>v.slice(3));
  const signature = parts.v1; // Stripe can send multiple v1= entries during secret rotation; a single header value only ever carries one per key here -- rotation support is a real gap, documented, not faked
  if (!timestamp || !signature) return { valid: false, reason: "malformed signature header" };
  if (!/^\d+$/.test(timestamp)) return { valid: false, reason: "malformed timestamp" };

  const ageSeconds = Math.abs(now / 1000 - Number(timestamp));
  if (ageSeconds > toleranceSeconds) return { valid: false, reason: "timestamp outside tolerance window (possible replay)" };

  const expected = await hmacHex(secret, `${timestamp}.${rawBody}`);
  if (!signatures.some(value=>timingSafeEqualHex(expected, value))) return { valid: false, reason: "signature mismatch" };
  return { valid: true };
}

// -------------------------------------------------------------------------
// Idempotency -- prevents a replayed/duplicated webhook delivery (Stripe
// explicitly documents that webhooks can be delivered more than once) from
// being applied twice, WITHOUT losing an event permanently if applying it
// fails partway through.
//
// v4 Priority 5 (reliability fix, post-hardening review): the original
// version of this file had a single-shot claimBillingEvent() -- a bare
// "has anyone claimed this id yet" flag written BEFORE the subscription
// update was attempted. That has a real data-loss bug: if the claim
// succeeded but the subsequent saveSubscription() write then failed (a
// Blobs hiccup, a thrown exception, anything), the event id was already
// permanently marked "claimed." Stripe's retry of the SAME event id would
// hit that claim, be told "duplicate, skip," and the update would never
// actually apply -- the retry mechanism that's supposed to be the safety
// net for a failed write became the thing that silently discarded it.
// `billing.test.js`'s original coverage proved the claim primitive was
// correctly atomic; it never constructed "claim succeeds, then the next
// step fails, then the SAME event id is retried" as a scenario, so nothing
// caught this. See fake-store.js's createFlakyStore(), added specifically
// to make that sequence constructible in a test.
//
// THE FIX: a three-state record per event id, not a boolean.
//   (absent) --[claim: onlyIfNew]--> "processing" --[apply succeeds]--> "applied"
//                                          |
//                                          +--[apply throws]--> "failed" --[retry: onlyIfMatch]--> "processing" (loop)
// "applied" is the only status a future claim treats as a genuine,
// permanent duplicate. "failed" is immediately reclaimable -- a failure is
// unambiguous, there's no reason to make Stripe wait for it. "processing"
// is reclaimable only after staleAfterMs, because an event that's
// GENUINELY still being handled by another in-flight request (rare, but
// Stripe does document concurrent delivery as possible) must not be
// double-applied just because a retry showed up while it was still
// running -- there is no cross-request lock here, only a store, so a
// timeout is the only honest way to tell "still running" apart from
// "crashed before it could record failure" (e.g. the function was killed
// by a platform-level timeout, never reaching a catch block at all).
// staleAfterMs's default (2 minutes) is sized off this handler's own
// actual work (two Blobs reads/writes and one HMAC verification -- low
// hundreds of ms in the worst real case), not off Stripe's specific retry
// cadence, which this file makes no claim to know precisely; it only needs
// to be safely longer than one real attempt could plausibly take.
// -------------------------------------------------------------------------

export const BILLING_EVENT_STATUS = {
  PROCESSING: "processing",
  APPLIED: "applied",
  FAILED: "failed",
};

const DEFAULT_STALE_AFTER_MS = 2 * 60_000;

function eventKey(eventId) {
  return `evt:${eventId}`;
}

/**
 * Attempts to atomically move a billing event id into "processing" --
 * either because nothing has ever claimed it, or because a previous
 * attempt is known-failed or stale-enough-to-presume-dead. This is the
 * ONLY function that grants permission to call saveSubscription() for a
 * given event id; the caller MUST follow up with exactly one of
 * markBillingEventApplied()/markBillingEventFailed() using the returned
 * `etag` once it knows the outcome (see billing-webhook.mjs for the real
 * try/catch/finally-shaped orchestration this is designed for).
 *
 * Every real Blobs write here is a genuine compare-and-swap
 * (onlyIfNew/onlyIfMatch, the same primitive checkRateLimit() and the
 * original claimBillingEvent() both already relied on) -- never a blind
 * overwrite, so two requests racing for the same event id can't both
 * believe they won.
 *
 * Fails CLOSED in the safest direction for a webhook specifically: if the
 * store itself is unavailable, or a reclaim attempt loses its own race,
 * this returns `{claimed: false, status: "processing"}` (treat as
 * "someone else has this, ask Stripe to retry later"), NEVER `{claimed:
 * true}` -- an uncertain state must never risk a double-apply.
 *
 * @param {object} store  Netlify Blobs store (getStore(BILLING_EVENTS_STORE_NAME))
 * @param {string} eventId
 * @param {{staleAfterMs?: number, now?: number}} [opts]
 * @returns {Promise<{claimed: boolean, status?: "applied"|"processing", etag?: string}>}
 */
export async function claimBillingEventForProcessing(store, eventId, { staleAfterMs = DEFAULT_STALE_AFTER_MS, now = Date.now(), accountId=null,eventType=null } = {}) {
  if (!store || !eventId) return { claimed: false, status: BILLING_EVENT_STATUS.PROCESSING };
  const key = eventKey(eventId);
  const record = { accountId,eventType,status: BILLING_EVENT_STATUS.PROCESSING, claimedAt: new Date(now).toISOString(), attempts: 1 };

  try {
    const firstAttempt = await store.setJSON(key, record, { onlyIfNew: true });
    if (firstAttempt?.modified) return { claimed: true, etag: firstAttempt.etag };
  } catch {
    return { claimed: false, status: BILLING_EVENT_STATUS.PROCESSING };
  }

  // Something's already there. Read it to decide whether it's a genuine
  // duplicate, an immediately-retryable failure, or a possibly-stale
  // in-flight attempt -- three different situations a bare "exists/
  // doesn't exist" check (the original bug) couldn't tell apart.
  let existing;
  try {
    existing = await store.getWithMetadata(key, { type: "json", consistency: "strong" });
  } catch {
    return { claimed: false, status: BILLING_EVENT_STATUS.PROCESSING };
  }
  if (!existing) return { claimed: false, status: BILLING_EVENT_STATUS.PROCESSING }; // raced with a delete/expiry between the two calls above; treat conservatively

  const status = existing.data?.status;
  if (status === BILLING_EVENT_STATUS.APPLIED) {
    return { claimed: false, status: BILLING_EVENT_STATUS.APPLIED };
  }

  const claimedAtMs = Date.parse(existing.data?.claimedAt || "");
  const isStale = status === BILLING_EVENT_STATUS.PROCESSING && Number.isFinite(claimedAtMs) && now - claimedAtMs > staleAfterMs;
  const reclaimable = status === BILLING_EVENT_STATUS.FAILED || isStale;
  if (!reclaimable) {
    return { claimed: false, status: BILLING_EVENT_STATUS.PROCESSING };
  }

  try {
    const reclaim = await store.setJSON(
      key,
      { ...existing.data,accountId:accountId||existing.data?.accountId,eventType:eventType||existing.data?.eventType,status: BILLING_EVENT_STATUS.PROCESSING, claimedAt: new Date(now).toISOString(), attempts: (existing.data?.attempts || 0) + 1 },
      { onlyIfMatch: existing.etag }
    );
    if (reclaim?.modified) return { claimed: true, etag: reclaim.etag };
  } catch {
    // fall through to the conservative "busy" result below
  }
  // Either the CAS reclaim lost a race to a concurrent reclaimer, or the
  // write itself failed -- either way, NOT safe to proceed as this caller.
  return { claimed: false, status: BILLING_EVENT_STATUS.PROCESSING };
}

/**
 * Marks a successfully-applied event id as permanently done. Best-effort
 * by design: by the time this is called, saveSubscription() has ALREADY
 * succeeded -- the thing that actually matters -- so a failure here (an
 * unlikely double-hiccup: the store worked for the subscription write
 * moments ago and then failed for this one) must not fail the whole
 * request. Worst case if this write is lost: a future retry of the same
 * event id eventually reclaims a "processing"/"failed" record and re-
 * applies the identical mapped input again, which is harmless --
 * saveSubscription() is idempotent (re-normalizing the same values twice
 * changes nothing) and NOT reapplying app-side side effects like a charge
 * (Stripe owns billing state; this only mirrors it).
 *
 * @param {object} store
 * @param {string} eventId
 * @param {string} [etag]  From claimBillingEventForProcessing()'s result, if available -- used as onlyIfMatch so this can't clobber a concurrent reclaim. Falls back to an unconditional write if omitted.
 * @returns {Promise<boolean>}
 */
export async function markBillingEventApplied(store, eventId, etag) {
  if (!store || !eventId) return false;
  try {
    const current=await store.getWithMetadata(eventKey(eventId),{type:"json",consistency:"strong"});if(etag&&current?.etag!==etag)return false;
    const result = await store.setJSON(
      eventKey(eventId),
      { ...current?.data,status: BILLING_EVENT_STATUS.APPLIED, appliedAt: new Date().toISOString() },
      etag ? { onlyIfMatch: etag } : {}
    );
    return Boolean(result?.modified);
  } catch {
    return false;
  }
}

/**
 * Marks a failed attempt so the NEXT delivery of the same event id can be
 * reclaimed immediately (see claimBillingEventForProcessing() -- "failed"
 * skips the staleness wait entirely, since a failure is unambiguous).
 * Best-effort: if this write itself fails, the record is left in
 * "processing," which is still safe -- claimBillingEventForProcessing()'s
 * staleness fallback reclaims it after staleAfterMs regardless. This
 * function existing is what makes recovery FAST (immediate) rather than
 * merely EVENTUALLY correct (bounded by staleAfterMs); its absence would
 * not be a correctness bug, only a slower one.
 *
 * @param {object} store
 * @param {string} eventId
 * @param {string} [etag]
 * @returns {Promise<boolean>}
 */
export async function markBillingEventFailed(store, eventId, etag) {
  if (!store || !eventId) return false;
  try {
    const current=await store.getWithMetadata(eventKey(eventId),{type:"json",consistency:"strong"});if(etag&&current?.etag!==etag)return false;
    const result = await store.setJSON(
      eventKey(eventId),
      { ...current?.data,status: BILLING_EVENT_STATUS.FAILED, failedAt: new Date().toISOString() },
      etag ? { onlyIfMatch: etag } : {}
    );
    return Boolean(result?.modified);
  } catch {
    return false;
  }
}

/** Read-only check, for tests/observability -- does NOT claim or mutate
 * anything. True only once an event has genuinely been APPLIED, matching
 * what its name implies ("processed" means done, not "someone attempted
 * it and it may have failed") -- a "processing" or "failed" record both
 * correctly return false here. */
export async function wasBillingEventProcessed(store, eventId) {
  if (!store || !eventId) return false;
  try {
    const existing = await store.get(eventKey(eventId), { type: "json", consistency: "strong" });
    return existing?.status === BILLING_EVENT_STATUS.APPLIED;
  } catch {
    return false;
  }
}

// -------------------------------------------------------------------------
// Event -> subscription-input mapping (pure, no I/O)
// -------------------------------------------------------------------------

// Stripe's real subscription statuses are a larger set than Samvit's own
// (see shared/models.js's SUBSCRIPTION_STATUSES: active/past_due/
// canceled). This is a best-effort, documented mapping onto that smaller
// set, not a byte-for-byte passthrough -- `trialing` is treated as
// `active` (a trialing subscriber should keep access), and
// `incomplete`/`incomplete_expired`/`unpaid` are treated as payment
// problems rather than invented new Samvit statuses. Anything unrecognized
// maps to `undefined`, which normalizeSubscription() already handles
// correctly (falls back to the existing record's status, never silently
// to "active").
const STRIPE_STATUS_TO_SAMVIT_STATUS = {
  trialing: "active",
  active: "active",
  past_due: "past_due",
  unpaid: "past_due",
  incomplete: "past_due",
  canceled: "canceled",
  incomplete_expired: "canceled",
};

function toIsoOrNull(unixSeconds) {
  return typeof unixSeconds === "number" && Number.isFinite(unixSeconds) ? new Date(unixSeconds * 1000).toISOString() : null;
}

/**
 * Maps an already-verified Stripe event to the input shape
 * netlify/lib/subscriptions.js's saveSubscription()/normalizeSubscription()
 * accept. Pure and synchronous -- does not touch storage, does not decide
 * WHICH account this applies to (that's the endpoint's job -- see its own
 * comment on today's single-account reality).
 *
 * @param {{type: string, data: {object: object}}} event  A Stripe Event object (or a same-shaped test double).
 * @param {{priceIdToPlanId?: Record<string,string>}} [opts]  See file header: deferred until an operator configures real Stripe price IDs.
 * @returns {object|null}  A `normalizeSubscription()`-compatible partial input, or null if this event type isn't a subscription-state event (e.g. an invoice event -- informational only, not mapped to a subscription field change here).
 */
export function mapStripeEventToSubscriptionInput(event, { priceIdToPlanId = {} } = {}) {
  if (!event || !SUBSCRIPTION_EVENT_TYPES.has(event.type)) return null;
  const sub = event.data?.object;
  if (!sub || typeof sub !== "object") return null;

  const status =
    event.type === BILLING_EVENT_TYPES.SUBSCRIPTION_DELETED
      ? "canceled" // Stripe's own status on a `.deleted` event is often already "canceled", but this makes it explicit regardless of what Stripe reports
      : (STRIPE_STATUS_TO_SAMVIT_STATUS[sub.status] || "past_due"); // undefined for anything unrecognized -- normalizeSubscription() preserves the existing status rather than guessing

  // Deliberately deferred, see file header: without a real, operator-
  // configured price-ID map, `planId` is simply omitted from the mapped
  // input, and normalizeSubscription() preserves whatever plan the
  // record already had rather than inventing one.
  const priceId = sub.items?.data?.[0]?.price?.id;
  const planId = priceId ? priceIdToPlanId[priceId] : undefined;

  const input = {
    status,
    externalCustomerId: typeof sub.customer === "string" ? sub.customer : undefined,
    externalSubscriptionId: typeof sub.id === "string" ? sub.id : undefined,
    currentPeriodStart: toIsoOrNull(sub.current_period_start),
    currentPeriodEnd: toIsoOrNull(sub.current_period_end),
    cancelAtPeriodEnd: typeof sub.cancel_at_period_end === "boolean" ? sub.cancel_at_period_end : undefined,
    source: "stripe",
    billingEventCreated: Number.isFinite(event.created) ? event.created : undefined,
  };
  if (planId) input.planId = planId;
  // Strip undefined keys so normalizeSubscription()'s "not mentioned ->
  // preserve existing" contract (the exact behavior Priority 3's own fix
  // depends on) applies correctly to every field this mapping didn't set.
  return Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined));
}
