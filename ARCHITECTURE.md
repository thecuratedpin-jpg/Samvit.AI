# Samvit — Architecture (v4)

This document describes what's actually in this repository, not an aspirational
target. If a diagram or claim here doesn't match the code, the code is right —
open an issue against this file, not the other way around.

## What Samvit is

A static frontend + Netlify Functions/Edge Functions app that gives one person
(or a small trusted group sharing one access code) a single place to talk to
Claude, GPT, Gemini, and Grok — directly, in parallel ("AI Council"), or as a
multi-step planned goal ("Execution Engine") — with real persisted memory,
conversations, projects, and missions. No build step: the frontend is plain
HTML/CSS/JS served as-is; the backend is plain ESM served as-is by Netlify.

## High-level shape

```
┌─────────────────────────────────────────────────────────────────────┐
│  Browser (index.html + src/)                                        │
│  ┌───────────────┐  ┌──────────────────────────────────────────┐    │
│  │ intelligence.js│  │ src/core/*.js + src/features/*.js         │    │
│  │ (API client)   │  │ (UI: nav, chat, council, memory, exec...) │    │
│  └───────┬────────┘  └──────────────────────────────────────────┘    │
└──────────┼────────────────────────────────────────────────────────────┘
           │ fetch() same-origin, cookie-authenticated
┌──────────▼────────────────────────────────────────────────────────────┐
│  Netlify                                                               │
│  ┌────────────────────────┐   ┌───────────────────────────────────┐  │
│  │ Edge Functions (Deno)   │   │ Functions (Node, netlify/functions)│  │
│  │  /api/chat              │   │  /api/auth                         │  │
│  │  /api/council            │   │  /api/status                      │  │
│  │  /api/workflow           │   │  /api/memory                      │  │
│  │  (long-lived streaming)  │   │  /api/conversations                │  │
│  └──────────┬───────────────┘   │  /api/projects   (v3)             │  │
│             │                   │  /api/missions   (v3)             │  │
│             │                   │  /api/analytics  (v3)             │  │
│             │                   └───────────────┬───────────────────┘  │
│             └──────────────┬──────────────────┬──┘                    │
│                 netlify/lib/ (shared, imported by both runtimes)      │
│                 providers.js · security.js · orchestrator.js ·        │
│                 logger.js · memory-logic.js                            │
│                             │                                          │
│                 shared/models.js (canonical record shapes)             │
│                             │                                          │
│                 Netlify Blobs (samvit-memories, samvit-conversations,  │
│                 samvit-projects, samvit-missions, samvit-analytics,    │
│                 samvit-audit, samvit-ratelimits)                       │
└─────────────────────────────────────────────────────────────────────┘
             │
             ▼
  Anthropic / OpenAI / Google / xAI (real API calls, streamed back live)
```

## Why two kinds of backend functions

- **Edge Functions** (`netlify/edge-functions/`, Deno runtime) handle
  `/api/chat`, `/api/council`, `/api/workflow` — anything that streams a
  long-lived response back to the browser via Server-Sent Events. Edge
  Functions support long-running streaming responses; standard Netlify
  Functions historically don't handle this as well.
- **Functions** (`netlify/functions/`, Node runtime, `.mjs`) handle everything
  request/response shaped: auth, status, and CRUD for memory, conversations,
  projects, missions, analytics.

`netlify/lib/security.js` is deliberately written with only Web-standard APIs
(`crypto.subtle`, `TextEncoder`, `atob`/`btoa`) specifically so the *same
file* works unmodified in both runtimes without a build step.

## Frontend structure (v3 — modularized)

`src/app.js` (2,759 lines, one file) was split into 17 files under
`src/core/` and `src/features/`. This was a mechanical split, not a rewrite —
every extracted file was verified two ways: (1) concatenating all 17 files
back together reproduces `app.js` byte-for-byte, and (2) every file passes
`node --check` independently, meaning every cut landed on a clean top-level
boundary (no function was split across files).

