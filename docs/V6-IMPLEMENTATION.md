# Samvit v6 — implementation and setup

Built from the user-supplied `Samvit-v5-new-version.zip`, not an older repository snapshot.

## Operator setup

Install with Node 22.13 or newer, then run `npm ci` and `npm run dev` (Netlify). Use `npm run build` and `npm run preview` for the static UI only; a static preview does not run APIs. Netlify Blobs and the existing authentication/subscription configuration remain required for backend operation.

In the deployment environment set:

| Setting | Purpose |
| --- | --- |
| `ACCESS_CODE` and `SESSION_SECRET` | Existing shared workspace authentication |
| `SAMVIT_KEY_ENCRYPTION_SECRET` | Random secret, at least 32 characters, used only on the server to encrypt keys |
| `SAMVIT_CONNECTIONS_ADMIN_CODE` | Separate random owner-only code, at least 16 characters, for key and combo management |
| `SAMVIT_OMNIROUTE_BASE_URL` | Optional trusted HTTPS API base ending in `/v1` for your authorized gateway |

Generate each secret independently with `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"` on your own computer. Do not place real values in frontend files, this README, the public repository, or a shared ZIP. Keep the encryption secret stable; this version does not include a bulk re-encryption migration. Rotating it means saving the provider keys again.

Open Connections, enter the owner management code, choose a provider, set an exact model ID, and save the matching API key. Known catalog models use catalog cost estimates. Custom models need positive conservative input/output estimates per million tokens. Verified zero-price models from the live OpenRouter catalog use zero rates. Testing sends a small inference request, consumes account allowance where applicable, and recovers a blocked connection only after successful completion. The management code clears when the page refreshes; keys and management codes are never written to localStorage or IndexedDB.

The directory supports OpenAI, Anthropic, Gemini, xAI, OpenRouter, Groq, Cerebras, Mistral, DeepSeek, Together AI, DeepInfra, Fireworks AI, Hugging Face, NVIDIA NIM, and an optional OmniRoute gateway. Direct endpoints are allowlisted. Arbitrary browser-supplied base URLs are not accepted, and redirects are not followed by saved-connection inference. Account terms and model-specific access remain the provider's responsibility; provider listings are not a guarantee of availability.

OmniRoute is an integration, not a bundled service. The server must be able to reach the configured trusted HTTPS gateway. A cloud Netlify function cannot reach a gateway running only on your laptop's localhost. Enter the gateway model/combo ID in the model field. Gateway estimates must cover the most expensive allowed underlying model; Samvit cannot see hidden gateway fallback costs. Samvit's free-only policy deliberately excludes opaque gateway combos.

## Agent teams

| Active subscription | Agents per run |
| --- | ---: |
| Free | 0 |
| Pro | 2 |
| Ultra | 3 |
| Ultimate | 4 |

Agent Studio and the paid plan cards offer job selection and editable role assignments. Each agent can use a deployment model, saved connection or saved combo. The server reads the stored subscription independently on every run; selecting a plan tab is only a design preview and cannot grant access. Invalid or unavailable subscription storage blocks execution.

Agents execute sequentially so each receives the earlier contributions. The final agent integrates the result. There is no extra unmetered synthesis model. These are bounded text collaboration pipelines, not autonomous agents with browser, filesystem or purchasing tools. Each agent has a 1,536-token output request cap and a 16,000-character output safety cap; the team request has an overall four-minute limit. Provider interruption or cancellation stops the handoff. Partial output remains visible and can be exported. Team drafts are saved locally on the device; run output is held on the page and must be exported before a reload.

The app still has one shared access-code account (`samvit-user`). Everyone using that code shares the subscription, model connections, conversations, and budgets. The separate management code reduces credential-management access; it is not a substitute for per-user authentication and roles.

## Routing and spend behavior

A combo contains 2–4 different saved connection IDs. Priority starts with the first eligible member. Round robin persists and rotates the starting position using conditional storage writes. Fallback only happens before visible text begins.

| Outcome | Behavior |
| --- | --- |
| HTTP 401 / 403 | Mark credential connection blocked, report issuer/key guidance, then try the next combo member |
| HTTP 402 or recognized exhausted-credit/quota error | Mark exhausted connection blocked until owner recovery or key rotation; try the next member |
| HTTP 429 rate limit | Respect `Retry-After` (seconds or date, bounded to one day), otherwise use a one-minute cooldown |
| HTTP 5xx | Brief cooldown; another member may run before any output |
| Uncertain network failure, timeout, partial stream | Stop, retain partial output and conservative budget reservation; no replay |
| No eligible member | Return a clear failure; do not add paid candidates |

