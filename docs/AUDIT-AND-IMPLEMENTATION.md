# Samvit 5: audit, research, and implementation

Research: September 13, 2026. Final verification: September 14, 2026. Input: `samvit-final-merged.zip`, 52 entries. This report concerns the supplied code and the changes delivered with it, not an independently verified production deployment.

## Outcome and product interpretation

Samvit's useful core is one place to access several AI providers at different costs, preserve work, and compare perspectives. Its current architecture calls external models; it does not train a model, create general intelligence, learn new capabilities autonomously, or guarantee the best answer. The implementation strengthens that multi-model workspace into a runnable private-beta foundation.

The original artifact was incomplete. The main page referenced **19 absent local JavaScript files and an absent stylesheet**. The frontend could not be repaired by changing colors alone. The original HTML and billing UI are preserved under `docs/legacy-*`; the entry page is rebuilt against the real backend APIs.

## Phase 1: architecture and findings

| Priority | Finding in uploaded code | Effect | Delivered change |
|---|---|---|---|
| Critical | Missing frontend scripts and CSS | Controls had no implementation | New ES-module frontend and self-hosted CSS/assets |
| Critical | Missing `PLAN_PRICING`, `getEntitlements`, and subscription re-export | Modules could fail at load time | Restored shared contracts; import check now actually runs |
| Critical | `package-lock.json` omitted Stripe dependency | `npm ci` failed | Synchronized lockfile and package metadata |
| Critical | Invalid `await` in supplied test; only one test file despite large documented test claims | Baseline verification could not run | Repaired the existing tests and added targeted regressions/endpoint tests |
| High | Finish events emitted before final usage; repeated completion; EOF treated as success | Missing or duplicate usage and misleading success | Protocol-aware completion, trailing usage capture, truncated-stream errors |
| High | Parser assumed LF-only SSE framing | Valid CRLF/chunked events could fail | Shared UTF-8 SSE parser with CR/LF/CRLF and multiline data |
| High | One price estimate per provider | Cheap and premium models were priced identically | Per-model standard text pricing and actual model attribution |
| High | Monthly plan limits were declarations only | Concurrent calls could overspend | CAS-protected reservations on chat, Council, critique, and workflow |
| High | Billing functions used a nonexistent Node `context.env` contract | Runtime configuration/auth failures | Node environment adapter |
| High | Client chose arbitrary checkout price and return URLs | Invalid purchase/redirect behavior | Server allowlist and same-origin generated redirects |
| High | Verified Stripe events could affect a single shared account regardless of customer | Unrelated customer state could change workspace plan | Stored-customer binding; test-mode-only billing; configured price mapping |
| High | Partial subscription normalization reset unmentioned fields | Status events could reset plans/student metadata | Preserve omitted fields; unknown statuses fail closed |
| High | Login rate limiting could fail open | Authentication protection degraded silently | Sign-in now fails closed on rate-limit outage |
| Medium | Static publish directory was the source root | Unneeded source/docs exposed publicly | `dist` build containing frontend/shared assets only |
| Medium | Memory schema and legacy content disagreed | Notes could normalize to empty text | Preserve both legacy content and current text metadata |
| Medium | Fresh memory store auto-seeded examples | Example records looked like workspace data | Empty conditional initialization |
| Medium | Saved conversation payloads were loosely typed/unbounded | Invalid or very large objects persisted | Role/type/size validation |

## Phase 2: researched decisions

Research was targeted at the observed defects using primary documentation. No claim is made to have searched “the whole web.”