```
src/
├── intelligence.js        API client layer — the ONLY file that calls fetch()
│                           against Samvit's own backend. Untouched in v3.
├── core/
│   ├── store.js            Global state (SAMVIT_STORE) + illustrative seed data
│   ├── boot.js              Access gate, app launch, clock/date/greeting
│   ├── navigation.js        Sidebar view switching
│   ├── system-actions.js    Generic quick-action dispatch, toasts, banners
│   ├── audio.js              Optional UI sound effects
│   ├── theme.js               Light/dark toggle
│   └── hotkeys.js              Global keyboard shortcuts
└── features/
    ├── goals.js              Interactive goals checklist
    ├── activity-log.js       Cosmetic dashboard terminal feed (labeled)
    ├── workspace.js          Projects grid + Files tree (Projects real as of v4; Files still labeled example data — no filesystem access)
    ├── command-palette.js    Cmd/Ctrl+K palette
    ├── chat.js                Direct AI chat + v4: Router suggestion chip, "/fetch <url>" plugin command
    ├── notifications.js       Notification tray, profile modal
    ├── memory.js               Nexus Brain (persistent memory UI)
    ├── council.js               AI Council UI (+ v3 critique/confidence round)
    ├── execution.js              Execution Engine UI (plan + manual tracker)
    ├── analytics.js                v4 NEW: Provider Analytics panel (/api/analytics)
    └── security.js                 Security & Privacy dashboard
```

**Why classic `<script>` tags, not ES modules.** 72 `onclick=` and 12
`onchange=` handlers in `index.html` call these functions as bare globals.
Classic (non-`type="module"`) scripts all share one global scope in a
document — a `function foo(){}` at the top level of *any* loaded script file
becomes `window.foo` automatically, and a `let`/`const` declared in one
`<script>` tag is visible to every `<script>` tag loaded after it on the same
page. Splitting into multiple classic-script files therefore preserves
*every* existing global exactly as before, with zero risk to the 84 inline
handlers, and without needing to manually audit and re-expose each one via
`window.x = x` the way an ES-module conversion would require. Load order in
`index.html` only needs to put files that *declare* shared state (`store.js`)
before files that *read* it at call time — verified by checking there's no
top-level (non-function-body) code anywhere that calls another file's
function before the DOM is ready.

**Verification method.** No visual regression suite exists (would need a
CI environment with real network access to the Tailwind/Lucide CDNs this
app already depends on). What was actually run: a headless-Chromium
(Playwright) load of the real `index.html`/`src/` files with only the
`/api/status` and `/api/memory` network calls mocked, confirming the app
boots, and clicking through `switchView`, `toggleTheme`, the command
palette (open + type a search), the Memory view, and the Mission Control
view — six real interactions spanning code in nine of the seventeen split
files — with zero JavaScript errors.

## Backend structure (v4)

