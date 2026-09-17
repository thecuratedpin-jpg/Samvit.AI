# Samvit v7 operations

## Configuration and upgrade

Use the current README and `.env.example`; v4–v6 setup instructions are historical. Back up Blobs and existing secrets, stop old-version writes during cutover, deploy the new code to the same site, then register the first account with the deployment invitation or migration claim code. Never replace the old key-encryption secret merely to enable auto-generation.

Migration copies shared data into the first owner's namespace and rewraps encrypted keys with the new account ID as authenticated encryption context. It never deletes the original records. The first owner is held out of normal endpoints until migration completes; signing in retries interrupted work. Each copied item is conditional, so retries do not overwrite already copied records. Large deployments should rehearse migration against a backup and monitor function duration. This release does not provide a bulk offline import tool.

Automatic secrets are 48 random bytes each, persisted in `samvit-runtime-secrets`. Explicit environment secrets override them. Restrict operator access and include this store in backups. `GET /api/setup` returns only readiness booleans, key names and explanations. It does not prove provider access or perform a payment.

Accounts use Node's built-in scrypt with N=131072, r=8, p=1, a unique 16-byte salt and 64-byte output. Sessions contain the user ID, session version and expiry, signed by HMAC. Increment the stored account's sessionVersion or disable the account to invalidate its sessions. Email normalization is case-insensitive; email ownership verification and password recovery are not implemented. Invitations make a private evaluation deployment practical while these remain launch work.

## Tenant boundaries

Record stores use `accounts/<accountId>/...`. Connections, subscriptions, budget ledgers and student records key directly by the authenticated account. Blobs is accessed only from server code. The reserved `samvit-user` identity exists only in the unchanged explicit local-development bypass. Production rejects legacy shared tokens.

Each user owns their individual billing account. The first deployment owner does not gain an API for reading other users' billing. Account recovery or direct administrative storage changes are operator responsibilities and should be audited.

## Student verifier contract

A real verifier integration must validate student eligibility outside this UI, retain evidence under its own documented policy, and submit a decision to `POST /api/student-verification-webhook`. Samvit stores a reference and decision, not ID images.

Configure an independent `SAMVIT_STUDENT_VERIFIER_SECRET` (32+ random characters). Sign the **exact raw UTF-8 request body** using HMAC-SHA256 over `<unix_seconds>.<raw_body>`. Send the lowercase hex digest in:

```
x-samvit-verifier-signature: t=<unix_seconds>,v1=<hex_digest>
```

The verifier adapter accepts a five-minute signature tolerance using the same tested timestamped-HMAC verifier as Stripe, with a separate secret. An illustrative payload is:

```json
{
  "accountId": "usr_00000000-0000-0000-0000-000000000001",
  "status": "verified",
  "reference": "your_verifier_reference",
  "verifier": "your-service-name",
  "revision": 1,
  "expiresAt": 1798761600000
}
```

`expiresAt` is Unix milliseconds and must be in the future, at most 366 days away. Status is verified, rejected or revoked. Revisions must increase per account; repeated or older revisions cannot undo a revocation. A reference cannot be reused for another account. Account IDs must already exist. These example identifiers are fixtures, not actual users or a successful verification.

Normal authenticated users can call `/api/student-verification` to read their own status or POST `{"action":"request"}` to create a pending request. Requests never approve themselves. Without a configured verifier secret the request returns an honest configuration error. A pending request is not a hosted verification journey: the operator must provide the real service's enrollment instructions and connect its decision adapter.

The environment eligibility list from v6 is no longer consulted. Previously assigned subscription flags do not constitute a new verification. Test checkout requires an unexpired record and retrieves the configured Stripe coupon to confirm exactly 30% off, forever recurring, unrestricted and valid. Eligibility expiry/revocation denies **new discounted checkouts**; an already attached recurring Stripe coupon needs removal through the operator's discount-revocation process. Automate and test this policy before real billing.

## Stripe reconciliation

Keep `SAMVIT_BILLING_ENABLED=false` until exercising test-mode setup. The runtime permits only `sk_test_` keys even if the enable flag is true. The API client pins 2025-02-24.acacia. Subscribe `/api/billing-webhook` to customer.subscription created/updated/deleted/paused/resumed; invoice paid/payment_failed/payment_action_required/voided/marked_uncollectible; and customer.deleted.

Checkout is tied to the stored billing owner, creates a uniquely mapped Stripe customer and holds one pending session for 31 minutes. A second price choice while that session is open is refused; same-choice retries reuse the URL after creation. An uncertain creation remains held rather than generating another session. Stripe Checkout expiry matches the hold.

Events authenticate the raw request signature and must be test-mode. Checkout completion is acknowledged without granting access. Lifecycle events retrieve all customer subscriptions, handling pagination with a bounded 2,000-record limit. One nonterminal subscription is eligible for mapping; unknown prices/statuses, wrong customers/modes, unsupported item quantities and multiple nonterminal subscriptions fail closed. Active is the only paid-entitlement-granting Stripe state; trialing, unpaid, paused, incomplete and past_due do not grant paid features.

A two-minute lease and fencing token live in the subscription record itself. The worker verifies ownership at its final conditional write; expired workers cannot commit. Same-second events fetch fresh state. An event older than the last recorded timestamp is ignored. Event claims become applied only after reconciliation; failed processing is retryable. Replay failed deliveries from Stripe's dashboard/CLI after resolving an outage. Monitor 409/503 responses and billingAnomaly fields. Synchronous webhook processing is bounded; a durable queue, scheduled drift sweeps and operational dashboards are follow-up scaling work.

Fixtures cover real handler logic with mocked external services, not actual renewal schedules, card networks or production refunds/disputes. Stripe remains responsible for charging, invoices and refunds. Configure the test customer portal to expose only allowlisted supported subscriptions/prices, and validate taxes, collection, renewal, failed payment recovery, cancellation, switching, refunds and disputes in the real test environment before a separate reviewed live-mode change.

## Price data

The OpenRouter adapter converts public per-token prices to per-million rates, rejects unpriced text or additional non-token surcharges, caches valid data for five minutes and labels every source/check time. The static catalog is the explicit direct-provider fallback. OpenRouter prices never overwrite direct OpenAI/Anthropic/Google/xAI rates. Static IDs may become unavailable; provider calls still require current account access. Verify those fallback IDs and rates before deployment.

A static fallback price is an estimate, not proof of current billing terms. Unknown models need positive custom input/output estimates. Only current verified zero-price models can reserve zero. A missing live free-price check stops free routing rather than silently changing it to paid.

## Sources checked for this implementation

- [Node crypto / scrypt](https://nodejs.org/api/crypto.html#cryptoscryptpassword-salt-keylen-options-callback)
- [Netlify deploy button and template prompts](https://docs.netlify.com/deploy/create-deploys/)
- [OpenRouter model/pricing API](https://openrouter.ai/docs/api/api-reference/models/list-all-models-and-their-properties)
- [Stripe event delivery, ordering and API versions](https://docs.stripe.com/webhooks)
- [Stripe subscription listing](https://docs.stripe.com/api/subscriptions/list)
- [Basil subscription-period field change](https://docs.stripe.com/changelog/basil/2025-03-31/deprecate-subscription-current-period-start-and-end)
