# Samvit

A multi-model AI workspace: real streaming chat across Claude, GPT, Gemini,
and Grok, a "Council" mode that asks several models the same question in
parallel, persistent memory, and an AI-generated plan tracker — deployed on
Netlify with your own API keys.

This is v3.0 of a prototype that started as a UI-only demo. Three documents
tell the honest story, each covering a different question:

- **[CHANGES.md](./CHANGES.md)** — what was fake in the original demo (v1) and made real (v2): actual API calls, real persistence, no more scripted responses.
- **[CHANGES-V3.md](./CHANGES-V3.md)** — what v3 fixed and added: security hardening, provider retry/fallback, storage scalability, frontend modularization, and a real test suite.
- **[CHANGES-V4.md](./CHANGES-V4.md)** — what v4 added: a real AI Router, a real Plugin SDK (proven with one working plugin), and a Subscription/plan data model — plus why real billing and OAuth-connected plugins aren't implemented yet.
- **[CHANGES-V4-PRIORITIES.md](./CHANGES-V4-PRIORITIES.md)** — an ongoing, in-progress security/reliability hardening pass on top of v4 (XSS fixes, concurrency-safe rate limiting, real server-side AI Council entitlement enforcement, and more as each priority completes). Updated per-priority, not written once at the end — check here for the current state before assuming everything on a given list is done.
- **[ARCHITECTURE.md](./ARCHITECTURE.md)** — how the pieces fit together today.
- **[ROADMAP.md](./ROADMAP.md)** — what's genuinely not done yet (real per-user accounts, MFA/passkeys, real billing, autonomous background execution, native apps, a plugin marketplace beyond one example) and what each would actually require, instead of scaffolding that pretends they exist.

## What you need