```
netlify/
├── functions/            Node (.mjs) — request/response
│   ├── auth.mjs            login/logout — v3: rate-limited, timing-safe, audited; v4 Priority 5 hardening: DEV_MODE-gated open fallback
│   ├── status.mjs           unauthenticated health/config probe; v4 Priority 5 hardening: single source of truth via requireSession()
│   ├── memory.mjs            v3: rewritten to one-blob-per-record + index; v4 Priority 6: record/index writes now go through storage/ (CAS-protected)
│   ├── conversations.mjs     v3: already used the right storage SHAPE; v4 Priority 6: its writes are now actually CAS-protected too (shape alone didn't make it concurrency-safe)
│   ├── projects.mjs          v3, wired to real UI in v4-phase0: real CRUD; v4 Priority 6: CAS-protected record/index writes
│   ├── missions.mjs           v3, wired to real UI in v4-phase0: real persisted state; v4 Priority 6: CAS-protected record/index writes (this is the highest-write-frequency endpoint — see its own PUT handler comment)
│   ├── analytics.mjs           v3, wired to real UI in v4-phase0: usage/cost/health (read-only — no writes of its own to protect)
│   ├── route.mjs                v4 — NEW, exposes router.js's classifier
│   ├── plugins.mjs               v4 — NEW, list/invoke registered plugins
│   └── billing-webhook.mjs        v4 Priority 5 hardening — NEW, real Stripe-webhook endpoint, permanently 501s until STRIPE_WEBHOOK_SECRET is configured (see billing.js)
├── edge-functions/        Deno — streaming
│   ├── chat.js              v3: dedup'd, retry+opt-in fallback, usage tracking
│   ├── council.js            v3: + critique/confidence round, usage tracking; v4 Priority 5 hardening: request order rebuilt to Auth -> Subscription -> Entitlements -> Council Limits -> Rate Limits -> Input Limits -> execution
│   └── workflow.js            v3: dedup'd, normalized Mission output
├── lib/                    Shared by both runtimes
│   ├── providers.js           Only file that knows each provider's wire format
│   ├── security.js             Sessions, rate limiting, audit log; v4 Priority 5: + DEFAULT_ACCOUNT_ID / requireSession() returns accountId; v4 Priority 5 hardening: + isDevelopmentMode(), requireSession() fails closed in production; v4 Priority 6: recordAuditEvent() now uses storage/casUpdate() (checkRateLimit()'s own CAS logic was already correct and was left untouched, per that priority's own explicit instruction)
│   ├── memory-logic.js          v3 — pure filter/rank fns (unit tested)
│   ├── orchestrator.js           v3 — usage/health recording; v4 Priority 6: recordUsage()/recordHealthPing() now use storage/casUpdate() — this file was the brief's own canonical unsafe-pattern example, almost verbatim
│   ├── logger.js                  v3 — structured logs + optional Sentry
│   ├── router.js                   v4 — NEW, heuristic intent/complexity classifier
│   ├── plugin-registry.js           v4 — NEW, Plugin SDK contract + registry (in-memory only — no persistent storage, out of Priority 6's scope)
│   ├── ai-limits.js                  v4 Priority 4 — NEW, input-size/cost limits, wired into every AI-calling endpoint
│   ├── subscriptions.js               v4 Priority 5 — NEW, server-side subscription retrieval/storage (store-injected, fail-closed); v4 Priority 5 hardening: + isSubscriptionServiceUnavailable() distinguishes a real outage from "no record yet"; v4 Priority 6: saveSubscription() now a real CAS update via storage/casUpdate() — can now throw StorageConflictError/StorageUnavailableError, which billing-webhook.mjs already handles
│   ├── entitlements.js                 v4 Priority 5 — NEW, plan -> capability derivation, generic/reusable beyond Council
│   ├── council-access.js                v4 Priority 5 — NEW, the real request-level Council authorization check; v4 Priority 5 hardening: + COUNCIL_SUBSCRIPTION_UNAVAILABLE decision
│   ├── billing.js                        v4 Priority 5 hardening — NEW, webhook-ready design: real Stripe signature verification, CAS-based idempotency, event->subscription mapping (see CHANGES-V4-PRIORITIES.md for exactly what's real vs. deliberately deferred); its 3-state idempotency (processing/applied/failed) was already CAS-based before Priority 6 and is unchanged by it
│   └── storage/                          v4 Priority 6 — NEW, the reusable concurrency layer every write above is now built on:
│       ├── concurrency.js                  casUpdate() — the one generic read-ETag/modify/conditional-write-with-bounded-jittered-retry primitive, generalized from checkRateLimit()'s own (Priority 2) CAS loop
│       ├── errors.js                       StorageConflictError/StorageUnavailableError/StorageNotFoundError/IdempotencyConflictError + storageErrorStatus() -> HTTP status mapping
│       ├── blobs.js                        safeGet/safeDelete — the same error taxonomy applied to plain (non-read-modify-write) storage calls
│       ├── record.js                       updateRecord() — safe single-record update; StorageNotFoundError on a record deleted mid-update is what makes the update-vs-delete race (brief section 9) come out correctly
│       └── index-list.js                   prependIndexEntry()/upsertIndexEntry()/removeIndexEntry() — safe index-array mutation for the one-blob-per-record-plus-index pattern below, with optional maxLength truncation (conversations.mjs)
├── plugins/
│   └── fetch-url.js          v4 — NEW, the one real example plugin (real SSRF guards)
└── shared/models.js          v3, extended in v4: + Subscription/plan shape; v4 Priority 5 hardening: + billing-boundary fields (externalCustomerId/externalSubscriptionId/currentPeriodStart/currentPeriodEnd/cancelAtPeriodEnd/source), all prepared, none enforced
```