Connection health is saved across requests. Rotating a connection protects it from stale health updates. A concurrent success cannot reopen a terminal quota/auth block; explicit successful owner testing can. Health persistence failure stops routing. There is no provider-wide distributed circuit breaker or automatic polling of balances; quota is inferred from actual provider responses. Cooldowns become eligible lazily on a future request. The UI reports states rather than inventing remaining-token numbers.

Every attempt reserves against the shared monthly token/spend budget before contacting a model. Definite HTTP rejections release their reservation; uncertain or partial calls retain conservative accounting. Completed calls settle reported usage and contribute to analytics. Upstream prices can change and custom estimates are operator supplied: this ledger is a guardrail, not a provider invoice or a guaranteed spending ceiling at the upstream account. Keep provider-side hard limits configured independently.

## Free-model discovery

The live catalog reads OpenRouter's public models endpoint, cached for five minutes. It includes text-output models with `:free` IDs and explicitly zero pricing, including any per-request fields. Missing or nonzero pricing is excluded. A saved model's zero pricing is checked again against the current cached catalog before use; if the catalog cannot be obtained, free-only inference fails closed. Free-only combos never gain paid members automatically. Other providers' free plans and trial credits are labeled as limited allowances; they are not treated as guaranteed zero-price routes. Availability and request quotas may change.

Research informed the design, without copying OmniRoute code:

- [OmniRoute resilience guide](https://github.com/diegosouzapw/OmniRoute/blob/release/v3.8.51/docs/architecture/RESILIENCE_GUIDE.md): distinguishes provider failures, individual connection cooldowns and terminal exhausted-credit states. Samvit implements a smaller connection-level mechanism.
- [OpenRouter model fallbacks](https://openrouter.ai/docs/guides/routing/model-fallbacks): documents ordered model failover. Samvit exposes an explicit ordered combo and spending policy.
- [OpenRouter model catalog](https://openrouter.ai/docs/api/api-reference/models/list-all-models-and-their-properties): model discovery and price metadata.
- [Groq rate limits](https://console.groq.com/docs/rate-limits): free access is constrained by request and token quotas.
- [Hugging Face pricing](https://huggingface.co/docs/inference-providers/pricing): included credits are distinct from permanently free inference.

## Appearance and motion

Your workspace offers Warm paper, Aurora, After hours, Forest light and Open water backdrops; violet, blue, rose and green accents; focus mode; and light/dark themes. Custom JPG/PNG/WebP uploads are limited to 5 MB, decoded and resized to a maximum dimension of 1,600 pixels, then saved in local IndexedDB. Uploaded wallpapers are never sent to Samvit's backend or model providers. Users can remove them. Appearance controls persist in localStorage.

IntersectionObserver reveals page sections as they enter view. Streamed contributions retain their DOM nodes so animation does not restart on every token. Motion can be disabled manually, and the operating system's reduced-motion preference always takes priority. Content remains visible when reduced motion is active or IntersectionObserver is unavailable. Mobile layouts and real wallpaper persistence were checked in Chromium.

## Billing retained from the uploaded ZIP

Checkout and portal remain gated to Stripe **test** keys. The existing 30% student pricing, server eligibility list, checkout handling, portal, and webhook code are retained. There is no new hosted student-ID verification flow, individual student account system, or live billing activation in this milestone. Production credentials, actual provider availability, a deployed Netlify environment, live payments, and real student verification were not exercised in this environment.

## Verification

- `npm ci --no-audit --no-fund`: clean dependency installation including install scripts succeeded.
- `npm test`: 96 tests pass, including 22 new v6 tests of capabilities, encrypted storage, ownership, combo policies, quota failover, partial streams, budget settlement, free-price changes and concurrency recovery.
- `npm run build`: 53 server/shared modules import successfully; frontend assets resolve and public files build into `dist`.
- `scripts/browser-qa.mjs`: existing routes, chat rendering/persistence, responsive layout, themes, filters, draft handling and inert HTML checks pass with test fixtures.
- `scripts/browser-v6.mjs`: plan-to-job selection; 2/3/4 agent layouts and access states; role editing; streamed contributions; connection and combo creation/use; free discovery; no credential persistence; image upload/delete/reload; accent, focus and motion controls; desktop/mobile layouts pass with test fixtures.

Screenshots in `docs/v6-*.png` show the tested interface. Any model output in those screenshots is explicitly synthetic test data, not a real model response. No real provider keys or payment secrets were available or included.
