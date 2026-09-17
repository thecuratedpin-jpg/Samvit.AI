# Samvit v8 — deployment evidence and remaining gates

This release is a source implementation with locally mocked service tests. It has **not** completed the real deployed Stripe lifecycle, real email delivery, or an actual SheerID program verification. No deployment URL or credentials were supplied for those checks. Stripe live keys remain rejected; do not take real money from this build.

## Configure and verify on a staging deployment

1. Deploy the complete Netlify project, including Node Functions, Edge Functions and scheduled jobs. Use a durable SESSION_SECRET, a separate connection encryption key, an owner-claim secret of at least 16 characters, and production mode. Run npm ci, npm test, npm run build.
2. Set RESEND_API_KEY, a verified SAMVIT_EMAIL_FROM sender and SAMVIT_PUBLIC_ORIGIN to the HTTPS deployment root. Confirm real verification, reset and re-enable emails arrive. Check the minute email worker, failed queue records and retry behavior. Existing v7 users need mailbox verification. Registration acknowledges a queued message, not delivery.
3. Claim and verify the owner; confirm /api/setup is ready only afterward. Try two real accounts and confirm isolation, password change, lost-password recovery, sign-out everywhere and deletion. Deletion must wait for all Stripe subscriptions and open checkouts to settle. Monitor pending jobs if a canceled account stays disabled while cleanup is blocked.
4. Configure a **published SheerID student program**, requireToken API Access Control through the SheerID account team, and an access token authorized for Verification Details and Customer PII. Set SHEERID_ACCESS_TOKEN and SHEERID_PROGRAM_ID. Configure the signed webhook to /api/sheerid-webhook with SHEERID_WEBHOOK_SECRET. Complete a real hosted verification using the same email as the verified Samvit account. Confirm returned detail schema and production program settings before enabling discounts. Samvit receives status/reference and compares email; it does not accept or retain identity documents.
5. Student eligibility lasts at most 180 days from first accepted success. Refreshes and webhook replays cannot extend it. Rejected/revoked/expired records deny new discounts. Every 15 minutes, maintenance attempts removal of the configured student coupon from existing subscriptions, preserves unrelated discounts and retries failures. Verify this with real test subscriptions. Check backlog throughput (20 records/run) and alert on failures; large deployments need higher throughput. Customer-level or item-level student discounts are unsupported: never configure those. The old signed custom-verifier endpoint remains a compatibility interface; a secret alone does not establish a verifier counterparty.
6. Configure test Stripe prices matching the advertised USD monthly amounts, SAMVIT_BILLING_ENABLED=true, sk_test credentials, webhook secret, price map and an unrestricted recurring 30% student coupon. Configure the default test portal for cancellation and payment-method updates. Run `node scripts/validate-deployment.mjs` with operator environment variables. The script only reads deployment and Stripe configuration; it does not prove the lifecycle.
7. In Stripe test mode, exercise checkout success/cancel, duplicated checkout clicks, delayed/duplicate/out-of-order webhook delivery, past due, payment recovery, scheduled cancellation, canceled subscription and resubscription. Confirm checkout success alone never grants access. Confirm every price and customer maps only to its stored Samvit owner.
8. Test partial/full refunds, dispute open/lost/won and delayed dispute events. Refunds and non-won disputes place an account-wide hold on paid entitlements. Winning a dispute clears only that dispute hold. Refund holds intentionally remain for operator review; this release has no automated compensation/hold-release process. An ordinary active-subscription webhook cannot clear a hold. A risk API failure denies paid access until retry succeeds. This conservative policy requires an agreed customer-support and refund-resolution process before real money.
9. Use Billing operations as the verified deployment owner to inspect event status, attempts and stale processing. Resend failed/stale event IDs from Stripe Workbench to the signed **test** webhook. Confirm attempts increase and applied duplicates do not regrant access. The view is bounded to 2,000 scanned/100 displayed events; production needs external alerting, full retention rules and scalable monitoring.
10. Confirm email and student job failure alerts, recovery and deletion queue behavior, secret rotation, backups and privacy retention. Application deletion covers active Blobs records, not external Stripe/SheerID/Resend records or provider backups. Define those retention operations before taking money.

## What was actually verified here

Automated Node tests cover the code paths with fake Blobs stores and Stripe/SheerID/Resend responses; they do not contact those services. Browser verification forces status and setup to fail and checks sign-in accessibility. Test/build results are recorded in CHANGES-V8.md and QA-V8.md.

The read-only deployed validator is explicitly NOT RUN successfully without operator configuration. Do not interpret a passing unit test, a configured secret, or an accepted verification request as real service validation.

## Sources used for adapters

- [Resend send API](https://resend.com/docs/api-reference/emails/send-email)
- [SheerID secure verification creation](https://developer.sheerid.com/tutorials/secure-verification-creation)
- [SheerID webhook and detail lookup](https://developer.sheerid.com/tutorials/verifications/webhooks)
- [Stripe event types](https://docs.stripe.com/api/events/types)
- [Stripe subscription discount updates](https://docs.stripe.com/api/subscriptions/update)
