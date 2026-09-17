# SAMVIT V14 — CORE AUTONOMY, IDENTITY & PRODUCTION READINESS
Engineering record. P0 audit → P1–P4/P16/P10/P14 implemented, P5–P9/P12–P13/P15/P17–P20/P22–P23 audited-and-preserved, P21 review, P25 proof.

## What changed (and what was deliberately preserved)

### Identity (P1) — the load-bearing change
Registration is open: email + password, nothing else. Removed, with tests asserting their absence:

- The `ACCESS_CODE` registration gate (the env var survives ONLY as the explicit local-dev toggle, documented in `.env.example`).
- `SAMVIT_OWNER_CLAIM_SECRET` and `netlify/lib/owner-claim.js` (deleted).
- The "first verified account becomes owner" bootstrap: `finalizeAccount` no longer CASes `meta.ownerAccountId`, `netlify/lib/account-migration.js` is deleted, no `meta` key is created for new deployments. Legacy single-tenant keys are inert — deliberately NOT re-adopted by anyone.
- No replacement hidden authority: administrative access is configuration (`SAMVIT_ADMIN_EMAILS` → role `admin`), evaluated server-side per request, gating only the Stripe-ops console. The authenticated account is the identity boundary.

### Email service abstraction (P3)
`netlify/lib/email/service.js`: four typed senders (`sendVerificationEmail`, `sendPasswordResetEmail`, `sendSecurityNotification`, `sendMissionNotification`) over an env-selected provider: Resend (production, real key + verified from + HTTPS origin) or dev-capture (writes to a blob outbox, never real inboxes). Fail-closed 503 when nothing is configured outside development. A configured Resend key always outranks a dev request. The V12/V13 durable outbox (leases, ≤5 attempts, provider idempotency keys) is preserved and now routes through the abstraction.

### Verification (P2)
- Verify/reset/enable are separate challenge kinds; `verify` activates the account with **no password step**.
- Tokens: CSPRNG, SHA-256-hashed at rest, 30-minute, single-use (consume burns every live challenge + rotates `sessionVersion`), format-tight, kind-checked, never logged or returned.
- Resend: per-account 60 s cooldown + 6/day rolling cap; suppressions are silent and response-identical.
- Registration / signup / resend endpoints answer a single fixed 202 shape.

### Hardening (P4)
Per-account brute-force lockout (8 failures → 15 min hold), registration per-IP cap (3/min), uniform credential errors, unverified accounts refused sign-in (403 `needsVerification`), all session-invalidating events rotate `sessionVersion`. Existing cookie flags/CSRF/rate limits carried unchanged.

### Notifications (P16) & preferences (P24)
Account preferences `{emailSecurityNotifications: true, emailMissionNotifications: false}` (security default-on, mission default-off-opt-in), editable in Account settings through a strict boolean-whitelist endpoint. Sent: password change, device paired, device revoked (security); mission terminal outcomes (opt-in, once per job via CAS stamp + idempotency key).

### Browser foundation (P10) — two honest capabilities only
`browser.open` (SAFE): hands a URL to the OS browser; the capability's own description states Samvit cannot see or control the page. `browser.fetch` (OBSERVE): SSRF-guarded text fetch (scheme/credential/private-host checks, DNS-answer privacy check per hop incl. redirects, 128 KB cap, text-only, 15 s) wrapped in an UNTRUSTED banner. Per-origin permissions on the device record, resolved by the SAME policy engine + approval ledger; approved/denied decisions persist from the audited approval path or explicit Computers UI. Reading grants nothing.

### Proactive signals (P14) — one opt-in monitor kind
Folder-change watches: inside authorised read scopes only (checked cloud-side AND locally on the agent), 3/device max, 30-day expiry, 20 signals/day/device, one-click cancel (watcher dies immediately), every enable/disable/signal audited. Signals land in a capped inbox — advisory only; they cannot start missions, call models or act.

### Carried, verified, not duplicated (P5–P9, P12–P13, P15, P17–P20, P22–P23)
Background missions, device queue/receipts, device-aware planning, idempotency, observe→verify→repair, adapter registry ("declared-unavailable" voice/browser/vision adapters), desktop agent persistence, the permission rails voice shares, model routing, hierarchical planning, world model, experience learning, observability, and the mission/computer test suites are preserved and green — documented here rather than re-implemented. Vision (P11) grants no permissions, exactly as before.

## UI (P24)
Signup dialog without invitation fields (with "verify before first sign-in" copy), auto-completing verify page (no password), reset/enable password pages, resend entry point, Account settings notification toggles, Computers page: browser site permissions (allow/block/move/remove) and folder-change watch management + signals inbox.

## Test & verification counts
- **300/300** tests passing (`node --experimental-test-module-mocks --test tests/*.test.js`): 269 carried V12/V13 + 31 new/rewritten across `accounts.test.js` (5), `email-v8.test.js` (7), `identity-v14.test.js` (6, incl. **P25 golden path**), `browser-v14.test.js` (8), `proactive-v14.test.js` (3), `lifecycle-v8.test.js` rewrites.
- Build: `npm run build` clean.
- P25 exercised as a single continuous scenario: signup → captured verification email → verify → active account → login → pair → scope → multi-step mission → pause mid-run → resume → verified outcome → exactly one mission email.

## Explicitly not done (stated, per brief)
- No screenshot/DOM/form browser automation (would be claims beyond the architecture; `browser.open/fetch` are the real first capabilities and are scoped as such).
- Proactive signals cannot dispatch missions — that bridge awaits a separate, user-reviewed design.
- `/api/email` resend envelope timing is uniform in content, not provably so in milliseconds (see P21 residual notes).
