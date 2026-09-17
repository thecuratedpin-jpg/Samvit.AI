# What changed in v4

v3 (see `CHANGES-V3.md`) hardened security, fixed the memory storage
bottleneck, and modularized the frontend. v4's brief asked for more of the
same ambition as v3 — an AI Router, a Plugin SDK reaching GitHub/Figma/
Notion/Slack/etc., and now four paid subscription tiers with real prices.
Same approach as before: build what can be made genuinely real, and write
down — concretely, not vaguely — what the rest needs instead of faking it.

This picks up from a `v4-phase0` checkpoint that had already landed the
Router, the Plugin SDK, and the `fetch-url` example plugin as tested,
working *backend* pieces not yet connected to anything a user would
actually see. This session's job was mostly finishing that connection and
verifying it for real, plus adding the one new thing v4 asked for that
hadn't been touched: the Subscription/plan model.

## Added: the AI Router is now wired into chat, not just an endpoint

- **Before (v4-phase0):** `netlify/lib/router.js` — a real, tested, regex/
  keyword heuristic classifier (intent, complexity, suggested mode) — and
  its `/api/route` endpoint existed, but nothing in the UI called it.
- **Now:** after every chat reply, `chat.js` classifies the message that
  was just sent (in parallel with the real model call, so it adds no
  latency) and shows a small, dismissible suggestion chip if the message
  looked like it wanted Council or a tracked Mission instead — with a real
  one-click action (`sendLastMessageToMission()`, mirroring the existing
  `sendLastMessageToCouncil()`) that prefills the right view. It never
  switches views on its own; the user always chooses.

## Added: the Plugin SDK is now reachable from chat, not just an endpoint

- **Before (v4-phase0):** `netlify/lib/plugin-registry.js` and the
  `fetch-url` plugin (real SSRF defenses, hard timeout, manifest
  validation) existed and were unit tested, but there was no way to
  trigger a plugin from the actual product.
- **Now:** typing `/fetch <url> [question]` in chat calls the real plugin,
  and — if the fetch succeeds — hands the page's text to the model as
  context, with the follow-up question (or a sensible default) as what
  actually gets asked. A blocked/invalid URL is shown as an error and the
  turn never reaches the model, rather than silently sending the raw slash
  command as if it were a normal question.
- **Known limit, stated plainly:** this is a user-typed command, not the
  model deciding to use a tool. Real tool-use (the model choosing to call
  `fetch-url` based on the plugin's `inputSchema`) is a scoped, genuine next
  step — see `ROADMAP.md`.

## Added: Subscription/plan shape (not billing, not gating)

- **What the brief asked for:** Free/Pro ($15)/Ultra ($50)/Ultimate ($100)
  tiers, a 30% student discount, and Council gated to Ultra/Ultimate.
- **What's actually here:** `shared/models.js` gained `PLAN_PRICING` (the
  exact prices above, tested) and `normalizeSubscription()` — a real data
  shape, consulted nowhere as an access check.
- **What's deliberately NOT here:** any code that blocks a feature by plan.
  This app has one shared access code, not per-user accounts — a plan
  needs a "someone" to belong to, which doesn't exist yet — and no payment
  processor is wired in. A plan toggle that *looked* like it gated Council
  without a real account or a real charge behind it would be exactly the
  fake paywall `CHANGES.md` already tore out once. `ROADMAP.md` now has a
  dedicated section spelling out exactly what real billing would require
  (real accounts, then Stripe Checkout + webhooks) rather than leaving this
  unaddressed.

## Verified, not assumed

Every claim above was checked, not just written:

- `npm test`: **109/109 passing** (was 59 at the end of v3; v4-phase0 added
  Router + Plugin SDK tests, this session added Subscription model tests).
- Every backend file under `netlify/` and `shared/` was both syntax-checked
  (`node --check`) and actually import-resolved (`import()`), catching the
  kind of bad-relative-path bug `node --check` alone would miss.
- A real headless-browser pass (Playwright, backend responses mocked —
  the frontend code itself was untouched by the mocks) confirmed, with
  zero JavaScript errors: a plain chat message leaves the Router hint
  hidden; a multi-step message shows the hint with the correct text and
  the hint's action button correctly switches to Mission Control with the
  goal prefilled; and `/fetch <url> question` correctly calls the plugin
  with the parsed URL and renders the model's response afterward.
- That browser pass caught a real methodology bug in its own first attempt:
  the app's ~3.1s animated boot sequence (`runBootSequenceLoader` in
  `boot.js`, present since v1/v2, not new) meant an early test that didn't
  wait for the boot loader to actually finish saw a broken-looking app —
  not a real bug, but worth naming, since it's exactly the kind of
  false-failure a rushed verification pass would either miss or wrongly
  "fix" by touching working code.

## Not done — same honesty as v3 and v4-phase0

RBAC, MFA/passkeys, real subscription billing, a plugin marketplace beyond
one example plugin, model-initiated tool use, autonomous unattended
mission execution, real semantic memory search, and native apps remain
unbuilt, for the same reasons as before: each needs a real infrastructure
decision (per-user accounts, a payment processor, OAuth app registrations,
a background worker platform, a vector database, a native build/release
pipeline) that a single pass of code can't responsibly fake. `ROADMAP.md`
is current as of this session and says exactly what each one needs.