### Environment separation (v4 Priority 5 hardening pass)

Every endpoint's auth check (`requireSession()` in `security.js`) now
distinguishes production from development EXPLICITLY rather than
inferring it from whether `ACCESS_CODE` happens to be configured:
`NODE_ENV=production` is an absolute override; otherwise, running fully
open (no auth, no entitlement enforcement — the pre-existing "local dev
convenience" state) requires the literal `DEV_MODE=true`. No signal at
all is treated as production, not development — the default posture is
locked, and a missing `ACCESS_CODE`/`SESSION_SECRET` in that default
posture is a controlled `500 AUTHENTICATION_UNAVAILABLE`, never a silent
bypass. See `CHANGES-V4-PRIORITIES.md`'s Priority 5 hardening section for
the full story, including why `/api/status` and `/api/auth` both needed
the same fix independently (they used to each carry their own copy of the
old, unsafe inference).

### The AI Council request path, in order (v4 Priority 5, updated by the hardening pass)

```
Authentication -> Trusted Subscription -> Entitlements ->
AI Council Limits -> Rate Limits -> Input Limits -> AI Council
```

Minimal structural body parsing (is this JSON, does it have a `providers`
array and a non-empty `prompt`) necessarily happens right after
Authentication — every step after it needs `providers.length`/`critique`
— but that's the minimum shape needed to route the request at all, not
the size/cost policy decision `Input Limits` (`ai-limits.js`) makes. This
order supersedes the original Priority 5 pass's ordering, which ran
shape/size validation before authentication.

### The Router and Plugin SDK stay decoupled from chat/council/workflow

`router.js` and `plugin-registry.js` are deliberately NOT imported by
`chat.js`/`council.js`/`workflow.js` on the backend. The frontend calls
`/api/route` and `/api/plugins` as their own requests and decides what to
do with the result (show a suggestion chip, inject fetched text into the
next chat call) — the AI-calling edge functions never got more complex or
more coupled to add these. This was a deliberate design choice, not an
oversight: it keeps each piece independently testable (109 tests, still
zero mocking of Netlify Blobs required for the pure-logic files) and means
a Router or Plugin SDK bug can't take down chat.

### Storage pattern: one blob per record + an index

`conversations.mjs` originally established the right pattern: each record
lives under its own Blobs key (`convo:<id>`), with a small `index` key
listing just enough metadata to sort/filter without loading every record.
`memory.mjs` didn't follow this — every memory lived in one array under a
single key (`"all"`), so *any* add/edit/pin/archive/delete read and rewrote
the *entire* memory store. v3 brings `memory.mjs`, `projects.mjs`, and
`missions.mjs` all onto the same one-blob-per-record pattern, and
`memory.mjs` auto-migrates existing single-blob data the first time it's
read (old data is only deleted after the new copy is confirmed written).

**v4 Priority 6 update — the SHAPE alone didn't make this safe.**
`conversations.mjs` having the "right" storage shape from the start didn't
mean its writes were concurrency-safe — a plain `index.unshift(entry);
setJSON(INDEX_KEY, index)` loses entries under real concurrent creates
regardless of whether the overall shape is one-blob-per-record or one giant
array; the *shape* only bounds how much a single lost update costs (one
entry vs. the whole store), not whether updates get lost at all. Every
write in all four endpoints — the record write on update, and the index
write on create/update/delete — now goes through `netlify/lib/storage/`
(`updateRecord()`/`prependIndexEntry()`/`upsertIndexEntry()`/
`removeIndexEntry()`, all built on the same `casUpdate()` compare-and-swap
primitive `checkRateLimit()` pioneered in Priority 2). See
`CHANGES-V4-PRIORITIES.md`'s Priority 6 entry for the full accounting of
what was and wasn't already wired when that pass began — notably,
`memory.mjs` had the safe-storage imports already present but not actually
connected to its handlers, a real gap that pass's audit caught and closed.

### Testing

`tests/` uses Node's built-in test runner (`node --test`, with
`--experimental-test-module-mocks` added by v4 Priority 6 — see below —
still no external framework, keeping the zero-build-step philosophy). 428
tests, all passing: `shared/models.js` normalization/validation (Memory/
Project/Mission/Subscription, including v4 Priority 5 hardening's
billing-boundary fields), `memory-logic.js` filter/rank behavior,
`security.js` (constant-time compare, token sign/verify + tamper/expiry
rejection, rate limiting including fail-open behavior, audit log, and —
v4 Priority 5 hardening — `isDevelopmentMode()`/`requireSession()`'s
production fail-closed behavior directly), `providers.js` (request
shape per provider, error classification, retry-with-backoff, fallback-
eligibility — real failure injection via a monkey-patched `fetch`, not just
happy-path mocks), `router.js` (mode/intent/complexity classification,
provider-selection fallback, robustness against empty input),
`plugin-registry.js`/`fetch-url.js` (manifest validation, input-schema
checking, execution timeout, and the SSRF-safety checks — private/link-
local/metadata IP ranges, blocked hostnames — as directly callable,
unit-tested functions), `ai-limits.js` (input-size/cost limits, both as a
standalone module and confirmed wired into every real AI-calling endpoint),
`entitlements.js`/`subscriptions.js`/`council-access.js`
(every plan tier including student pricing and upgrade/downgrade,
fail-closed storage handling, the v4 Priority 5 hardening pass's
service-unavailable distinction, and the real exported `council.js` handler
invoked with real `Request` objects and real signed session cookies to
confirm the authorization ordering and bypass-resistance for real, not
just in the underlying modules), `billing.js`/`billing-webhook.mjs`
(v4 Priority 5 hardening — real Stripe signature verification against
hand-computed HMACs, a three-state (processing/applied/failed) CAS-based
idempotency record — not a single claim flag, specifically so a failed
apply stays retryable instead of being permanently discarded, see
`CHANGES-V4-PRIORITIES.md`'s reliability-fix entry — event-to-subscription
mapping, a full claim→map→save→re-read pipeline integration test
(including one that injects a genuine mid-pipeline write failure via
`tests/helpers/fake-store.js`'s `createFlakyStore()` and confirms the
retry recovers), and the real webhook endpoint confirmed inert without a
configured secret), and — v4 Priority 6 — the storage concurrency layer
itself plus every endpoint built on it: `storage-concurrency.test.js`
exercises `casUpdate()`/`updateRecord()`/`prependIndexEntry()`/
`upsertIndexEntry()`/`removeIndexEntry()` with genuinely concurrent
`Promise.all` stress tests (100 simultaneous increments on one key, all
100 preserved; 50 concurrent index appends, zero lost), plus the
update-vs-delete race constructed at the primitive level via
`createFlakyStore()`; `crud-storage-wiring.test.js`/
`conversations-wiring.test.js` fire real concurrent requests at the ACTUAL
exported handlers of `memory.mjs`/`projects.mjs`/`missions.mjs`/
`conversations.mjs` (30-50 concurrent creates surviving in the index,
concurrent field updates to the same record both landing, update-vs-delete
returning 404 rather than resurrecting, conversations' `MAX_STORED`
eviction); and `subscriptions.test.js`/`billing.test.js` gained dedicated
concurrent-write tests matching the brief's own named scenarios (two
concurrent plan-change events on one account; N truly concurrent
deliveries of the identical webhook event resolving to exactly one
application). Run with `npm test`.

