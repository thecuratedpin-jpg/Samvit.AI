# Samvit 14 — production identity & permissioned autonomy

**Accounts are open and real.** Anyone can sign up with an email and password; the account activates by verifying its inbox. There is no invitation code, no owner-claim page, no "first user" rule — the authenticated account is the identity boundary. Email delivery is a server-side provider abstraction (Resend in production, bounded dev-capture locally); verification links are single-use, hashed-at-rest, expiring, replay-resistant. Sign-in carries per-account brute-force lockout on top of IP limits, generic errors, and session rotation on every security-relevant change.

**Autonomy stays permissioned.** Background missions plan, execute, observe and verify against real state; paired computers act only through queue + policy + approval rails; the V14 browser foundation adds exactly two honest capabilities (open a page in the user's browser; fetch a page as untrusted text) with per-origin permissions; proactive folder-change signals are opt-in, contained, capped and cancellable — and advisory only.

Read [the V14 identity & autonomy record](docs/V14-IDENTITY-AND-AUTONOMY.md) and the [dedicated security review](docs/V14-SECURITY-REVIEW.md). Earlier records: [V13 execution layer](docs/V13-EXECUTION-LAYER.md), [V9 engineering report](docs/V9-ENGINEERING-REPORT.md). Billing remains Stripe test mode only.

## Preserved V8 features

Assign a model to each role. Let agents build on the contributions before them. Get a final synthesis you can inspect, stop, and export.

**Agent Studio remains available:** Pro teams have 2 agents, Ultra 3, and Ultimate 4. Choose a job, edit each agent’s instructions, and connect the models you want doing the work. Ask Samvit uses these plan concurrency limits while choosing only the work a task needs.

**Your budget is part of the workflow.** Samvit reserves estimated allowance before every call and settles it using conditional writes. Concurrent calls cannot all spend the same remaining allowance. Interrupted or unmeasured work retains a conservative charge. These controls depend on provider rates and usage; they are not an invoice guarantee.

Chat is for quick one-model work. Connections supplies encrypted personal provider keys and fallback combos. Projects, memory and appearance support your workspace. Real email/password accounts isolate data and allowance; Samvit orchestrates existing models rather than training a foundation model.

Billing remains Stripe test mode only. See [v8 changes and limitations](CHANGES-V8.md). Earlier v4–v7 documents are historical.

## Evaluate without provider keys

Run `npm ci`, `npm run build`, then `npm run preview`. The interface is a real offline preview: design agent roles and customize appearance, but AI, accounts, saved server records and payments are unavailable. No model output or payment success is fabricated.

## Deploy from your repository

[![Deploy to Netlify](https://www.netlify.com/img/deploy/button.svg)](https://app.netlify.com/start/deploy?repository=https://github.com/thecuratedpin-jpg/Samvit-)

Upload this version to that public repository **before using the button**; the ZIP alone does not update GitHub. Samvit generates two independent random secrets (`SAMVIT_AUTO_SECRETS=true`) and stores them once in private Netlify Blobs using conditional writes. Environment values override generated values. Keep and back up existing secrets when upgrading; replacing the encryption secret prevents reading previously saved keys. Do not delete the runtime-secrets store.

Open **Setup check** before signing in. Configure Resend delivery (RESEND_API_KEY, verified SAMVIT_EMAIL_FROM, HTTPS SAMVIT_PUBLIC_ORIGIN) and confirm scheduled jobs run. Registration is open: a new user receives a verification email and activates from the link — no invitation or owner claim exists anywhere in V14. The topbar Sign in button works even if status/setup checks fail.

The [official Netlify template documentation](https://docs.netlify.com/deploy/create-deploys/#file-based-template-configuration) defines environment prompts; secret generation is implemented by Samvit at runtime, not by a fictional TOML generator setting.

## Run the full app locally

Use Node.js 22.13+ and run:

```sh
npm ci
npm run build
npm run dev
```

Copy `.env.example` to `.env` first (`Copy-Item .env.example .env` in PowerShell). Netlify dev supplies the function and Blobs environment. Use the URL it prints. Automatic secrets require working Blobs; the public setup check explains missing configuration. `ACCESS_CODE` is only the explicit local-development toggle (with `DEV_MODE=true` it opens localhost without sign-in); it never gates registration. Production keeps authentication closed.

## Upgrade from v6–v13

Back up the old site data and preserve its encryption secret. Deploy this version to the same Netlify site/store. **V14 removes the first-owner migration claim entirely:** legacy single-tenant keys are no longer adopted by any account — pre-V14 deployments that completed their migration keep their account-scoped data exactly as it was; older shared keys simply stay put. Shared v6 session tokens no longer work. All accounts start Free and activate by email verification. Local appearance preferences remain device-local; team drafts are per-account browser data, not a cloud backup.

## Model access and budgets

- Legacy Agent Studio teams have exactly 2/3/4 sequential agents with stop/export. V9 Ask Samvit adds bounded tool execution and task graphs with up to 2/3/4 parallel nodes; arbitrary code execution is unavailable.
- Connections supports 15 providers/gateways and encrypted personal keys. Priority and round-robin combos switch only before response text starts. A network-uncertain or partially delivered response is not replayed.
- OpenRouter gateway rates and authenticated xAI direct rates refresh with a five-minute cache. OpenAI, Anthropic and Gemini direct rates remain explicitly static: no verified direct pricing feed is integrated for them. Cards/connections show rate age, a seven-day review interval and overdue warnings. xAI feed failures also retain labeled fallback rates. Custom routes require positive estimates unless current zero pricing is verified. Unknown/non-finite prices block reservations.
- All metered features share **that user's** UTC monthly allowance. The environment budget cap only lowers the plan allowance. Provider configuration does not prove model access.
- Reservations precede provider calls and settle with compare-and-swap writes. Interrupted calls, missing usage and storage failures retain conservative charges. A crashed worker can leave an outstanding reservation until operator reconciliation or the next month.
- Free has a $0.10 operator-funded trial; it is not a promise of free provider access. Usage analytics are best-effort completed-call estimates, not the reservation ledger or a provider invoice.

## Billing and student verification

Billing is disabled by default and supports **Stripe test mode only**. Enabling requires `SAMVIT_BILLING_ENABLED=true`, a `sk_test_` key, server allowlisted price IDs and a signed webhook at `/api/billing-webhook`. The Stripe client pins API version `2025-02-24.acacia`; tests cover that shape and the item-level periods introduced in `2025-03-31.basil`.

Each authenticated account owns its own billing record. Neither an account ID in a request nor deployment-owner status grants access to another person's customer. Open development sessions cannot use checkout. A single pending checkout is held for 31 minutes with matching Stripe expiry, and retries reuse its session.

Subscription and invoice lifecycle events trigger retrieval of current Stripe subscriptions. Reconciliation uses an expiring fenced lease on the same subscription record; stale workers cannot overwrite later state. Same-second events are reconciled rather than timestamp-sorted, older events cannot regress newer state, and multiple simultaneous subscriptions fail closed with an anomaly marker. Checkout completion alone grants nothing. Failed reconciliation remains retryable.

Student discounts use SheerID hosted verification with server-authenticated details, email binding, reference and bounded expiry. The deployment needs a real published program and authorized token. No student ID images are collected by Samvit. Scheduled maintenance removes expired/revoked student coupons from existing subscriptions and retries failures. Test checkout accepts only an unrestricted recurring 30% coupon. See [pre-money configuration and evidence](PRE-MONEY-V8.md).

Refunds and disputes place separate paid-access holds that ordinary subscription reconciliation cannot erase. Billing operations shows event status, attempts and stale processing to the verified deployment owner. Replays go through Stripe’s signed test webhook delivery.

## Before real money

Live keys are deliberately blocked. Removing that block is a separate reviewed change. First validate the deployed Netlify environment and complete real Stripe test-mode exercises (renewal, failed payment/recovery, cancellation, switching, refunds, disputes, webhook retries and portal configuration). Validate the configured SheerID integration and real Resend account recovery/email verification with a documented evidence/retention process. Establish backup/recovery, reconciliation monitoring and an operational retry/replay procedure. Recheck provider rates and access, and validate operating margins, tax/refund policy and provider terms for the intended service. These deployment and business gates were not completed by local tests.

## Verification and project map

`npm test` runs unit and real-handler integration tests with mocked storage/provider/Stripe services. `npm run build` imports server/shared modules, checks browser JavaScript syntax and referenced assets, then produces `dist`. `scripts/browser-v8.mjs` forces backend errors and verifies desktop/mobile sign-in fallback. Install Playwright and its Chromium browser separately to run this optional check; SAMVIT_CHROMIUM_PATH can select an installed binary. No mock service responses ship as product behavior.

- `src/`, `index.html`: interface, Agent Studio, connections and appearance.
- `netlify/lib/accounts.js`, `passwords.js`, `security.js`: account/session boundary.
- `netlify/lib/storage/accounts.js`, `account-migration.js`: isolation and upgrade copies.
- `netlify/lib/budget.js`, `metered-provider.js`, `model-catalog.js`: spending and rates.
- `netlify/lib/billing-reconciliation.js`, `billing-ownership.js`: billing ownership and reconciliation.
- [CHANGES-V8.md](CHANGES-V8.md): each requested pass, validation and scope.
- [V8 pre-money operations](PRE-MONEY-V8.md): migration, configuration and external integration details.

Earlier architecture/changelog files are preserved history. This README and the v8 documents supersede their single-account and operator student-list instructions.

## Account security

Settings → Account security supports current-password change, signing out everywhere, disabling and deletion. Recovery sends expiring single-use email links for reset, verification and re-enable. New passwords and recovery revoke existing sessions. Deletion blocks active/unsettled paid subscriptions and pending checkout, disables the account immediately, then drains requests for five minutes before scheduled cleanup. The full 19-store inventory and audit method are in CHANGES-V8.md.
