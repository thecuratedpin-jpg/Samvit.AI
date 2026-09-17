# Samvit — Roadmap

This exists because the v3 brief asked for a lot that genuinely can't be made
real in one pass without either faking it or quietly shipping something
broken — and this project has already, once, ripped out fake functionality
that looked real (`CHANGES.md`). This file is where "not done yet" lives
instead of in a scaffold that pretends otherwise.

Each item says what it would actually take — infrastructure decisions, not
just more code — so whoever picks this up next isn't starting from zero.

## Done: the v3 near-term wiring

The three items formerly listed here are now all live: `workspace.js` fetches
real data from `/api/projects` (grid, dashboard widget, and a working
create/edit modal — `#project-crud-modal` in `index.html` was the one missing
piece; the JS was already calling it), `execution.js` persists every mission
state change through `/api/missions` (pause/resume/retry survive a closed tab
or a different device), and a new `src/features/analytics.js` now reads
`/api/analytics` into a "Provider Analytics" panel on the dashboard (per-
provider calls/errors/approx. cost/success rate, last 7 days). No backend or
`netlify/lib/` code changed — this was purely wiring already-tested endpoints
to the UI, verified with `node --check` on every touched file, a full
duplicate/missing-id sweep against every `getElementById` call the wiring
functions actually make, and `npm test` (59/59 still passing, unchanged since
this touched no code under test). No new automated tests were added: this is
DOM-rendering code, which is exactly the category `ARCHITECTURE.md` already
notes isn't covered by the `node --test` suite (see "Verification method")
— a real browser pass (the project's stated method for frontend changes)
wasn't run this session.

## Done: v4-phase0 — a real AI Router and a real Plugin SDK

Two of the v4 brief's requests are now genuinely live, not scaffolding:

- **AI Router** (`netlify/lib/router.js`, `/api/route`): a fast, transparent,
  regex/keyword heuristic classifier — deliberately NOT an extra LLM call
  (see the file's own header for why that tradeoff was made on purpose).
  Wired into the chat send flow: after each reply, a dismissible suggestion
  chip appears above the input if the message looked like it wanted Council
  or a tracked Mission instead ("This read like a multi-step goal — a
  tracked Mission might fit better"), with a real one-click action that
  prefills the right view. It never switches anything automatically.
- **Plugin SDK** (`netlify/lib/plugin-registry.js`, `/api/plugins`): a real
  plugin contract (manifest validation, input-schema checking, a hard
  execution timeout) proven end-to-end with one real, credential-free
  plugin — `netlify/plugins/fetch-url.js` — which fetches a public URL with
  real SSRF defenses (blocks private/link-local/metadata IP ranges,
  `.internal`/`.local` hosts, doesn't blindly follow redirects). Wired into
  chat as a real `/fetch <url> [question]` command: the fetched page text
  becomes model context, and a bad/blocked URL is shown as an error and
  never reaches the model.

Both were verified with a real headless-browser pass (Playwright, mocked
backend responses only), not just code review: sending a plain chat message
leaves the hint hidden, a multi-step message shows and correctly acts on
the Mission suggestion, and `/fetch` correctly parses the URL, calls the
plugin, and renders the result — all with zero JavaScript errors. `npm test`
is at 109/109 (added: Router classification, Plugin SDK manifest/timeout/
invocation, the `fetch-url` SSRF-check function, and the new Subscription
model below).

What's NOT done: GitHub/Figma/Notion/Slack/etc. plugins (each needs a real
OAuth app registration — see "Plugin marketplace" below), a model-based
Router upgrade for cases the heuristic misjudges (flagged as an explicit
opt-in cost in `router.js`'s own comments), and the AI never *decides* to
invoke a plugin on its own — `/fetch` is a user-typed command, not tool-use
the model can reach for. That last one is a real, scoped next step: it
needs passing the plugin's `inputSchema` to the provider as a tool
definition (Claude/GPT/Gemini all support this) and handling a tool-call
response before the final answer — a genuine feature, not a stub, just not
built yet.

## Subscription billing (Free / Pro / Ultra / Ultimate)

**Update, v4 Priority 5: the Council gate itself is now real.** Everything
below this paragraph describes the state before Priority 5 and is kept for
history/context — see `CHANGES-V4-PRIORITIES.md` (Priority 5) for the full
story of what changed. Short version: `/api/council` now really rejects
Free/Pro (and unauthenticated) callers server-side, before any provider is
called, using a subscription record (`netlify/lib/subscriptions.js`) that a
client cannot influence — verified with tests that try spoofing the plan
via the request body, headers, and query string, all rejected. **What's
still true, and still described accurately below: there is no real payment
processor.** An operator sets which plan this single-tenant deployment runs
as via `SAMVIT_DEFAULT_PLAN_ID` (an env var, same pattern as `ACCESS_CODE`)
or, in principle, a direct Blobs write — nothing lets a visitor actually
*purchase* Ultra/Ultimate or self-verify as a student. Deliberately: a
"change your own plan" HTTP endpoint with no payment gate in front of it
would just be a differently-shaped version of the fake paywall `CHANGES.md`
already tore out once, so Priority 5 didn't add one (see
`subscriptions.js`'s `saveSubscription()` — fully implemented and tested,
intentionally not wired to any endpoint).

**Update 2, v4 Priority 5's production-hardening pass: item 2 below
("A real payment processor") is now genuinely webhook-READY, not just
described here as future work.** `netlify/lib/billing.js` +
`netlify/functions/billing-webhook.mjs` are real: real Stripe webhook
signature verification (HMAC per Stripe's own documented scheme, not a
stub), real replay-safe idempotency (a duplicate event id is detected and
skipped, atomically), and a real event → `saveSubscription()` input
mapping — closing the exact loop `subscriptions.js`'s own comment
described. `STRIPE_WEBHOOK_SECRET` (the same env var named below, before
this update existed) gates the endpoint entirely: unconfigured, every
request gets a safe `501`, never a silently-accepted fake success. What's
still genuinely missing, honestly: a real Stripe account to point it at
(needs an operator's own `STRIPE_SECRET_KEY`/`STRIPE_WEBHOOK_SECRET` and
actual Products/Prices configured in their Stripe dashboard), and the
price-ID → `planId` mapping that connects THIS deployment's specific
Stripe prices to `free`/`pro`/`ultra`/`ultimate` (deployment-specific,
`mapStripeEventToSubscriptionInput()`'s `priceIdToPlanId` parameter is
ready for it, empty by default). Real per-user accounts (item 1 below) are
still the bigger, unstarted prerequisite — a webhook applying to Samvit's
one shared account today is a real, tested mechanism, just not yet a
*per-customer* one.

The rest of this section — what real, *self-service* billing (as opposed to
operator-configured plan enforcement, which now exists) would still need:

1. **Real per-user accounts** (see below) — there's currently one shared
   `ACCESS_CODE` for everyone who has the URL. A plan belongs to *someone*;
   Priority 5's subscription record is already keyed by an `accountId` for
   exactly this reason (see `security.js`'s `DEFAULT_ACCOUNT_ID`), but today
   there's only ever one such account per deployment, so every plan change
   still applies to everyone who has the code, not to an individual. This is
   also what today's billing webhook applies its updates against — see
   "Update 2" above.
2. **A real payment processor connection.** The webhook SIDE of this is now
   built for real (see "Update 2" above: `netlify/lib/billing.js` +
   `/api/billing-webhook`, real signature verification, real idempotency,
   calling `subscriptions.js`'s `saveSubscription()` on
   `checkout.session.completed`/`customer.subscription.updated`/`.deleted`).
   What's still needed is the OTHER side — a real Stripe account with
   Checkout wired up on the frontend, using the operator's own
   `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` (same pattern as the AI
   provider keys — Samvit never asks for or stores raw payment details
   itself) — and the price-ID → plan mapping to connect the two. Student
   verification (checking someone is actually enrolled, for the discount)
   is separately a paid third-party service (e.g. SheerID) with its own
   integration, not something crackable in-house.

The pricing table, shape, enforcement, and now the webhook interface are
the honest amount of "real" this gets without a connected payment
processor and real per-user accounts — not a toggle that merely *looks*
like a gate, and not a fake webhook either.

## Real per-user accounts

Everything in this app — memory, conversations, projects, missions — is
currently scoped to ONE shared Blobs store per deployment, because there's
one shared `ACCESS_CODE`, not per-person identity. This is the actual ceiling
on "scales to millions of users," more than any single file's storage
pattern. To fix it for real:

1. A real user table (could still be Blobs-backed, one record per user, but
   needs a signup/invite flow instead of one shared code).
2. Every storage key in `memory.mjs`/`projects.mjs`/`missions.mjs`/
   `conversations.mjs` prefixed by user id.
3. `security.js`'s session token would carry a real user id instead of the
   fixed `"samvit-user"` subject it uses today.

This is the prerequisite for RBAC, MFA, and passkeys below — none of those
mean anything without individual accounts to attach them to.

## Multi-factor auth / passkeys / RBAC

Genuinely implementable (WebAuthn doesn't require heavy infrastructure — a
library like `@simplewebauthn/server` plus credential storage is enough) —
but it presupposes the per-user accounts above. Implementing passkey
enrollment against a single shared access code would be security theater:
whose passkey would it even be? Sequence: real accounts first, then MFA/
passkeys, then role assignment (RBAC) on top of that.

## Real autonomous background execution

The Execution Engine's "pause/resume" is now real (see near-term section
above) — but that's resuming a mission a human is still driving by having a
tab open, not a mission that keeps running unattended overnight. Netlify
Functions and Edge Functions are request-scoped; neither supports a
persistent background worker. A genuinely autonomous mission runner needs
one of:

- A separate always-on worker process (a small dedicated server, or a
  managed queue/worker platform like Temporal, Inngest, or Trigger.dev)
  that polls `missions.mjs` for `status: "running"` missions and executes
  steps on a schedule.
- Netlify Scheduled Functions (cron-triggered) if step latency in the
  minutes range is acceptable, calling out to providers and updating mission
  state each run.

Either is a real architectural addition, not a refactor of what's here.

## Real semantic memory retrieval

v3's memory ranking (`netlify/lib/memory-logic.js`) is intentionally a
transparent, dependency-free keyword + recency + pin scorer — not a fake
"AI-powered" claim. Real semantic retrieval needs:

1. An embeddings call per memory at write time (OpenAI/Gemini/Voyage all
   have embedding endpoints — this is a real, small cost per memory saved).
2. Storing the resulting vector alongside the record.
3. A vector index to search against at query time — Netlify Blobs has no
   native vector search, so this likely means an external vector DB
   (e.g. Pinecone, Turso/libSQL with a vector extension, or Postgres +
   pgvector via a hosted provider) rather than something Blobs alone can do
   well past a few thousand records.

This is a deliberate, scoped addition — not something to bolt on silently,
since it adds a paid external dependency.

## Plugin marketplace

The SDK contract and registry this needs now exist for real (see "Done:
v4-phase0" above) — what's still missing is everything that makes it a
*marketplace* rather than one hand-written plugin: real OAuth-integrated
connectors (GitHub, Figma, Notion, Gmail, Slack, etc. — each needs its own
registered OAuth app: client id/secret, redirect URI, consent screen),
enforced sandboxing (today a plugin's declared `permissions` are advisory
only — nothing stops a plugin from doing more than it declared; real
enforcement means running plugin code in an isolated context, not just
trusting the manifest), a review/publish pipeline, and a public registry.
Building one more real, safe, credential-free plugin (the `fetch-url`
pattern) is a reasonable next step; a marketplace is closer to "a second
product."

## Native Windows / macOS / mobile apps

The honest near-term version of this is wrapping the *existing* web app in
a native shell — Tauri or Electron for desktop, Capacitor for mobile — which
gives a real installable app with minimal code changes, since Samvit has no
server-side rendering or Node-specific frontend dependencies to work around.
That's a legitimate small project (a new `desktop/` directory with a Tauri
config pointing at the deployed URL, or a bundled copy of `src/`), not
attempted in this pass because it's a separate build/release pipeline
(code signing, auto-update, app store submission for mobile) rather than an
extension of the existing Netlify deploy. Worth scoping as its own next
project once the per-user-accounts work above lands — a native app sharing
one access code across everyone who installs it has the same ceiling
described above.

## Enterprise deployment / team collaboration / org management

Downstream of real accounts (above) plus RBAC. An "organization" is
meaningless without individual users to group; team collaboration features
(shared projects, permissions, activity feeds scoped to a team) are a
natural extension of the per-user work once it exists, not a separate
system.

## Frontend/backend shared model definitions, fully

`shared/models.js` is imported by every backend module now (Node functions,
Edge functions, `netlify/lib/`). The *frontend* still can't import it
directly, because `src/` loads as classic scripts with no bundler (see
`ARCHITECTURE.md` for why that was the right call for the onclick-handler
split). Real full-stack sharing would need a lightweight bundler step
(esbuild is the obvious low-overhead choice) — which is itself a bigger
decision than it sounds, since "no build step" has been a deliberate
simplicity choice for this project. Worth revisiting only if/when the
frontend grows enough duplicated validation logic to justify it; right now
the duplication is small (a category list, a few status enums).

## v7 implementation status (supersedes earlier single-tenant notes)
- Pass 1 complete: real accounts, per-user storage and resumable legacy migration. Email delivery, verified-email recovery and an operator account-recovery procedure remain launch work; registration is not proof of email ownership.
- Passes 2–6: in progress. See CHANGES-V7.md for validated changes.
- Pass 2 complete: authenticated budget identity and fail-closed subscription retrieval; concurrent separate ledgers and settlement race verified.
- Pass 3 complete: Agent Studio leads; budget safety supports the promise. Backend and pricing unchanged in this pass.
- Pass 4 complete: template prompts, persistent automatic secrets, public setup diagnostics and explicit offline evaluation. Validate on a real Netlify deployment before public launch.
- Pass 5 complete: live OpenRouter pricing adapter, explicit direct-provider fallback, visible source age and strict unknown-price reservations. Add independently verified pricing adapters for other providers as feeds become available.
- Pass 6 complete in code and automated fixtures: per-account billing ownership, current-state reconciliation, API-version/lifecycle coverage and per-user verifier records. Live payments remain blocked pending the deployment and operating gates in README.md and docs/V7-OPERATIONS.md.

## v8 implementation status (supersedes earlier account/pricing/billing gaps)

Implemented account lifecycle, protected owner claim, Resend email verification/recovery, xAI direct pricing plus explicit seven-day static reviews, refund/dispute paid-access holds, webhook operations, SheerID hosted verification adapter and discount revocation, and backend-independent sign-in. Actual deployed service validation remains blocked without operator configuration. See CHANGES-V8.md, QA-V8.md and PRE-MONEY-V8.md; live billing stays disabled.