**v4 Priority 6 — real handler-level concurrency testing, not just the
underlying primitives.** `memory.mjs`/`projects.mjs`/`missions.mjs`/
`conversations.mjs` call `getStore()` directly with no store-injection
seam (see the paragraph below on why other modules DO take an injected
store) — the same limitation `council-wiring.test.js`'s own header
documents for the Deno edge functions (`getStore()` throws synchronously
outside a real Netlify runtime). `tests/helpers/mock-blobs.js` removes
that limitation specifically for these Node-runtime endpoints, using
`node:test`'s `mock.module()` (an experimental API, enabled via
`--experimental-test-module-mocks` in `package.json`'s `test` script,
confirmed to add zero behavior change to every pre-existing test) to
replace `"@netlify/blobs"`'s `getStore` export with the same ETag/CAS-
faithful fake store every other concurrency test in this app already
trusts, before the endpoint module is imported. This makes it possible,
for the first time, to fire genuinely concurrent requests at the REAL
exported handler and assert on the REAL persisted state.

Three design choices exist specifically to make testing possible without
mocking Netlify Blobs (for the files where that's the approach used
instead of the module-mock above): `memory-logic.js`'s filter/rank
functions take plain arrays, not a store; `orchestrator.js`'s functions
take an injected `store` parameter rather than calling `getStore()`
internally (matching the pattern `security.js`'s `checkRateLimit`/
`recordAuditEvent` already used); and v4 Priority 5's `subscriptions.js`/
`council-access.js` follow the same injected-store pattern, plus split a
pure decision function (`decideCouncilAccess`) out from the store-backed
entry point (`authorizeCouncilRequest`) specifically so plan/limit
combinations that no CURRENT real subscription tier produces can still be
proven correct directly — see `council-access.test.js`. v4 Priority 6's
`netlify/lib/storage/` module follows the identical injected-store
convention (`casUpdate(store, key, updateFn)`, never `getStore()`
internally), which is precisely what makes `storage-concurrency.test.js`'s
stress tests possible without any module mocking at all — the module-mock
approach above is needed only for the four CRUD *endpoints*, which predate
this convention and weren't restructured to adopt it (out of scope: brief
section 14 requires preserving existing behavior, not restructuring
function signatures).