**Model catalog.** The supported list contains nine text models across four providers, organized into economy, balanced, and frontier price categories. Model IDs and standard token rates were checked against [OpenAI's model catalog](https://developers.openai.com/api/docs/models), [Anthropic's model overview](https://platform.claude.com/docs/en/models/overview), [Google's Gemini pricing](https://ai.google.dev/gemini-api/docs/pricing), and [xAI's model documentation](https://docs.x.ai/developers/models). Source URLs and review date travel with the catalog. Google's published January 1, 2027 rate change for Gemini 3.8 Flash is represented as a dated transition. Provider account access still requires a live test.

**Streaming.** The [WHATWG SSE specification](https://html.spec.whatwg.org/multipage/server-sent-events.html#parsing-an-event-stream) defines line endings, data-field joining, and event dispatch. The shared parser follows those framing rules, including byte-split multilingual content and discarding incomplete events at EOF. Provider adapters separately decide what a successful model completion means; OpenAI-compatible responses wait for the terminal marker after usage. Stream cancellation releases the reader.

**Cost enforcement.** [Netlify Blobs documentation](https://docs.netlify.com/build/data-and-storage/netlify-blobs/) describes conditional writes and consistency controls. This release uses the existing compare-and-swap primitive to reserve estimated maximum cost and tokens before a provider call. Budget and subscription decisions use strong reads. This is appropriate for a small shared workspace; a public service should use a transactional usage ledger and provider reconciliation. That last recommendation is an engineering judgment based on the workload, not a claim that Blobs is an invoice system.

**Billing.** [Stripe Checkout session creation](https://docs.stripe.com/api/checkout/sessions/create) and [Stripe webhook guidance](https://docs.stripe.com/webhooks) informed server-owned checkout settings, customer binding, signature handling, and event processing. A checkout session is not proof that a subscription is active. The webhook retains failed-event retry semantics and now accepts any matching `v1` signature during key rotation. Timestamp guards reject older subscription updates; equal-timestamp events and subscription switching still require API reconciliation before live billing.

**Visual design.** The product direction uses ivory surfaces, charcoal navigation, lavender accents, readable typography, quiet borders, focused action cards, and clear connectivity states. [WCAG target-size guidance](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html) informed larger controls and spacing. Keyboard focus indicators, a skip link, labelled inputs, responsive navigation, dark mode, and reduced-motion behavior are implemented. This is not a full WCAG conformance audit or a claim that all Gen Z users share one aesthetic preference.

## Phase 3: implementation behavior

### Model access

Users can select a model directly or request a price category. Auto uses a deterministic cheapest-available policy within that category. It does not benchmark prompts or call an extra classifier. Key presence is reported as configured, not guaranteed healthy.

Explicit fallback tries a bounded set of other providers only before text appears. The replacement must be in the same price category and no more expensive under the comparison workload. Fallback can still consume additional usage because it is another attempt. The production metered path does not automatically retry uncertain paid calls.

### Budget enforcement

The shared monthly record counts reserved plus settled input tokens, output tokens, and estimated micro-USD. Concurrent callers cannot independently spend the same remaining allowance. Final usage releases unused reservation; interrupted, crashed, or unreported usage retains a conservative charge. Storage failure prevents new paid calls. UTC calendar months and account IDs separate ledger records.

Free has a $0.10 operator-funded monthly trial within the inherited token caps. Other plan limits are inherited. A server setting may lower the spend limit. These safeguards are estimates based on the maintained catalog, not exact invoice reconciliation. The analytics view records completed calls only and can differ from the ledger after failures. Reservations left by a killed worker require operator reconciliation or the next month.

### Interface and data

The nine routes provide chat, model search/filtering, Council, generated plans, projects, memory, usage, workspace plan comparison, and settings. Chat supports stop, explicit errors, safe text/fenced-code rendering, copy, text export, and conversation persistence. Save completion is guarded against starting a new conversation while a previous save is still in flight. A disconnected backend produces a visible preview state instead of fake responses, counts, or successful saves.

Existing persistence APIs are retained. Everyone using the shared access code sees the same records. Saved memory is not silently injected into prompts. Plans are checklists, not autonomous executors. Legacy connector functionality remains backend-only.

### Packaging

`npm run build` checks server/shared imports and referenced static assets, then creates `dist`. Runtime CSS, JavaScript, fonts, and icons do not depend on an unpinned third-party CDN. A restrictive same-origin content security policy is configured. Server source, tests, historical documentation, and `.env` are excluded from the public static output.

## Verification

- **71 automated checks passed**: 33 repaired existing billing/storage checks, 27 new reliability checks, and 11 tests against actual endpoint handlers with mocked provider/storage boundaries.
- Import validation passed for **40 server/shared modules** and the referenced frontend assets.
- The static production build passed.
- Netlify regular function packaging passed using `netlify functions:build`. Generated bundles were removed from source after verification.
- Chromium browser verification passed; desktop light/dark and mobile screenshots were visually inspected. Details are in `VERIFICATION.md`. Test-only response fixtures do not ship in the runtime frontend.
- No provider credentials were used, no live model access was proven, no payment was processed, and no remote deployment was performed.

## What must happen before a public paid launch

1. Replace the shared access code with real identities, account recovery, verified sessions, workspace membership, and owner-only billing permissions. Partition every record, index, rate limit, and budget by the authorized workspace.
2. Run live integration checks against every listed model using the intended provider accounts. Pin/test provider API versions, failure modes, output limits, cancellation, and actual returned usage.
3. Add a transactional usage ledger, reconciliation of interrupted calls, billing-period alignment, per-model/tool cost coverage, and tested spending economics. Current pricing is inherited and is not a validated margin model.
4. Finish Stripe lifecycle reconciliation, same-second event ordering, subscription replacement handling, portal permissions, refunds/cancellations, and production integration tests. Live mode remains disabled until this is engineered.
5. Benchmark model-routing quality on a representative task set before marketing an “intelligent best-model router.” Measure quality, latency, cost, and failure rate; define fallback tradeoffs explicitly.
6. Add requested capabilities incrementally: secure retrieval from memory/files, real tool execution permissions, background jobs, attachments/multimodal adapters, and connected integrations. None should be represented as already available.
7. Run deployment-specific load, accessibility, privacy, retention, recovery, and abuse testing. This code review and local suite are not a full production security audit.

The result is a rebuilt and tested multi-model private-beta foundation. “Universal and generational AI” remains a product ambition that needs measurable capabilities and staged validation, not a label the current code can substantiate.
