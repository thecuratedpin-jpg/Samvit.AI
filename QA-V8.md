# Samvit v8 validation record

Source: the uploaded Samvit-v7-complete-source.zip, with the six supplied flaw-fix prompts applied in order. Historical source and documents remain included.

| Check | Result | Scope |
| --- | --- | --- |
| Clean dependency installation | Passed | npm ci on extracted project; package/lock versions updated together |
| Pass 1 tests/build | Passed | 124 tests; lifecycle and store inventory |
| Pass 2 tests/build | Passed | 125 tests; initial owner protection |
| Pass 3 tests/build | Passed | 130 tests; email verification/recovery |
| Pass 4 tests/build | Passed | 134 tests; direct xAI prices and fallback aging |
| Pass 5 tests/build | Passed | 140 tests; refund/dispute, verifier and revocation tests |
| Final test suite | Passed | 140 tests, zero failures, no skipped tests |
| Final build | Passed | 83 server/shared modules; frontend syntax/assets; generated dist |
| Desktop browser outage | Passed | Real UI; forced status/setup 503; one-click sign-in |
| Setup failure button | Passed | Failed setup still opens sign-in directly |
| Mobile browser outage | Passed | 390 × 844; sign-in reachable; no horizontal overflow |
| Automatic sign-in | Passed | Successful unauthenticated status opens dialog as before |
| Browser exceptions | None | Outage/unauthenticated scenarios |
| Deployed validator | NOT RUN successfully | Missing deployment and Stripe test configuration; explicit exit code 2 |
| Real Stripe checkout/portal/lifecycle | NOT VERIFIED | Requires configured test deployment and interactive validation |
| Real Resend delivery | NOT VERIFIED | Adapter tested with mocked HTTP responses |
| Real SheerID verification | NOT VERIFIED | Hosted/detail adapter tested with mocked responses; actual program/schema must be validated |

Browser runner: scripts/browser-v8.mjs. Screenshots: qa/signin-backend-outage-desktop.png and qa/signin-backend-outage-mobile.png. The browser executable and dependencies are environment tooling, not part of the source ZIP.

The source ZIP contains the complete source, lockfile, tests, build output, setup example and documentation. It excludes installed node_modules, credentials and temporary tooling. Read PRE-MONEY-V8.md before enabling any test billing integration. Live Stripe remains blocked.