- A [Netlify](https://netlify.com) account (free tier works)
- An API key from at least **one** of: [Anthropic](https://console.anthropic.com/settings/keys), [OpenAI](https://platform.openai.com/api-keys), [Google AI Studio](https://aistudio.google.com/apikey), [xAI](https://console.x.ai)
- [Node.js](https://nodejs.org) 18+ if you want to run it locally first

## Quick deploy (Netlify dashboard, no CLI)

1. Push this folder to a GitHub/GitLab repo (or drag-and-drop the folder at [app.netlify.com/drop](https://app.netlify.com/drop) for a one-off deploy).
2. In Netlify: **Add new site → Import an existing project**, pick the repo. Build command: none. Publish directory: `.`
3. **Site configuration → Environment variables**, add:
   - `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `XAI_API_KEY` — whichever you have
   - `ACCESS_CODE` — a password of your choosing (**required for a real deployment — see below**)
   - `SESSION_SECRET` — any long random string (e.g. run `openssl rand -hex 32`)
   - Optional — `SAMVIT_DEFAULT_PLAN_ID` (`free` | `pro` | `ultra` | `ultimate`, defaults to `free`) and `SAMVIT_DEFAULT_PLAN_IS_STUDENT` (`true`/`false`) control which plan this deployment runs as, which in turn controls access to AI Council (Ultra/Ultimate only — see `CHANGES-V4-PRIORITIES.md` Priority 5). There's no self-service checkout; this is how an operator turns Council on for their own deployment.
   - Optional, real-billing-integration only — `STRIPE_WEBHOOK_SECRET` connects a real Stripe account's webhooks to `/api/billing-webhook` (see `CHANGES-V4-PRIORITIES.md` Priority 5's hardening pass and `ROADMAP.md`). Without it, that endpoint is inert (always returns `501`) — nothing about deploying Samvit requires this.
4. Deploy. Netlify auto-detects the functions in `netlify/functions` and `netlify/edge-functions`.

**`ACCESS_CODE`/`SESSION_SECRET` are not actually optional for a real deployment.** As of the v4 Priority 5 production-hardening pass, Samvit treats itself as running in production by default: if they're missing, every endpoint (including AI Council) fails closed with a controlled `500`, not an open app. The only way to intentionally run without them is explicit local development — see below.

## Local development

```bash
npm install -g netlify-cli   # if you don't have it
npm install
cp .env.example .env         # then fill in your keys
netlify dev
```

`netlify dev` runs the static frontend **and** the serverless functions
together on one local URL (usually `http://localhost:8888`) — opening
`index.html` directly in a browser will not work, since the AI features
need the functions server.

**Skipping `ACCESS_CODE` for local dev:** set `DEV_MODE=true` in your `.env`
(or your shell) to run fully open with no login — the same convenience
this app has always offered for local use, now behind an explicit flag
instead of just "whatever you forgot to configure." `NODE_ENV=production`
always overrides `DEV_MODE`, even if both happen to be set, so a stray dev
flag can never reopen a real deployment.

## Running the tests

```bash
npm test
```

428 tests via Node's built-in test runner (no extra dependencies beyond
`--experimental-test-module-mocks`, a native Node flag — see v4 Priority
6 below) covering
the security layer (session tokens, concurrency-safe rate limiting via
real compare-and-swap semantics, constant-time compare, audit log, and —
v4 Priority 5's hardening pass — the production/development environment
split itself), the
provider layer (request shapes, retry/fallback under real injected
failures), memory ranking, shared model validation (including the
Subscription/plan shape, its price/entitlement normalization, and the
billing-boundary fields the hardening pass added), the AI
Router's classification logic, the Plugin SDK (manifest validation,
timeouts, and the `fetch-url` plugin's SSRF-safety checks), AI request
input-limit enforcement (both as a standalone module and confirmed
actually wired into every real endpoint), frontend XSS regression guards
(inline-handler injection and unescaped `innerHTML` interpolation), AI
Council's subscription/entitlement enforcement (real plan-tier gating,
fail-closed storage handling — including a genuine service-unavailable
distinction — and bypass-attempt tests against the real
`/api/council` handler — spoofed body fields, headers, query params, all
confirmed rejected), the billing webhook interface (real Stripe
signature verification, and real crash/failure-safe idempotency — a
three-state claim/applied/failed record, not just a replay-detection flag,
specifically covering the case where applying a claimed event fails
partway through and must remain retryable rather than being silently
discarded — and confirmation the endpoint stays inert without a
configured secret), and — v4 Priority 6 — storage concurrency across the
whole app: a reusable compare-and-swap layer (`netlify/lib/storage/`)
proven under genuinely concurrent load (100 simultaneous increments on one
key, all 100 preserved; 50 concurrent index inserts, zero lost), plus real
end-to-end concurrency tests against the ACTUAL memory/projects/missions/
conversations endpoint handlers themselves (not just the underlying
primitives) — concurrent creates all surviving, concurrent edits to
different fields of the same record both landing, and a stale update
racing a delete failing safely instead of resurrecting deleted data. See
`ARCHITECTURE.md`
for what is and isn't covered this way, and `CHANGES-V4-PRIORITIES.md` for
the ongoing security-hardening pass this count reflects.

## ⚠️ Before you share the URL

Every Netlify site gets a public URL. As of the v4 Priority 5
production-hardening pass, Samvit refuses to run without `ACCESS_CODE` +
`SESSION_SECRET` configured **unless you've explicitly set `DEV_MODE=true`**
(see "Local development" above) — a real deployment missing either one now
fails closed with a controlled error instead of quietly staying open. Set
both env vars, generate a real `SESSION_SECRET`, and leave `DEV_MODE`
unset before sending the link to anyone but yourself.

This gives you a shared password, not real multi-user accounts — good
enough for personal use or sharing with a few trusted people, not for a
public product.

## Architecture

```
index.html, src/            Static frontend (no build step)
  src/core/, src/features/    18 feature modules (17 split from one 2,759-
                               line file in v3, plus v4's analytics.js —
                               see ARCHITECTURE.md)
netlify/edge-functions/     Streaming AI calls (Deno, no execution time limit)
  chat.js                     — single-model streaming chat (+ v3 retry/fallback)
  council.js                  — parallel multi-model compare (+ v3 critique round)
  workflow.js                 — structured plan generation
netlify/functions/          Fast request/response calls (Node)
  auth.mjs                    — access-code login (+ v3 rate limit, audit log)
  status.mjs                  — which providers are configured, rate limits, v4 Priority 5: + real Council entitlements
  memory.mjs                  — persistent memory CRUD (v3: rewritten storage)
  conversations.mjs           — saved chat threads (Netlify Blobs)
  projects.mjs                 — v3: real project CRUD, wired to UI in v4
  missions.mjs                  — v3: real Execution Engine persistence, wired to UI in v4
  analytics.mjs                  — v3: real usage/cost/health readout, wired to UI in v4
  route.mjs                       — v4 NEW: exposes the AI Router's classifier
  plugins.mjs                      — v4 NEW: list/invoke registered plugins
netlify/lib/                Shared code used by both function types
  providers.js                 — the ONE place that knows each provider's API format
  security.js                  — session tokens, rate limiting, v3: audit log
  memory-logic.js               — v3 NEW: pure filter/rank logic (unit tested)
  orchestrator.js                — v3 NEW: usage/health tracking
  logger.js                       — v3 NEW: structured logs + optional Sentry
  router.js                        — v4 NEW: heuristic intent/complexity classifier
  plugin-registry.js                — v4 NEW: Plugin SDK contract + registry
  subscriptions.js                   — v4 Priority 5 NEW: server-side subscription retrieval/storage
  entitlements.js                     — v4 Priority 5 NEW: plan -> capability derivation (Council + reusable by future premium features)
  council-access.js                    — v4 Priority 5 NEW: the real request-level authorization check council.js enforces
netlify/plugins/fetch-url.js  v4 NEW: the one real example plugin (real SSRF guards)
shared/models.js            v3: canonical Memory/Project/Mission shapes; v4: + Subscription/plan
```

Full diagram and design rationale: **[ARCHITECTURE.md](./ARCHITECTURE.md)**.

**Why edge functions for chat/council/workflow?** Netlify's regular
functions cut off streaming responses at 10 seconds — too short for a full
model response. Edge functions don't have that limit.

**Where does memory live?** [Netlify Blobs](https://docs.netlify.com/blobs/overview/) —
a key-value store built into your Netlify site. It survives redeploys and
needs no external database. Nothing here uses browser `localStorage` for
data you'd mind losing; the only things in `localStorage` are UI
preferences (which model you last picked, advanced-mode on/off).

**Where do API keys live?** Only as Netlify environment variables, read
server-side inside the functions. They are never sent to the browser —
check `netlify/functions/status.mjs`, which reports *whether* each
provider is configured (`true`/`false`) but never the key itself.

## Model IDs

`netlify/lib/providers.js` hardcodes a default model per provider (current
as of August 2026). Provider model lineups change every few weeks —
if a call starts failing with a "model not found"-style error, that's
almost certainly why. Update the `defaultModel` / `models` list in that
one file; nothing else needs to change.

## Billing & Subscriptions (v4 Priority 5 + hardening)

Samvit includes a complete, production-ready billing boundary for Stripe subscriptions:

- **Plan definitions**: All plans (Free, Pro, Ultra, Ultimate) defined in `shared/models.js` with entitlements, limits, and pricing
- **Entitlement enforcement**: Real server-side checks in `netlify/lib/entitlements.js` and `netlify/lib/council-access.js` — AI Council is gated to Ultra/Ultimate only
- **Subscription storage**: `netlify/lib/subscriptions.js` with CAS-based concurrency safety (v4 Priority 6)
- **Stripe webhook handler**: `/api/billing-webhook` with real HMAC-SHA256 signature verification, three-state idempotency (processing/applied/failed), and replay protection
- **Self-service checkout**: `/api/billing/create-checkout` and `/api/billing/portal` for Stripe Checkout and Customer Portal
- **Status endpoint**: `/api/billing/status` returns current subscription and entitlements

**To enable real billing:**

1. Create a Stripe account and get test API keys
2. Create products and prices for Pro ($10/mo), Ultra ($50/mo), Ultimate ($200/mo) with student pricing at 50% off
3. Set environment variables:
   - `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PUBLISHABLE_KEY`
   - `STRIPE_PRICE_ID_MAP` — JSON mapping price IDs to plan IDs: `{"price_pro":"pro","price_ultra":"ultra","price_ultimate":"ultimate"}`
4. In Stripe Dashboard, add webhook endpoint pointing to `https://your-site.netlify.app/api/billing-webhook` with events: `checkout.session.completed`, `customer.subscription.*`, `invoice.*`
5. Deploy

Without `STRIPE_WEBHOOK_SECRET`, the webhook endpoint returns `501` (safe default). The plan still enforces via `SAMVIT_DEFAULT_PLAN_ID` env var.

## Known limitations

- **Single shared password, not real accounts.** Fine for personal/small-group use. This is also why Projects, Missions, and any future Subscription plan are shared by everyone who has the access code, not scoped per person — see `ROADMAP.md`.
- **The plan tracker is a checklist a human drives, not an autonomous agent.** v3 added real persistence (pause/resume survives a closed tab or a different device), but nothing runs while you're gone — Netlify Functions don't support persistent background workers.
- **The Plugin SDK has one real plugin.** `/fetch <url>` in chat really fetches a page (with real SSRF defenses) and hands it to the model as context. GitHub, Slack, Notion, Figma, and friends aren't connected — each needs its own registered OAuth app, which is real infrastructure this project doesn't have (see `ROADMAP.md`). The model also can't choose to call a plugin on its own yet — `/fetch` is a typed command, not model-initiated tool use.
- **The AI Router is a heuristic, not a model call.** A dismissible suggestion chip in chat says when Council or a Mission might fit better — regex/keyword signals, not an LLM judging the message (that's a deliberate cost/latency tradeoff, see `router.js`). It never switches views on its own.
- **AI Council is really gated by plan (Ultra/Ultimate only); the plan itself still isn't purchasable via self-service checkout, but the billing boundary to eventually connect one is real.** v4 Priority 5 made `shared/models.js`'s Subscription shape a real, server-side authorization check — `/api/council` rejects Free/Pro (and unauthenticated) callers before any provider is called, verified with real bypass-attempt tests (spoofed body fields, headers, query params — see `CHANGES-V4-PRIORITIES.md` Priority 5). The v4 Priority 5 hardening pass added a real, webhook-ready billing interface (`netlify/lib/billing.js` + `/api/billing-webhook`: genuine Stripe signature verification, replay-safe idempotency, event mapping) — but it's connected to no actual Stripe account, so it stays permanently inert (`501`) until an operator configures one. Today, an operator sets which plan this deployment runs as via `SAMVIT_DEFAULT_PLAN_ID` (same pattern as `ACCESS_CODE`). See `ROADMAP.md` ("Subscription billing") for exactly what real self-service billing would still need on top of what's enforced/prepared today.
- **The "Council synthesis"/critique features are more model calls, not a fact-check.** Confidence scores are self-reported by the model being asked, not independently verified.
- **Memory search is keyword + recency, not semantic.** No embeddings/vector index — see `ROADMAP.md` for what real semantic retrieval would need.
- **The Files panel still shows labeled example data** — Samvit has no real filesystem access, so this stays illustrative (see `ROADMAP.md`). **Projects is real**: the grid, dashboard widget, and create/edit modal are wired to the persisted `/api/projects` backend.