## What's honestly still limited

See `ROADMAP.md` for the full list with reasoning. In short: this is a
single-shared-access-code app (no real per-user accounts), so "Projects",
"Missions", and the Subscription plan (v4 Priority 5 made AI Council a
really-enforced gate on this plan — see `CHANGES-V4-PRIORITIES.md`) are
shared by/apply to everyone who has the code, not scoped per person, and
there's still no real payment processor CONNECTED behind *which* plan
that is (an operator sets it server-side; nothing lets someone purchase
one yet) — the v4 Priority 5 hardening pass built a real, webhook-ready
billing boundary (`netlify/lib/billing.js` + `netlify/functions/
billing-webhook.mjs`: real signature verification, real idempotency, a
real event-mapping function) for a real Stripe account to eventually
connect to, but no such account exists yet, so the endpoint stays
permanently inert (a safe 501) until an operator configures one;
Execution Engine missions
are resumable but not autonomous (nothing runs while your tab is closed —
Netlify Functions don't support persistent background workers); memory
search is lexical (keyword + recency), not a real embeddings/vector index;
plugins are limited to one real, credential-free example (`fetch-url`) —
real GitHub/Figma/Notion/etc. connectors each need their own registered
OAuth app, and a plugin's declared `permissions` are advisory only, not
enforced by a sandbox; the AI models can't invoke plugins themselves yet
(`/fetch` is a user-typed command); and there's still no RBAC, MFA,
passkeys, real subscription billing, or native desktop/mobile app — all of
which need infrastructure this project doesn't have yet, not just more
code.
