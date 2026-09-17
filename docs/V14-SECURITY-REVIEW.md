# SAMVIT V14 — Dedicated Security Review (P21)

Date: 2026-09-18 · Scope: everything changed for V14 (identity, email, auth hardening, notifications, browser foundation, proactive signals) plus regression checks on the carried V12/V13 rails.

## 1. Identity & registration (P1)

| Check | Result |
|---|---|
| Invitation code gate | **Removed.** `registerAccount` takes email+password only; an `ACCESS_CODE`-shaped field in a register request is inert. Test: `accounts.test.js` V14 block 1. |
| Owner-claim code/page | **Removed.** `netlify/lib/owner-claim.js` deleted; no residual symbol (grep-verified). |
| First-user ownership bootstrap | **Removed.** `finalizeAccount`'s `meta.ownerAccountId` CAS + legacy migration are gone (`account-migration.js` deleted). First verified account is a `member`; no `meta` key is written. |
| Hidden mechanism replacement | **None.** Administrative access is env config (`SAMVIT_ADMIN_EMAILS`), evaluated server-side per request in `accountRole`; it gates only the Stripe-ops console. No client input influences it. |
| Registration response uniformity | Register and resend endpoints respond with a fixed 202 shape for new/pending/verified/unknown addresses; responses are byte-identical (test: email-v8 "identical status, body and no authentication cookie"). |
| Signup rate limits | New per-IP `account-register:*` 3/min on top of login 5/min and the global KDF 60/min budget. |

## 2. Email verification (P2)

| Check | Result |
|---|---|
| Token generation | 32 bytes CSPRNG → 64-hex, prefixed `usr_<uuid>.<hex>`; the raw exists only in the email text. |
| Storage | SHA-256 hash only, on the account record (`emailChallenges`, max 4, 30-minute expiry, bound to `sessionVersion`). |
| Single use | Consume burns ALL live challenges and bumps `sessionVersion`; concurrent double-consume yields exactly one success (tested). Replay is a 400. |
| Verify ≠ password reset | `kind=verify` confirms the inbox and activates the account with NO password step (and never requires one); `reset`/`enable` alone take a new password. |
| Resend abuse | Per-account 60s cooldown + 6/day rolling cap, enforced at enqueue; suppression is silent (accepted shape unchanged). |
| Failure honesty | Production without a provider → hard 503 (`fail` with `status:503`); the outbox worker records `failed` jobs, never pretends, never logs the address (asserted: failure record contains no email, no password). |
| Dev capture | Real blob outbox, never real inboxes; usable for local verification + tests. **Provider precedence:** a configured RESEND key always wins over `SAMVIT_EMAIL_PROVIDER=dev`, so production cannot be muted into capture mode (fixed during this review). Dev-capture rows are scrubbed on account deletion. |

## 3. Auth hardening (P4)

| Check | Result |
|---|---|
| Per-account lockout | 8 consecutive failures → 15-minute timed hold; IP-independent. Counter clears on success and on any challenge consume. |
| Generic failures | "Email or password is incorrect." for all bad-credential paths; dummy KDF preserved for unknown users (in `passwords.js`). |
| Unverified access | Unverified accounts cannot sign in (403 `needsVerification`), and a minted-before-verify session is gated 403 server-side on every protected path. |
| Session hygiene | Verify, reset, enable, and password change all bump `sessionVersion` → every prior session dies (tested end-to-end incl. handler level). |
| CSRF | Origin check on all POSTs; cookies `HttpOnly; Secure; SameSite=Lax` (unchanged from V12/V13, re-verified). |
| Logging | No secrets/tokens/passwords/challenges in any log path (grepped). |
| Endpoint isolation | Existing scoping suite passes unchanged (+identity-V14 cross-account checks). |

## 4. Data lifecycle & notifications (P16)

- Notification preferences: boolean whitelist; unknown keys rejected; non-booleans 400. Security emails default ON, mission emails default OFF-opt-in.
- Mission emails are once-only per job (CAS `notifiedAt` stamp + provider idempotency key). Audit + inbox caps are bounded.
- Device pairing/revocation + password change raise security emails best-effort; failures never block the action and are never silently "sent".
- Dev-outbox rows are personal data → scrubbed in `purgeAccount`.

## 5. Browser foundation (P10)

- URL validation rejects non-http(s), credentials, private/loopback/link-local/multicast hosts, `.local/.internal/...` names.
- `guardedFetch` re-validates EVERY redirect hop and checks the DNS answer for private IPs (DNS-rebinding defense); 128 KB cap; text-only content types; 15 s timeout.
- All fetched content is wrapped in an explicit UNTRUSTED banner + provenance; model-tool descriptions forbid treating page text as instructions/permissions.
- Per-origin permission records live on the device (`browserOrigins`), resolved by the SAME policy engine + approval ledger as fs/commands; origin decisions persist only via the audited approval path (or explicit UI edit).
- `browser.open` capability is shell-free (`rundll32`/`open`/`xdg-open`), returns the honest "cannot see or control" note.
- No permission side channels: reading a page adds no scopes/commands (asserted).

## 6. Proactive signals (P14)

- Opt-in only; watch targets must be inside an authorised read scope, checked on the cloud AND re-checked locally on the agent (both tests).
- Caps: 3 watches/device; 20 signals/day; 30-day expiry; depth-0 watch on Linux (documented).
- Signals are advisory inbox rows + audit entries only — no model calls, no mission starts, no computer actions can be triggered by them.
- Cancel removes the watcher immediately (test: no events after reconcile to empty).

## 7. Regression posture of carried rails

- Device pairing crypto (hashed tokens at rest), queue leases/idempotency, kill switches, permissions matrix, sandbox isolation: unchanged; the device-mission V13 composite suite passes (unchanged).
- Billing webhook idempotency + student verification flows: untouched and green.
- `billing-operations` is the only role-gated surface; its gate moved from `owner` (removed identity) to `admin` (env-configured).

## Residual notes (stated honestly)

1. `/api/email` resend timing differences between known/unknown addresses exist in principle (queue insertion is uniform; sending happens in the worker). Response bodies remain identical; this is documented rather than claimed solved.
2. Dev-capture outbox contains raw links by design — it is a development-only artifact, blocked whenever a production provider is configured.
3. `browser.fetch` shares the OS resolver via `node:dns`; the private-IP check defends the common SSRF shapes, but exotic DNS configurations (e.g. split-horizon lying public) remain an operator concern.
