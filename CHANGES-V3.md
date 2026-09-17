# What changed in v3

> **This file covers the v2→v3 pass** (security hardening, provider retry/
> fallback, storage rewrite, frontend modularization, real tests). For the
> v4 pass (AI Router, Plugin SDK, Subscription model — and what's honestly
> still not implemented), see [`CHANGES-V4.md`](./CHANGES-V4.md).

v2 (see `CHANGES.md`) made Samvit's AI, memory, and council features real.
This pass was asked to go much further — turn Samvit into an "AI Operating
System" with RBAC, MFA/passkeys, a plugin marketplace, autonomous background
execution, and native Windows/macOS/mobile apps. Building those as inert
scaffolding that doesn't actually work would repeat exactly what v2 removed —
so instead: everything below is real and tested, and `ROADMAP.md` explains
concretely what the rest needs (mostly infrastructure decisions — real user
accounts, a background worker platform, a vector DB — not just more code).

## Fixed: login had no brute-force protection

- **Before:** `/api/auth` compared the access code with `!==` (not
  timing-safe) and had **no rate limit at all** — every other AI-calling
  endpoint was rate-limited, login wasn't.
- **Now:** constant-time comparison (`security.js: timingSafeEqual`), a
  dedicated tighter rate limit on login attempts specifically, and every
  login/logout attempt is written to a real audit log
  (`netlify-blobs: samvit-audit`).

## Fixed: memory storage didn't scale, unlike everything else

- **Before:** `memory.mjs` stored every memory as one JSON array under a
  single Blobs key — every single add/edit/pin/archive/delete read AND
  rewrote the entire list. `conversations.mjs` (written later) already used
  a safer one-blob-per-record pattern; memory never got it.
- **Now:** `memory.mjs` uses the same one-blob-per-record + index pattern,
  with automatic, safe migration of existing data (old data is only deleted
  after the new copy is confirmed written — nobody loses memories from this
  upgrade) and a documented storage cap (2,000 memories) instead of silent
  unbounded growth.

## Fixed: the same provider/env-var map was copy-pasted three times

- **Before:** `chat.js`, `council.js`, and `workflow.js` each hardcoded an
  identical `{claude: "ANTHROPIC_API_KEY", ...}` map.
- **Now:** centralized as `getApiKeyForProvider()` in `providers.js`, which
  already had this data (`envKey`) — just wasn't being reused.

## Added: provider retry, fallback, and real cost/health tracking

- **Before:** one failed request (a transient 5xx, a momentary rate limit)
  just failed. No retry, no fallback to another configured provider, no
  tracking of what anything actually costs or how reliable each provider
  has been.
- **Now:** `streamFromProviderWithRetry()` retries transient failures
  (network errors, 429s, 5xxs) with exponential backoff — but only before
  any text has streamed back, since retrying mid-stream risks duplicate
  output. `/api/chat` can optionally (`allowFallback: true`, opt-in — Samvit
  doesn't silently switch models on you) fall through to the next configured
  provider. Every completed call records approximate cost and updates a
  rolling per-provider health/success-rate, readable via the new
  `/api/analytics` endpoint — labeled everywhere as approximate and
  self-reported, not billing-accurate.

## Added: AI Council critique + confidence round (opt-in)

- **Before:** Council ran every model in parallel and (optionally) had one
  more model synthesize the answers — real, but the models never saw each
  other's work.
- **Now:** with `critique: true`, after every model answers, each one is
  shown the full set of answers (its own labeled "YOUR ORIGINAL ANSWER") and
  asked to briefly critique the set and self-report a confidence score for
  its own original answer — a real second model call per participant, not a
  fabricated score, and labeled as self-reported everywhere it's shown.

## Added: real Projects and Missions backends (replacing unlabeled fake data)

- **Before:** the "Projects" grid and dashboard "Recent Projects" widget
  rendered a hardcoded array (`initialProjects`) that looked real but wasn't
  backed by anything — and unlike the Security panel's honestly-labeled
  example data ("Example — not live-tracked"), nothing told you that.
- **Now:** `/api/projects` and `/api/missions` are real, tested, persisted
  CRUD endpoints (same storage pattern as `conversations.mjs`), with client
  methods added to `intelligence.js`. The Projects/Files UI panels are now
  clearly labeled "Example" until they're wired to these endpoints (the very
  first item in `ROADMAP.md` — the backend work is done, the UI wiring
  is what's left).

## Changed: `app.js` (2,759 lines, one file) split into 17 feature modules

- **Before:** every frontend feature — chat, memory, council, execution,
  security dashboard, command palette, and more — lived in one file.
- **Now:** split into `src/core/` and `src/features/`, loaded as classic
  (non-module) scripts specifically so the 84 inline `onclick`/`onchange`
  handlers in `index.html` keep working unchanged (see `ARCHITECTURE.md` for
  why ES modules would have required re-auditing every one of them). The
  split was verified, not just assumed correct: concatenating all 17 files
  reproduces the original byte-for-byte, every file passes `node --check`
  independently, and a real headless-browser pass (Playwright) confirmed the
  app boots and exercised interactions spanning nine of the seventeen files
  with zero JS errors.

## Added: real automated tests (there were none before)

- **Before:** no test suite existed.
- **Now:** 59 tests via Node's built-in test runner (`npm test`, zero added
  dependencies) covering shared model validation, memory filter/rank logic,
  security (constant-time compare, session token forgery/tampering/expiry,
  rate limiting including its fail-open behavior, audit log), and the
  provider layer — including real failure-injection tests (a monkey-patched
  `fetch` simulating network errors, 429s, 401s, 5xxs) verifying retry and
  fallback actually behave correctly under failure, not just on the happy
  path.

## Added: structured logging + optional error reporting

- **Before:** scattered `console.log`/`console.error` calls.
- **Now:** `logger.js` emits structured JSON log lines (which Netlify's
  Functions log panel already captures — no new infra required) and can
  optionally forward errors to Sentry via its plain HTTP envelope API if you
  set `SENTRY_DSN` yourself; a no-op otherwise. Not a claim to be a full
  observability platform — see `ROADMAP.md` if you need one.

## Not done — and why, honestly

RBAC, MFA/passkeys, a plugin marketplace, autonomous unattended mission
execution, real semantic (vector) memory search, and native Windows/macOS/
mobile apps were all requested. None of them are implemented, because each
one needs a real infrastructure decision this project doesn't currently
have (per-user accounts instead of one shared access code; a persistent
background worker, since Netlify Functions are request-scoped; a vector
database; a native app build/release pipeline) — not just more code sitting
on top of what's here. `ROADMAP.md` explains each one concretely, including
what would need to be decided or added to build it for real.
