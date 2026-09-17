# What changed from the original prototype

> **This file covers the v1→v2 pass** (real AI, real persistence, removing
> fake/simulated features). For the v3 pass (security hardening, provider
> retry/fallback, storage scalability fixes, frontend modularization, real
> automated tests, and what's honestly still out of scope), see
> [`CHANGES-V3.md`](./CHANGES-V3.md).

The original zip was a well-designed UI shell with **zero real AI behind
it** — no API calls of any kind, no persistence, and several features that
actively claimed things that weren't happening. This is the full list of
what was found and what was done about it.

## The core problem

`grep`-ing the original `app.js` and `intelligence.js` turned up no
`fetch()` calls, no API keys, and no `localStorage`. Every chat "response"
came from `ResponseBuilder`, a keyword-matching function returning
hardcoded strings, wrapped in `setTimeout()` to fake thinking time. Memory,
the AI Council, and the Execution Engine worked the same way — convincing
UI driven by nothing.

## Fixed: no real AI

- **Before:** canned string templates.
- **Now:** real streaming calls to Claude, GPT, Gemini, and Grok, proxied
  through Netlify Edge Functions so your API keys stay server-side
  (`netlify/edge-functions/chat.js`, `netlify/lib/providers.js`).

## Fixed: memory that didn't survive a refresh

- **Before:** a plain JS array. Every memory you "saved" vanished on reload.
- **Now:** real CRUD backed by Netlify Blobs (`netlify/functions/memory.mjs`) — persists across sessions and devices.

## Fixed: the AI Council was entirely scripted, and paywalled

- **Before:** a hardcoded "debate" between models — including fictional
  ones (`deepseek-coder`, `llama-3`) that weren't wired to anything — with
  a fabricated confidence score, "minority opinion," and citation list.
  The whole feature was also gated behind a fake `$50`/`$100`-a-month
  subscription tier that didn't charge anyone anything or unlock anything
  real.
- **Now:** real parallel calls to whichever models you check, streamed
  live side by side. No paywall — it's gated only by which API keys you've
  actually configured. An optional "Synthesize After" toggle makes one
  more real call to compare the real answers (clearly labeled as one
  model's opinion, not a fact-check).

## Fixed: the "Execution Engine" claimed to take real actions it never took

This was the most actively misleading part of the original prototype. Its
progress bar auto-filled itself while log lines claimed things like:

> `[MODULE] GitHubModule activated: committed verified tests and build
> scripts directly to remote repo.`
> `[MODULE] SlackModule activated: dispatched build completion message
> notification to team channel.`

None of that happened — there was no GitHub or Slack integration at all.
It also simulated a fake mid-run error and "fallback recovery," and an
"approval" gate that claimed a real filesystem write or deployment was
about to happen.

- **Now:** goal → real plan generation (`netlify/edge-functions/workflow.js`
  asks a real model for a structured JSON plan). Execution is a manual,
  honest checklist: you do each step yourself and mark it complete: no
  fake GitHub/Slack/Notion/Figma modules, no auto-filling progress bar, no
  fabricated errors.

## Fixed: the "SAMVIT Prime" executive dashboard

- **Before:** claimed to show live compilation/deployment progress across
  11 platforms (Web, Windows, macOS, Linux, iPhone, Android, Vision Pro,
  browser extension, VS Code extension, JetBrains plugin, CLI) — all tied
  to the same fake progress percentage, gated behind the fake `$100/mo`
  tier badge.
- **Now:** removed. There was no honest way to keep "11 platforms building
  in real time" as anything but fiction, since Samvit doesn't build or
  deploy software.

## Fixed: security theater

- **Before:** an "AI Security Guardrails" panel with three shields
  ("Prompt Injection Shield," "Context Leak Isolation," "Output
  Validation") that were hardcoded to show green always, regardless of
  anything. A profile modal claimed `Security Clearance: LEVEL A (ROOT)`
  and `Authorized Agent IP: 127.0.0.1`. Passkey/MFA toggles claimed to
  enroll real WebAuthn credentials. A "Revoke Key" button claimed to
  revoke a real cryptographic session.
- **Now:** a "Real Protections" panel that reports actual state — whether
  an access code is set, the real configured rate limit, and the
  architectural fact that keys never reach the browser. The passkey/MFA/
  session-revoke toggles are still there but no longer claim to do
  anything they don't; the real access control is the `ACCESS_CODE` +
  `SESSION_SECRET` gate described in the README.

## Fixed: no protection against a public URL

- **Before:** none — this is a real gap the original design didn't
  address at all, since it was never meant to be deployed. Not "fake,"
  just missing: a deployed Netlify site is a public URL, and without a
  gate, anyone who finds it can spend your API budget.
- **Now:** an access-code + signed-session-cookie gate
  (`netlify/functions/auth.mjs`), plus real rate limiting backed by
  Netlify Blobs (`netlify/lib/security.js`) on every AI-calling endpoint.

## Fixed: fake billing

- **Before:** a "$100/mo ACTIVE" badge and a subscription-tier dropdown
  (`Free`/`Pro`/`Ultra $50`/`Ultimate $100`) with no payment processor
  behind any of it — decoration that implied a working paid product.
- **Now:** replaced with a free "Advanced Mode" toggle that shows extra
  detail (per-step time estimates) — no fake payment claims anywhere.

## Left as illustrative (clearly labeled, not removed)

A couple of small things weren't worth ripping out entirely, but are now
honestly labeled instead of presented as real:

- The "Connected Sessions & Devices" list in the security panel is
  example data — Samvit doesn't track real device sessions yet. Labeled
  "Example — not live-tracked" in the UI.
- The ambient "AI Activity Log" ticker on Mission Control is cosmetic
  flavor (like a screensaver), not real telemetry — it was left alone
  since it doesn't claim anything specific.

## Not attempted (out of scope for this pass)

- Real multi-user accounts (currently one shared access code)
- Real WebAuthn/passkey/MFA
- Payment/billing integration
- Real third-party integrations (GitHub, Slack, Notion, Figma) — the
  Execution Engine no longer *claims* to have these, but building them for
  real is a separate project
