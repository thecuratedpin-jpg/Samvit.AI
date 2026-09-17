# Samvit v7 — six improvement passes

## 1. Accounts

Email/password accounts use Node scrypt (N=131072, r=8, p=1), unique salts, and signed sessions carrying a real account ID and revocable session version. ACCESS_CODE gates registration only. All personal record stores, usage, keys, combos, subscriptions and budgets are scoped to the authenticated account. Local team drafts are scoped too; sign-out clears visible private state.

Legacy records are copied to the first registered owner without deleting originals; encrypted connections are decrypted with their old account context and re-encrypted with the new context. Migration resumes on sign-in after interruption. Existing ungated deployments require SAMVIT_MIGRATION_CLAIM_CODE (16+ characters) to claim legacy data. Existing shared sessions expire immediately on upgrade. Keep the existing encryption secret. New members start Free; the owner retains a migrated subscription or explicit operator default.

Validation: 99 tests passing, including registration, duplicates, password failure, forgery, legacy session rejection, migration and direct-ID cross-account reads/updates/deletes across personal-record endpoints. Real provider/Stripe calls are mocked in automated tests. No live deployment performed.

## 2. Per-user budgets

Removed the metering fallback to a shared account; production calls require a real authenticated account. Missing subscriptions resolve to Free for new users, and unavailable storage fails closed. Operator budget overrides still only lower plan allowances. Interrupted calls, absent usage and failed settlement retain conservative charges.

Validation: 102 tests and build pass. Added concurrent independent-user reservations, exhaustion isolation, and a deliberately lost settlement CAS race with a simultaneous reservation and idempotent retry.

## 3. Agent Studio positioning

Moved Agent Studio to the default route, brand home link, first navigation item, page title, description and README opening. Put the reserve-before-call budget explanation directly under the Studio headline. Cut the generic multi-model aggregator headline and equal-feature opening pitch; no features, backend behavior, prices or entitlements were removed or changed in this pass. Chat and Connections remain supporting workflows. Validation: 102 tests and build pass.

## 4. Setup and honest preview

Added the Netlify deployment button and documented template prompts, opt-in automatic persistent secrets, and unauthenticated `/api/setup` with a visible Setup check page. The public check reports readiness and plain-language fixes without exposing values. Account users no longer need the old connection owner code. Offline preview and the sign-in dialog's explore option do not fabricate responses, account data or successful payments. `isDevelopmentMode()` is unchanged.

Validation: 105 tests and build pass, including concurrent secret initialization, independent keys, explicit-secret precedence, storage outage denial and redacted setup reports. The button requires this version to be uploaded to the public template repository; GitHub has not been updated by this ZIP work. A real Netlify deployment remains an integration gate.

## 5. Runtime pricing

Added a five-minute runtime OpenRouter model/pricing cache with validated per-token conversion, text-only eligibility and rejection of unsupported surcharges. Its rates apply only to OpenRouter routes; direct-provider calls retain explicitly dated static fallback prices, not gateway prices relabeled as direct rates. Model cards and saved connection rates show source and check time. Custom positive estimates remain labeled estimates. Verified free routing is rechecked and fails closed on missing verification.

Reservations now reject unknown/non-finite prices and unverified zero rates rather than allowing JavaScript to convert null to zero. Metering refreshes eligible route prices before reservation. Validation: 109 tests and build pass; live-fetch success/cache, fetch failure fallback, malformed pricing, surcharges and unknown zero-reservation rejection covered.

Limit: this does not claim live pricing for every provider. The public OpenRouter feed is the implemented machine-readable price adapter. Other providers need trustworthy pricing adapters or periodic review of the clearly labeled fallback catalog. Provider billing may include costs beyond these standard text estimates.

## 6. Billing hardening

Billing ownership now comes from a stored per-account owner binding and a unique customer-to-account reverse mapping. Client account/customer IDs do not select billing records; shared development sessions cannot pay. Checkout validates the price allowlist, derives return URLs from the origin, checks the actual 30% recurring Stripe coupon, prevents duplicate open sessions with a conditional hold, and grants no entitlement itself.

Lifecycle webhooks trigger authoritative Stripe subscription retrieval. A fenced, expiring lease in the subscription record prevents stale workers from overwriting a later reconciliation. Same-second events use current Stripe state, older timestamps cannot regress recorded state, canceled old subscriptions do not override a replacement, duplicate events are idempotent and failures stay retryable. Multiple outstanding subscriptions fail closed with an anomaly marker. API version fixtures cover Acacia subscription periods and Basil item periods.

Student verification now uses expiring per-user records with signed verifier callbacks, unique references and monotonic revisions. Browser requests can only create a pending record. The old environment eligibility list is ignored. No ID-image collection or fabricated verification service is supplied.

Validation: 119 tests and build pass, including real webhook/checkout/portal handlers with mocked Stripe, signature failures, same-second switching, lifecycle recovery/cancellation, ownership attacks, expired-worker fencing, retryable outages, double-click checkout and coupon validation. Browser syntax checking was added to the build gate after it caught an integration error during final QA.

Live Stripe remains blocked. Before real money: validate the deployed Netlify environment, real Stripe test-mode lifecycle/portal configuration, refunds/disputes and replay monitoring; connect an actual verifier with evidence, expiry and discount-revocation operations; add email verification/account recovery; verify provider access/rates and operating margins. Local fixtures are not a live-service certification.
