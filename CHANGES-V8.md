# Samvit v8 — flaw-fix passes

## 1. Account lifecycle

Added current-password-verified password changes with caller cookie renewal and sessionVersion revocation, sign-out everywhere, self-disable/re-enable, and account deletion. Mutations use CAS. Account actions share per-IP, per-account and global KDF rate limits. Active or unsettled paid subscriptions and pending checkouts block deletion; a stored Stripe customer requires a real cancellation lookup before deletion is accepted.

Deletion disables the account immediately, drains bounded requests for five minutes, then a retryable Netlify scheduled job removes personal records, identity/email index, connections, budgets, subscription, student and customer mappings. A minimal deletion tombstone prevents resurrection. Deployment ownership remains claimed after owner deletion. The source-audit test enumerates literal getStore/accountStore calls and exported store constants against store-inventory.js; the cleanup test seeds each inventoried user scope and proves another user's records remain. External Stripe/verifier records and backups are not deleted by this application job.

The inventory is: samvit-conversations, samvit-memories, samvit-projects, samvit-missions, samvit-analytics, samvit-accounts, samvit-subscription, samvit-connections, samvit-budget, samvit-users, samvit-billing-customers, samvit-student-verification, samvit-ratelimits, samvit-audit, samvit-billing-events, samvit-runtime-secrets and samvit-account-deletions. Runtime secrets are deployment data; deletion tombstones are retained. New stores added in later passes are documented in the final inventory.

Validation: lifecycle tests exercise fresh caller cookie versus revoked second session, signout-all, disable/enable, deletion drain and cleanup, paid-subscription denial and source inventory coverage. Tests and build run before proceeding.

## 2. Initial ownership

Ungated registration now needs SAMVIT_OWNER_CLAIM_SECRET with a 16-character minimum and the existing timingSafeEqual comparator, including fresh deployments with no legacy data. The claim authorization is stored on the pending account rather than inferred from who arrives first. The public setup endpoint stays reachable, but reports readiness false until ownership is established. Removed provider-presence reports, invitation-gate disclosure and legacy-data detection from setup; remaining fields describe account infrastructure readiness and required operator actions without values or account identifiers.

## 3. Verified email and recovery

Registration returns the same 202 queue acknowledgement with no session cookie for existing and new addresses. Both branches perform scrypt and the same CAS/index/encrypted-outbox write pattern; delivery happens later so provider response latency cannot reveal account existence. Failed sign-ins retain a generic credential error and dummy scrypt for unknown accounts. Correct credentials remain necessary to sign in. No promise of mathematically identical network timing is made.

Resend is the implemented outbound email provider. Missing key/sender/HTTPS public origin fails closed. The encrypted, persistent outbox has bounded retries, delivery leases and provider idempotency keys; it records failed deliveries and only marks sent after a real provider response. Queued is not delivered. The scheduled worker must be active on Netlify.

Unverified accounts can sign in and manage their own account security, but cannot use model, spending, connection or billing endpoints and cannot become owner. Email links use random 256-bit tokens, hashed challenges, a 30-minute expiry and atomic single-use consumption in the account CAS record. Confirmation requires a new password and revokes all sessions, preventing a preregistered password from surviving the email owner's confirmation. Reset and re-enable share the real email channel. Verified v7 users must verify their address after upgrade because v7 had no proof of mailbox ownership.

## 4. Direct pricing

xAI has an authenticated machine-readable language-model price feed, now converted from cents per 100 million tokens into USD per million. Long-context rates use the more expensive rate conservatively. Its five-minute cache is scoped by a key digest. Feed errors fall back explicitly to dated direct rates. OpenRouter remains scoped to gateway routes. OpenAI, Anthropic and Gemini models APIs reviewed here expose no rates; their direct prices remain static with an explicit seven-day review interval, age and overdue indicator. Unknown, non-finite and unverified zero rates remain rejected. Chat and agent analytics now use the metering result rather than re-estimating from a different static table.

Validation: 134 tests passed; build passed (77 server/shared modules). Pricing policy and xAI tests cover authenticated fetch, conversion, cache, feed failure, invalid/unknown surcharge rejection and overdue fallback.

Sources: [xAI models API](https://docs.x.ai/developers/rest-api-reference/inference/models), [OpenAI models API](https://developers.openai.com/api/reference/resources/models/methods/list), [Anthropic models API](https://platform.claude.com/docs/en/api/models/list), [Gemini models API](https://ai.google.dev/api/models).

## 5. Billing before money — code implemented, external validation blocked

Refund/partial-refund and dispute events now retrieve current Stripe objects under a fenced risk lease. Separate per-account payment holds deny paid entitlements; normal subscription updates cannot clear them. Won/warning-closed disputes clear only their own hold, while refunds and lost disputes stay held. Failed risk lookups deny access until a successful retry. Refund resolution still needs an operator support process before money; no automated compensation or override is claimed. Existing customer ownership, test-mode-only gate, allowlisted prices, subscription reconciliation leases and checkout-no-entitlement rules remain.

Webhook event records retain account scope, event type, attempts and status through settlement; a verified-owner operations view exposes failures/stale work and Stripe Workbench resend instructions. An event replay still uses the actual signed Stripe delivery path.

Added the SheerID hosted verification adapter and signed webhook with authenticated detail lookup and account-email binding. Eligibility has a bounded 180-day lifetime that replay cannot extend. Scheduled expiry/rejection/revocation cleanup removes only the configured student coupon, preserves other subscription discounts, and records pending failures for retry. No ID-image upload is accepted by Samvit. Real program settings, returned schema and end-to-end verification remain unvalidated without a configured counterparty. See PRE-MONEY-V8.md for requireToken, PII permission, webhook and operational limits.

Also hardened deletion: its intent is persisted in the disabled account so scheduled cleanup recovers a failed queue write, and the worker rechecks billing after the drain period. Account/customer callbacks avoid recreating records for deleting accounts.

Validation: 140 tests passed; build passed (83 modules). Added refund/dispute, authoritative retry, verifier request/details/signature/mailbox/expiry and discount-removal retry tests. These use explicit test doubles. The read-only deployed validator exited NOT RUN because deployment/Stripe configuration was absent. No real Stripe checkout, portal, payment or SheerID verification occurred. Live Stripe remains disabled. Remaining real-money gates and exact manual scenarios are in PRE-MONEY-V8.md.

Final deletion inventory adds samvit-email-outbox and samvit-payment-risk to the 17 stores in pass 1 (19 stores total). Outbox/job/risk/event records carry accountId for deletion. The source-audit test checks server getStore/accountStore literals and exported store-name constants; cleanup tests seed every inventory scope and preserve a second account. Deployment secrets and minimal deletion tombstones remain; backups and external-provider records require their own retention process.

## 6. Sign-in during backend failures

The topbar now always renders a Sign in button wired directly to the existing dialog. Setup failure also renders its own sign-in action. Successful unauthenticated status still opens the dialog automatically. The optional Playwright browser runner forces both status and setup to return 503 and verifies one-click desktop and 390px mobile access, the setup failure button, no horizontal overflow, and automatic sign-in after a successful unauthenticated status. Screenshots are included under qa/.

Validation: all 140 tests and the build passed; the browser outage checks passed with no browser exceptions. Package and lockfile are version 8.0.0. No live backend or paid services were used.
