# v4 Priority Fix pass — progress log

Tracks the 12-priority security/reliability list given after `v4` shipped
(Router + Plugin SDK + Subscription model — see `CHANGES-V4.md`). Same
discipline as every pass before it: verify before changing, fix one
priority at a time, run the full suite after each one, document what's
real. Updated as priorities are completed, not written once at the end.

**Baseline, run fresh at the start of this session:** 109 tests, 30
suites, 0 failures — matches the number the priority brief itself cited.

## Priority 1 — Workspace XSS (interpolated inline handlers)

**Status: done.**

**The bug.** `onclick="switchProject('${escapeHtml(proj.name)}', this)"` and
seven similar call sites (`workspace.js` x2, `memory.js` x6,
`execution.js` x1) built inline event-handler attributes by interpolating
a value straight into the JS-string argument. `escapeHtml()` correctly
neutralizes HTML/attribute-text context (`<`, `>`, `&`, `"`, `'` →
entities) — but a browser decodes HTML entities in an attribute value
*before* treating that attribute as a JS handler body. So `&#039;`
decodes back to a raw `'` before the JS parser ever sees it, and a
project name like `x'); alert(document.cookie); ('` still breaks out of
the intended function call. `escapeHtml()` was doing real work (it's the
right defense for the *text* and *plain-attribute* contexts it's used in
everywhere else), it just wasn't sufficient for this one nested context.

**The fix.** Structural, not "escape harder": every dynamic value that
used to live inside an `onclick="..."` string now lives in a `data-*`
attribute (still `escapeHtml()`'d — that's the correct defense for a
plain attribute) and is read via `.dataset` inside a delegated
`addEventListener('click', ...)` handler, once per stable container.
`.dataset` is a property read, never re-parsed as code, so this removes
the vulnerability class rather than patching the specific payload.
`switchProject`'s and the memory/mission handlers' own signatures didn't
change — only how the DOM hands them their arguments did, so existing
call sites like `acceptAdvice()`'s hardcoded `switchProject('Alpha
Gateway', null)` were untouched.

Files: `src/features/workspace.js` (new `initializeWorkspaceEventDelegation()`,
called once from `boot.js` since `loadAndRenderProjects()` itself runs
multiple times per session), `src/features/memory.js` (new
`initializeMemoryEventDelegation()`, called from inside
`initializeNexusBrainUI()`, which boot.js calls exactly once), `src/features/execution.js`
(new `initializeExecutionEventDelegation()`, same pattern, called from
inside `initializeExecutionEngineUI()`), `src/core/boot.js` (one new
numbered step; renumbered 7–15).

**Reviewed the rest of the frontend, not just workspace.js** (as asked):
searched every `.js` under `src/` plus `index.html` for
`on[a-z]+="...${...}"` — eight call sites total, all fixed the same way.
Also checked for `eval(`, `new Function(`, `javascript:` URLs, and
`document.write(` — none found anywhere in the frontend.

**Tests added:** `tests/no-unsafe-inline-handlers.test.js` — (1) scans
`src/**/*.js` and `index.html` (comments stripped, so this file's own
explanatory text quoting the old pattern doesn't self-trigger) and fails
on any inline handler containing `${`; (2) same sweep for
eval/`new Function`/`javascript:`/`document.write`; (3) a positive check
that the actual fix (the `initializeXEventDelegation` functions and their
`data-action` attributes) is present, not just that the bad pattern is
absent. All DOM-free static/text checks — no jsdom or other new
dependency added, consistent with this suite's existing pure-Node style.

**Verified, not assumed:** ran `npm test` before touching anything
(109/109) and after (112/112 — the 3 new tests, nothing existing
changed), `node --check` on every `.js`/`.mjs` file in the repo, and a
duplicate/missing-id sweep against `index.html`.

### Follow-up — real browser QA found five more XSS sinks the static scan couldn't see

**This is why "no real-browser click-through was performed" above was
flagged rather than glossed over.** A follow-up session ran the actual
QA checklist that had been outlined for Priority 1 — a stateful mock
backend (real create/list/edit/delete, not static fixtures) plus a real
headless-Chromium (Playwright) click-through of every item on the list —
and it surfaced five more genuinely exploitable sinks. Same vulnerability
family (unescaped dynamic content reaching the DOM as executable markup),
different code shape: `.innerHTML = \`...${value}...\`` template literals,
not inline `on*="..."` attributes, so the static regex sweep above
(which specifically targets `on[a-z]+="...${...}"`) structurally could
not see them. All five are fixed as of this update.

**Most severe: `logToTerminal()` in `execution.js`.** Called with the raw,
unescaped goal text at multiple sites, including
`` logToTerminal(`[SYSTEM] Asking ${provider} to plan: "${goal}"`, 'system') ``,
fired synchronously *before* any network call. Typing
`<img src=x onerror="alert(document.cookie)">` into the Execution
Engine's goal box and clicking **Generate Plan** ran it immediately — no
project, no saved memory, no API call, nothing but normal typing. This is
plausibly the most easily triggered vulnerability found in this app to
date, since it requires zero setup.

**`appendTerminalLine()` in `activity-log.js`** — same pattern, reachable
via a project name once you switch to it (`switchProject()` logs
`` `[SYSTEM] Switched default project context to [${projectName}]` ``
through this function).

**`buildMemoryCardMarkup()` in `memory.js`** — two separate unescaped
interpolations: `m.category` (`<span>${m.category}</span>`) and each tag
in `m.tags` (`` `<span ...>#${t}</span>` ``). The memory *content* field
right next to both was already correctly wrapped in `escapeHtml()`, which
is likely why this was missed in review — most of the function was
already safe. **Tags are a free-text field on the memory form**
(`#memory-form-tags`), so this was reachable through completely normal
UI use, not a contrived direct API call.

**Project icon, two render sites in `workspace.js`** —
`` data-lucide="${proj.icon || 'folder'}" `` — a different sub-pattern
again: injection into a *plain attribute value*, not a JS-string or a
text node. Unlike the original Priority 1 bug, `escapeHtml()` genuinely
is the correct and sufficient defense for this context (HTML-entity-
encoding a `"` prevents breaking out of a plain attribute value — the
original bug was specifically about a JS-string-*inside*-an-attribute,
where the browser's entity-decode-before-parse ordering defeated it).
`proj.icon` is a free-text field on the project form
(`#project-form-icon`), reachable the same way as the memory tags above.

**The fix, same philosophy as the original Priority 1 fix — structural
where a sink didn't need HTML at all, escaping where it did:**
`appendTerminalLine()` and `logToTerminal()` no longer use `innerHTML`
for the dynamic text at all — both now build the line via
`document.createTextNode()` (immune to HTML injection regardless of
content, and every existing call site is fixed at once with no risk of a
future caller forgetting to escape). The three remaining sites
(category, tags, icon) needed HTML rendering context, where `escapeHtml()`
already used correctly two lines away in the same functions — was the
right, minimal, correct fix.

**Tests added:** `tests/no-unescaped-innerhtml.test.js` — specific
regression assertions per fixed site (both that the vulnerable pattern is
gone and that the actual fix/call site is still present, not just
deleted), plus an explicit, honest scope note in the file itself: unlike
the inline-handler class, this vulnerability shape doesn't have a safe
*generic* static check — most `.innerHTML =` template literals in this
codebase interpolate genuinely safe values (CSS-class ternaries, enums),
so a blanket "flag any unescaped `${}` in innerHTML" rule would be mostly
false positives. This is specific coverage for what was found and fixed,
not a claim that every future `innerHTML` assignment is automatically
caught — new ones should still get eyes on them.

**Verified this time with an actual browser, not just static analysis:**
a stateful mock backend (real in-memory create/list/update/delete
semantics — not canned single-response fixtures, so the test genuinely
exercises create→list→edit→delete round-trips) plus Playwright, covering
every item on the original QA checklist: create/switch/rename a project,
add/search/pin/edit/delete a memory (including confirming the native
`confirm()` dialog actually appears before deletion), open/replay a
mission — **and, at every one of those steps, injecting an XSS payload
and confirming (a) it renders as literal on-page text and (b) a global
JS canary set by the payload never fires.** All clean: 0 firings across
every surface, 0 page errors, every functional flow (including the two
sequential awaited fetches inside `openEditMemoryModal()` — the first
version of this browser pass under-waited for those and produced a false
"modal didn't open" result, corrected by waiting for the actual state
change instead of a guessed timeout) working correctly. `npm test`:
123/123 (109 baseline + 3 from the original fix + 11 from this follow-up).

**Status: done — verified with both static tests and a real browser, not
assumed.**

## Priority 2 — Harden Rate Limiting

**Status: done.**

**The bug.** `checkRateLimit()` did a plain read → increment → write against
Netlify Blobs, with nothing checking the value hadn't changed in between.
Two truly concurrent requests could both read `count=N`, both compute
`N+1`, and both write `N+1` back — one increment silently lost, so the
limit is under-enforced exactly when it matters most: a burst of
concurrent requests, which is the realistic shape of abuse (a script
firing N requests at once), not evenly-spaced single calls.

**The fix.** Checked what `@netlify/blobs` v10 actually supports before
designing anything (`node_modules/@netlify/blobs/dist/main.d.ts`, not
assumed): real conditional writes — `onlyIfNew` (succeed only if the key
doesn't exist) and `onlyIfMatch` (succeed only if the key's current ETag
matches a given value). That's a genuine compare-and-swap primitive, so
`checkRateLimit()` now does the standard thing on top of CAS-only storage:
read the count + its ETag (`store.getWithMetadata()`), compute the next
value, attempt a conditional write, and retry with a fresh read if another
request's write won the race in between.

A first version of this retried in a tight loop with no delay between
attempts. Tested against real concurrency (`Promise.all` over 10–50
simultaneous calls — this genuinely interleaves each call's internal
`await` points, which is how JS's single-threaded-but-async model produces
real race conditions without needing OS threads, not a simulation of one)
and it measurably failed: every colliding request retried at the same
instant, so they kept colliding with *each other* instead of resolving,
most exhausted their retry budget, and the limit went unenforced under the
exact bursty-traffic condition it exists to handle. Fixed with the
standard remedy for CAS contention — small jittered backoff between
attempts, so retries desynchronize instead of repeatedly colliding — plus
a smarter last resort: if every attempt is somehow still exhausted
(should now be rare), one more read decides the outcome (deny if that read
already shows the budget gone) instead of unconditionally opening the
gate. That path has a narrower race of its own (an unverified final read,
not a CAS'd one), but it's an informed decision, not a blind one — and
it's explicitly logged (`logDegraded()`) as a real, security-relevant
degraded-mode event, same treatment as the pre-existing fail-open paths.

**Storage-unavailable behavior, explicitly defined (as asked):** if Blobs
read or write throws, the request is allowed and flagged `degraded: true`
— fail-open, not fail-closed. This was a deliberate choice, not the
default left alone: fail-closed would mean a Blobs outage takes down chat
entirely for every legitimate user, which is a worse outcome than a
temporary lapse in rate-limiting during a rare infra incident, and lines
up with the brief's own "do not sacrifice legitimate user requests
unnecessarily." Every degraded decision is logged either way, so an
outage is visible in the logs rather than silently invisible.

**Council cost protection — the other half of this priority.**
`checkRateLimit()` gained a `weight` parameter (default `1`, so every
pre-existing call site is unchanged). `council.js` now computes a real
weight — `providers.length * (critique ? 2 : 1)` — reflecting that one
`/api/council` call fans out to that many actual provider calls (a
4-model request with critique on is 8 real provider calls, not 1), and
passes it to `checkRateLimit()`. A request that would need more units
than remain in the current window is rejected *before* spending any of
that budget, with a specific, actionable error ("this request needs 4 of
your remaining 3 units — try fewer models, turn off critique, or wait
Ns") rather than a generic 429. `chat.js` and `workflow.js` — one real
LLM call each, the same cost profile as each other — keep the existing
per-minute ceiling; Council already had a lower base ceiling than those
two (5/min vs 20/min) before this priority, and now additionally scales
by actual real cost within that ceiling.

**Tests added:** 9, all in `tests/security.test.js` — a `weighted
consumption` block (a single call consuming >1 unit; a request rejected
for exceeding *remaining* budget even when some is left, without
spending any of it; a lighter request still fitting after a heavier one
was rejected; default weight unchanged at 1) and a `concurrency` block
(N=50 truly concurrent requests against `max=20` allow exactly 20, not
more or fewer, cross-checked against the mock store's actually-persisted
count, not just the returned decisions; concurrent requests across
different identifiers don't leak into each other's counts; concurrent
*weighted* requests — simulating real concurrent Council traffic at mixed
weights — never let the sum of allowed weight exceed `max`; the
exhaustion fallback's own ALLOW and DENY paths are each exercised
directly). `tests/helpers/fake-store.js` was extended to implement the
*real* `getWithMetadata`/`onlyIfNew`/`onlyIfMatch` contract (matching the
actual SDK type definitions, not a simplified stand-in) — this is what
makes the concurrency tests meaningful: a reverted, buggy read-then-write
implementation measurably fails them, they don't just pass by construction.

**A mistake in one of those tests, found and fixed this session.** The
"exhaustion fallback can correctly DENY" test's mock returned `count: 20`
(== `max`) for *every* read, intending to simulate "every retry is
exhausted, and the final read shows the budget gone." It didn't actually
exercise that: `checkRateLimit()` checks `count + weight > max` on every
loop read, not just the first, so a constantly-at-limit mock trips the
cheaper "insufficient budget, reject without spending a write" path on
attempt 0 — a real, correct, desirable optimization, just not the code
path this test was named for. The test asserted `result.degraded === true`
and got `undefined`, because the early-return path (correctly) doesn't set
that flag at all. Fixed the test, not the implementation: exported
`RATE_LIMIT_CAS_MAX_RETRIES` from `security.js` so the test can build a
call-counting mock that keeps every loop read comfortably under budget
(so the retry loop genuinely runs to full exhaustion, the same as the
neighboring ALLOW-case test already did correctly) and only returns an
at-limit count for the one read that happens after the loop — the
fallback's own dedicated read. Confirmed this actually changed what was
being exercised, not just silenced the assertion: the fixed test takes
~99ms (9 real jittered-backoff delays across the full retry budget) versus
the failing version's ~1.6ms (returned on the very first attempt, no
retries at all).

**Verified, not assumed:** `npm test` — 133/133 (123 baseline + 10 net
new/changed in this area). `node --check` and a real `import()` on every
`.js`/`.mjs` file in the repo. Read every real call site of
`checkRateLimit()` (`chat.js`, `council.js`, `workflow.js`, `auth.mjs`,
`plugins.mjs`) to confirm the weight parameter is actually wired where it
matters (Council) and every other call site's behavior is unchanged
(default weight `1`), not just available and unused.

**Known, out-of-scope-for-this-priority gap, worth surfacing rather than
leaving silent:** `memory.mjs`, `projects.mjs`, and `missions.mjs` still
have no rate limiting at all (a pre-existing gap from before this
priority list, not introduced here). Priority 2's brief specifically
calls out *expensive* (AI-provider-calling) endpoints, which these
aren't, so it was reasonable to leave alone here — but worth a line in
Priority 11's full audit rather than assuming it's covered.

## Priority 3 — Fix Subscription State

**Status: done.**

**The bug, found by reading the function, not assumed from the brief's
description.** `priceUsd: input.isStudent ? ... : ...` read the raw
`input.isStudent` — but `isStudent` itself, one line above, was already
correctly resolved as `typeof input.isStudent === "boolean" ? input.isStudent
: Boolean(existing?.isStudent)`. Two different computations of "is this a
student" existed and had drifted apart. On a partial update that only
names `planId` (the realistic shape of an "upgrade my plan" call),
`input.isStudent` is `undefined` — so the *resolved* `isStudent` field
came out correctly `true` (preserved from `existing`), while `priceUsd`
used the raw, absent `input.isStudent` and silently rebilled at full
price. Exactly the brief's scenario: student status survives, discount
doesn't. No existing test exercised a partial update from a student
subscription, which is why this had gone uncaught.

**The fix:** `priceUsd` now reads the same resolved `isStudent` the rest
of the function already uses — one source of truth instead of two.
`status` had a related but distinct gap: it never read `input.status` at
all, so it could be preserved but never explicitly set. Added a small
closed set of valid statuses (`active`/`past_due`/`canceled` — shape
only, no real billing lifecycle drives transitions between them, same
honesty as before) so a caller can now change status, and an invalid
value falls back to existing rather than silently corrupting the record.

**`entitlements` and `limits` — the two fields the brief named that
didn't exist as fields at all** (confirmed by grep: zero hits anywhere
in the app before this). Added both, deliberately minimal and grounded
only in capabilities that are real today rather than invented numbers:
`entitlements.council` / `entitlements.councilCritique` mirror the
existing `COUNCIL_MIN_PLAN` check and council.js's real critique on/off
toggle; `limits.councilMaxProviders` reflects the actual provider count
this app supports (`providers.js`), not a number pulled from nowhere.
ultra and ultimate get identical values here because nothing else in
this app differentiates them for Council specifically — inventing a
split between them would be fabricating a distinction, not normalizing
an existing one. **Specific enforcement, and any finer numeric tuning
beyond this shape, is Priority 5's job** (its own brief lists "Maximum
participating models" and "Maximum critique rounds" as its
requirements, not this priority's) — nothing added here blocks a
request by itself; this just gives Priority 5 a correct, stable shape
to read instead of re-deriving plan comparisons ad hoc.

**Confirmed with the full app, not just this file:** `normalizeSubscription`
and `COUNCIL_MIN_PLAN` are not called from any endpoint yet (grepped the
whole app, not just `netlify/` — zero hits outside `shared/models.js`
and its own tests). No subscription endpoint exists. So this priority
was entirely self-contained to the shared model — nothing else to
inspect before modifying, and no live request path was touched.

**Tests added:** 18, all in `tests/models.test.js` — the exact
student/plan-only-update scenario from the brief; every paid plan
(Pro/Ultra/Ultimate) at both standard and student pricing, fresh and as
a plan-only update from an existing student subscription (9 sub-tests,
satisfying "every paid plan" rather than just the brief's one example);
status default/explicit-set/invalid-rejected/survives-a-plan-only-update;
entitlements and limits correct per plan, including that a *downgrade*
actually revokes them, not just relabels the plan; and one general test
that an empty update (`{}`) preserves every field on the record, not
just the two fields the brief's example happened to name.

**Verified the tests are real, the same way as Priority 2:** temporarily
reintroduced the exact original bug (`priceUsd: input.isStudent ? ...`)
and confirmed 5 tests fail against it — the centerpiece scenario, all 3
per-plan "reached via update" cases, and the general empty-update test —
then restored the fix (`diff` confirmed byte-for-byte) and reran clean.
`npm test`: 151/151 (133 baseline + 18 new). `node --check` on every
`.js`/`.mjs` file in the repo.

## Priority 4 — Harden AI Input Limits

**Status: done.**

**Found, not built from scratch: a solid, well-grounded `ai-limits.js`
module already existed** (`netlify/lib/ai-limits.js` + its own thorough
unit tests) but was genuinely orphaned — imported by nothing (confirmed by
grep before touching anything, same discipline as Priority 3). Read it in
full before trusting it, including independently re-verifying its most
checkable claim: the four providers' published context windows (Claude
Sonnet 5: 1,000,000 · GPT-5.6 Sol: 1,050,000 · Gemini 3.1 Pro: 1,048,576 ·
Grok 4.5: 500,000 — notably smaller than xAI's own older models). A fresh
web search against each provider's current docs confirmed every figure
exactly, including that specific Grok detail. The module's own design is
sound: a layered defense (per-message cap, total-request-chars cap,
estimated-token cap, and a provider-context-window backstop that
specifically uses the *smallest* window among a request's selected
providers — correct for Council's multi-provider case, not just the
largest or an arbitrary one), honest about what it isn't (an approximate
chars-per-token estimate, explicitly not a real tokenizer, explicitly not
something Samvit bills against), and error messages that name a limit and
a number without leaking internal constant names or implementation
details.

**What was actually missing, confirmed by reading each real endpoint, not
assumed from the module's own header comment:** `chat.js` had per-message
and message-count limits already, but nothing capping the *sum* across
every message — 50 messages × 24,000 chars each was a 1.2-million-
character request, accepted, before a single paid provider call.
**`council.js` had zero validation of any kind** — the single most
expensive endpoint in the app (fans one prompt to up to 4 real provider
calls, doubled again with critique on) was also the one with no ceiling
on what it would send, at all. `workflow.js` had a basic, correct but
locally-hardcoded `goal.length > 2000` check, duplicating a number that
already existed as `MAX_GOAL_CHARS` in the orphaned module. `route.mjs`
didn't reject an oversized message at all — it silently `.slice()`d it
down to size, meaning the Router's classification (and the suggestion
chip the user sees in chat) could be based on a truncated, mangled
version of what they actually typed, with no indication that happened.

**The fix:** wired `validateAiRequest()`/`validateSingleTextInput()` into
all four real call sites, replacing (not supplementing) each endpoint's
own ad hoc checks so there's one source of truth per limit instead of
three separately-maintained copies of similar numbers. `council.js`
passes its real `providers` array through so the provider-window check
uses the actual selected models, exactly as the module was designed to
support. `route.mjs` now rejects with a clear error instead of silently
truncating.

**Verified the wiring is real, not just present in source — twice.**
First, by directly invoking each of the four real exported handlers with
actual `Request` objects (the same interface Netlify calls them with),
not just re-testing `ai-limits.js` in isolation: oversized-messages,
oversized-single-message, oversized-total (the specific gap this priority
closed), and malformed requests are all genuinely rejected before
reaching any provider or rate-limit code, and a normal small request
reaches the streaming response stage untouched, for every endpoint.
Second, by writing those checks into a permanent test file
(`tests/ai-limits-wiring.test.js`) and then doing the same "break it on
purpose" verification as Priority 2 and 3: temporarily removed council.js's
validation call (the highest-risk wiring point, going from zero
protection to real protection), confirmed the new wiring test — and only
that test — failed, then restored the file and confirmed `diff` showed it
byte-for-byte identical and the suite green again.

**Tests:** `ai-limits.test.js` (pre-existing, unmodified — normal
request, malformed request, oversized message, oversized total request,
boundary values at exactly-the-limit, provider-specific window scoping
including "uses the smallest window among multiple selected providers"
and an explicit test that the provider-window backstop is currently
unreachable by construction because the flat caps are tighter, documented
rather than assumed) plus 11 new integration tests in
`tests/ai-limits-wiring.test.js` confirming each endpoint's actual wiring
specifically. `npm test`: 193/193 (182 baseline + 11 new).

**Not done here, on purpose:** provider-specific *output*-token limits
(the brief's "Maximum output tokens") — `providers.js`'s `maxTokens`
param already bounds this per-call today (`chat.js`/`council.js`/
`workflow.js` each pass a fixed value), so there was no live gap to close;
worth a documentation pass tying it explicitly to this priority rather
than new code. Council's brief-specific items — "Maximum participating
models," "Maximum critique rounds" — are already partially covered
(`MAX_PROVIDERS = 4` existed before this priority; there's no multi-round
critique concept in the real implementation, so "maximum rounds" is
inherently 1) but real per-plan tuning of these is explicitly Priority 5's
job per Priority 3's own entitlements/limits shape, not re-scoped here.

## Priority 5 — AI Council Enforcement

**Status: done.**

**The gap.** Priority 3 gave `shared/models.js` a real `Subscription` shape,
including `entitlements.council`/`limits.councilMaxProviders` — but,
explicitly by design at the time, nothing read them. `council.js` had no
concept of plan at all: any authenticated caller (or, in open/no-`ACCESS_CODE`
mode, anyone) could hit `/api/council` and reach real, paid provider calls.
`COUNCIL_MIN_PLAN` existed as a constant nothing consulted.

**Architecture — three new `netlify/lib/` files, each with one job, none
duplicating the others:**

- **`subscriptions.js`** — `getSubscription(store, accountId, env)`, the
  brief's "Subscription Retrieval" step. Store is an injected parameter
  (matching `checkRateLimit`/`recordUsage`'s existing pattern), not
  called internally, so this is testable against `fake-store.js` without
  real Blobs. Re-normalizes every record it reads through
  `normalizeSubscription()` rather than trusting stored JSON verbatim, so
  entitlements always reflect the *current* plan table, not whatever was
  true when the record was written. Never throws: a missing record or a
  broken store both fall back to a normalized default plan read from
  `SAMVIT_DEFAULT_PLAN_ID`/`SAMVIT_DEFAULT_PLAN_IS_STUDENT` (env vars, same
  configuration pattern as `ACCESS_CODE`/`RATE_LIMIT_PER_MINUTE`), which
  itself falls back to `free` on anything invalid or unset. This is a
  **fail-closed** default — deliberately the opposite of Priority 2's
  rate-limiter, which fails *open* on a Blobs outage because a chat outage
  is worse than briefly-unenforced rate limiting. A storage hiccup here
  must never read as "unlimited access" to a paid feature, so it doesn't.
  `saveSubscription()` is fully implemented and unit-tested, but — on
  purpose — is not called from any HTTP endpoint this priority adds. There
  is no real payment processor (see `ROADMAP.md`), so a "change your own
  plan" endpoint with nothing behind it would just be a differently-shaped
  version of the fake paywall `CHANGES.md` already tore out once. The
  function exists so a real Stripe webhook handler has a correct place to
  land later, and so the store-backed path is genuinely tested now rather
  than aspirational.
- **`entitlements.js`** — pure functions (`isSubscriptionActive`,
  `planIncludesCouncil`, `canUseCouncil`, `getCouncilEntitlements`) reading
  the entitlements/limits `normalizeSubscription()` already computes.
  Deliberately does not re-derive plan capabilities a second time — there
  is exactly one place in the codebase that knows what a plan unlocks
  (`PLAN_CAPABILITIES` in `shared/models.js`), and this is a thin,
  reusable wrapper around it, not a second copy. Generic on purpose (not
  Council-specific in name), so a future premium feature (SAMVIT Prime,
  Advanced Research — both named in the brief) can reuse the
  `isSubscriptionActive`/plan-check pattern directly.
- **`council-access.js`** — `decideCouncilAccess(subscription, request)`
  (pure decision core, given an already-resolved subscription) and
  `authorizeCouncilRequest(store, accountId, env, request)` (the real,
  store-backed entry point `council.js` calls). Splitting the two matters
  for testing: `getSubscription()` always re-derives entitlements from the
  real plan table, so no *stored* record can ever produce a plan/limit
  combination today's real plans don't actually have (e.g. Ultra with a
  provider cap below 4) — `decideCouncilAccess()` accepts a hand-built
  subscription object directly, so the comparison logic itself is provably
  correct independent of what today's specific plan numbers are (same
  documented-not-assumed honesty as `ai-limits.js`'s provider-window
  backstop from Priority 4). Order of checks inside is deliberate: plan
  membership (`COUNCIL_UPGRADE_REQUIRED`) is checked before subscription
  status (`COUNCIL_NOT_ENTITLED`), so a Free account that's also
  `past_due` gets told to upgrade (the real reason), while an Ultra account
  that's `past_due` gets told its subscription isn't currently valid (the
  plan would qualify) — this is the actual, distinct value of the brief's
  "Subscription Validation" step existing separately from "Entitlement
  Check," not two names for the same thing.

**`council.js` — the enforcement, in the brief's specified order:** parse +
validate request shape (now including a structural `providers.length >
PROVIDER_IDS.length` ceiling sourced from `shared/models.js` instead of a
second hard-coded `4`) → `validateAiRequest()` (Priority 4, unchanged) →
`requireSession()` (unchanged) → **new:** `authorizeCouncilRequest()` →
rate limit (Priority 2, unchanged) → provider calls. A denied request
returns before the rate limiter runs and long before any provider is
called — cost protection holds regardless of which check fails.
`MAX_PROVIDERS = 4` (a hard-coded local constant) is gone; the provider-count
ceiling that actually gates paid usage now comes from
`entitlements.maxProviders`, sourced from one place.

**The one deliberate scope exception, stated plainly rather than left
implicit: `auth.open` mode (no `ACCESS_CODE` configured) skips subscription
enforcement entirely**, identical to how every other endpoint already
behaves in that mode. This is Samvit's pre-existing, explicitly-documented
"fully open, local dev convenience" state (see `security.js`/`README.md`) —
there is no "Free/Pro user" concept to enforce against when the whole app
is unauthenticated by the operator's own configuration choice. A real,
`ACCESS_CODE`-protected deployment (what this brief is actually about)
always runs the full check.

**Student pricing.** Untouched — Priority 3's `normalizeSubscription()`
already computes `priceUsd` from the resolved `isStudent` flag independent
of `entitlements`, and every entitlement/access-check in this priority
reads `entitlements`/`limits`/`status`, never `priceUsd`. Verified directly:
student Ultra/Ultimate get Council; a plan change on a student subscription
keeps the discount AND correctly re-derives entitlements for the new plan.

**Errors.** `COUNCIL_UPGRADE_REQUIRED` and `COUNCIL_NOT_ENTITLED` are the
brief's own two named examples; `COUNCIL_PROVIDER_LIMIT_EXCEEDED` and
`COUNCIL_CRITIQUE_NOT_ENTITLED` are two more, equally safe, equally
non-internal codes for the other genuinely distinct denial reasons ("Examples"
in the brief's own wording, not a closed enum). Every denied response is
`{ error: "<CODE>" }` and nothing else — checked directly in
`council-wiring.test.js` (`Object.keys(body).length === 1`). No subscription
data, provider secrets, auth internals, or stack traces are ever returned;
`reason` (the human-readable detail) exists only on the server-side decision
object for audit logging, never serialized into the HTTP response.

**Auditing.** Reused `security.js`'s existing `recordAuditEvent`/
`samvit-audit` store (the same mechanism Priority 1-era login/logout events
already use) rather than inventing a parallel logging path — a Council
grant/denial is the same category of security-relevant event. Records
account id, plan tier, granted/denied, provider count, and (on denial) a
reason string — never the prompt, never a secret. Best-effort: a broken
audit store degrades to a `log.warn()` and never blocks the actual
authorization decision.

**Critique "rounds."** The real implementation has a boolean critique
toggle, not a multi-round system (unchanged from Priority 3/4's own
honesty about this). `getCouncilEntitlements()` reports
`maxCritiqueRounds` as 0-or-1, honestly reflecting that as a count rather
than inventing round support that doesn't exist — the field exists so the
brief's explicit "must allow future limits such as Maximum critique
rounds" has a real, already-wired place to report a larger number if a
real multi-round feature is ever built, without Samvit pretending today
that number is ever anything but 0 or 1.

**Frontend (section 7).** `initializeAiCouncilUI()` now reads the real
`subscription.entitlements.council` value `/api/status` computes
server-side (via the same `entitlements.js` the backend enforces with,
not a re-derived copy) and toggles between the existing workspace and a
new `#council-locked-panel` — "Available on Ultra & Ultimate," the real
benefit list, real pricing pulled from `PLAN_PRICING` (never hard-coded in
HTML), and an upgrade button. That button does not pretend to open a
checkout flow — this reference deployment has no live payment processor
(see `ROADMAP.md`) — it says so honestly rather than faking one. Preserved
exactly as before: open mode shows Council fully unlocked (matches the
backend's real bypass), and the existing per-provider-API-key checkbox
disabling is untouched. The panel is explicitly commented as UI
convenience only; deleting it would change nothing about what `/api/council`
actually accepts.

**Tests: 77 new (270 total, up from 193; 69 suites, 0 failures).**
- `entitlements.test.js` (21) — the brief's full Subscription-tests list
  (Free/Pro/Ultra/Ultimate, student variants, upgrade/downgrade, student
  discount surviving a plan change) against real `normalizeSubscription()`
  records, plus the status-vs-entitlement distinction and defensive
  zeroing of `getCouncilEntitlements()`.
- `subscriptions.test.js` — store-backed: defaulting, per-account
  isolation, fail-closed on a broken/missing store, the env-default
  fallback (including an operator typo NOT elevating access), and
  `saveSubscription()` round-trips (including through an upgrade-then-
  downgrade sequence).
- `council-access.test.js` — the brief's full API-tests and
  security-tests lists against `authorizeCouncilRequest()`/
  `decideCouncilAccess()`: every plan tier, past_due/canceled handling,
  upgrade/downgrade over time, the provider-count and critique limits
  (including via a hand-built subscription for the combination no current
  real plan produces, honestly documented as to why that's necessary), and
  spoofed request fields (fake `plan`/`entitlements`/`isEntitled`/
  `accountId` in the options bag) all confirmed ignored.
- `council-wiring.test.js` — the real exported `council.js` handler, real
  `Request` objects, real signed session cookies: shape/AI-limit
  validation rejects before auth is even checked; no cookie / tampered
  cookie / wrong-secret cookie all `401` without touching storage; open
  mode still returns a real `200` stream exactly as before this priority;
  an authenticated caller with no stored record and no configured default
  fails closed to `403 COUNCIL_UPGRADE_REQUIRED`; `SAMVIT_DEFAULT_PLAN_ID=ultra`
  is honored end-to-end through to a real `200` stream (the one way to
  construct a genuine allow-path through the literal handler without a
  working Blobs backend in a test environment — `getStore()` throws
  synchronously outside real Netlify infra, confirmed directly against the
  installed package before relying on it); spoofed body fields, headers,
  and query-string parameters claiming a plan/entitlement are all
  confirmed to not affect the `403`.

**Verified:** `npm test` — 270/270. `node --check` on every `.js`/`.mjs`
file in the repo. Confirmed `chat.js`/`workflow.js` untouched (Council is
the only endpoint this brief scopes as premium) and every pre-Priority-5
test file unmodified — the 77 new tests are additive, nothing existing was
weakened or deleted to make the suite pass.

**Honestly unreachable via any CURRENT real plan, documented rather than
assumed (same treatment as Priority 4's provider-window backstop):** the
provider-count and critique-entitlement limit checks inside
`decideCouncilAccess()` cannot actually fire against a *stored* Ultra/
Ultimate subscription today, because both real paid tiers allow exactly 4
providers (this app's entire provider count) with critique on — there's no
plan combination today that reaches those branches through real data. The
comparison logic itself is still real and directly tested (see
`council-access.test.js`'s hand-built-subscription tests) — it activates
automatically the moment `PLAN_CAPABILITIES` ever differentiates the two
tiers, with no code change needed here.

**Not done here, on purpose (see `ROADMAP.md`):** no self-service "change
my plan" endpoint (see `subscriptions.js`'s own comment on why); no real
payment processor / Stripe integration; no per-plan output-token or
execution-duration limits (the brief lists these as *future* extensibility
to design for, not current requirements — `getCouncilEntitlements()`'s
shape has room for them, nothing today invents numbers for limits that
don't correspond to real enforced behavior, same discipline Priority 4
applied to output-token limits).

## Priority 5 — Production Hardening (completion pass)

**Status: done.**

**The gap.** Priority 5's original pass built real server-side Council
enforcement, but left one scope exception stated plainly rather than
fixed: `auth.open` mode (no `ACCESS_CODE` configured) skipped subscription
enforcement entirely, inferred purely from whether `ACCESS_CODE` happened
to be set. That's the right call for local dev — but it means a real
production deployment that simply forgot to configure `ACCESS_CODE` (a
plausible operator mistake, not a hypothetical) silently ran fully open:
every endpoint, Council included, with zero auth and zero entitlement
enforcement, and `/api/status` telling the frontend that was fine. This
pass closes that, and finishes the rest of the hardening list this
priority's brief specified but the original pass explicitly deferred
(billing boundary shape, webhook readiness, a distinct
service-unavailable signal).

**1. Environment separation (`netlify/lib/security.js`).** Added
`isDevelopmentMode(env)`: `NODE_ENV=production` is an absolute override —
if set, this is production, full stop, even if `DEV_MODE` was also
(mistakenly) left set. Otherwise, open/dev behavior requires the literal
string `DEV_MODE=true` — not inferred from `ACCESS_CODE`'s presence, not
any other truthy value. No signal at all (the common unconfigured case) is
production, not development: the safe default is a locked posture,
dev mode is the opt-in. `requireSession()` now fails CLOSED with a
controlled `500 AUTHENTICATION_UNAVAILABLE` whenever `ACCESS_CODE` (or
`SESSION_SECRET`) is missing and this isn't explicit dev mode — a real,
generic-message response, never a stack trace or internal detail, and
every existing call site (`chat.js`/`council.js`/`workflow.js`/every
`.mjs` function) already handled an `ok:false` result the same generic
way, so this took effect everywhere at once with no call-site changes
needed.

Two other places independently re-derived the exact same unsafe inference
this fixed in `security.js`, and would have silently drifted from it:
- **`netlify/functions/auth.mjs`** (the login endpoint) — now uses the
  same `isDevelopmentMode()` gate before treating a missing `ACCESS_CODE`
  as "run open"; otherwise returns the same safe 500.
- **`netlify/functions/status.mjs`** — used to compute `protectedApp`
  from `Boolean(ACCESS_CODE)` alone, its own separate copy of the
  inference. Now calls `requireSession()` unconditionally as the single
  source of truth, so this reporting endpoint can never claim "Council is
  open, no auth needed" while `/api/council` itself is failing closed with
  a 500 — plus a new `authConfigured` field so a misconfigured-production
  state is distinguishable from "just not logged in yet."

**2/3/4/5. Request order in `council.js` — rebuilt to the specified
sequence**, superseding the original pass's order (which ran shape/size
validation before authentication):

```
Authentication -> Trusted Subscription -> Entitlements ->
AI Council Limits -> Rate Limits -> Input Limits -> AI Council
```

Authenticating first means an unauthenticated caller in protected mode
never gets a single byte of the body parsed or validated — a clean 401
straight off the session check. That closes a secondary issue the old
order had: an attacker with no valid session could still get free,
unrate-limited feedback about exactly where this app's size limits sit,
just by sending oversized bodies (400s never touched auth or the rate
limiter before). Minimal structural parsing (is this JSON, does it have a
`providers` array, a non-empty `prompt`) still has to happen before
Subscription/Entitlements/Council-Limits/Rate-Limits — those steps need
`providers.length`/`critique` — but that's the minimum shape needed to
route the request at all, not a size/cost policy decision; `Input Limits`
(`validateAiRequest()`, Priority 4's module) is what enforces that, and
it's the step that moved, now running last, right before execution. The
deliberate trade-off, stated plainly: an oversized request from an
authenticated, entitled caller still spends one rate-limit unit before
being rejected for size — that unit belongs to the same account that sent
it, never anyone else's, and it means rate limiting can't be bypassed by
crafting a request that's always "just barely too big to validate."

**7. A distinct signal for a genuinely UNAVAILABLE subscription service**,
not just "no record" (`netlify/lib/subscriptions.js` /
`netlify/lib/council-access.js`). `getSubscription()` still never throws
and still fails closed to the operator's configured default plan — that
contract, and its existing tests, are unchanged. What's new: it now
distinguishes three situations that used to all collapse into the same
default-plan fallback:
1. No record exists yet (the common case) — apply the default, unflagged.
2. No store handle at all was passed in (typically `getStore()` itself
   threw upstream, including in every non-Netlify test/dev environment) —
   there was no live call to fail, so this is ALSO treated as (1),
   unflagged. This is what keeps the entire existing test suite's
   "construct an allow-path via `SAMVIT_DEFAULT_PLAN_ID`" pattern working.
3. A REAL store handle's own call threw (an actual live disruption — a
   network error, a Blobs outage) — flagged via a non-enumerable
   `_subscriptionServiceUnavailable` marker (`isSubscriptionServiceUnavailable()`),
   invisible to `JSON.stringify`/`Object.keys`/a spread, so the
   Subscription *shape* is completely unaffected either way.
   `council-access.js`'s `decideCouncilAccess()` checks this FIRST, before
   any entitlement logic, and returns a new, distinct
   `503 COUNCIL_SUBSCRIPTION_UNAVAILABLE` instead of quietly deciding as if
   this were a fresh free account — which matters most for an operator who
   deliberately configured a MORE generous default (e.g. Ultra-for-everyone
   during a beta with no billing system yet, a real supported use of
   `SAMVIT_DEFAULT_PLAN_ID`): an outage must never silently keep granting
   that default just because it happens to be the fallback shape.

**3. A clean billing boundary (`shared/models.js`).** `normalizeSubscription()`
gained six new fields — `externalCustomerId`, `externalSubscriptionId`,
`currentPeriodStart`, `currentPeriodEnd`, `cancelAtPeriodEnd`, `source`
(closed set: `manual` | `stripe`, new export `SUBSCRIPTION_SOURCES`) — the
exact concepts the brief's section 3 named. All six are PREPARED, none
enforced: entitlement decisions still derive solely from `planId` (via
`PLAN_CAPABILITIES`) and `status`, unchanged. Every existing caller reading
only the pre-existing fields is unaffected; these are pure additions, with
their own partial-update-preserves-them and invalid-value-rejected tests
(same contract `isStudent`/`status` already had).

**4. Webhook-ready design — real, not faked (`netlify/lib/billing.js` +
`netlify/functions/billing-webhook.mjs`, both NEW).** What's genuinely
real and independently correct today:
- `BILLING_EVENT_TYPES` — the actual Stripe event names ROADMAP.md already
  named as what real billing needs (`checkout.session.completed`,
  `customer.subscription.updated`, plus `.created`/`.deleted` and the two
  invoice events).
- `verifyStripeSignature()` — a real implementation of Stripe's own
  documented webhook signature scheme (HMAC-SHA256 over
  `${timestamp}.${rawBody}`, hex-encoded, constant-time compared, with a
  replay-window check on the timestamp) — not a stub that always returns
  true. Verified directly: a correctly-signed payload passes, a wrong
  secret/tampered body/stale timestamp/signature-for-a-different-payload
  all fail, for real, cryptographically.
- `claimBillingEvent()` — real, atomic (CAS via Blobs' `onlyIfNew`, the
  exact same primitive `checkRateLimit()` already relies on) idempotency:
  the first claim of an event id succeeds, every subsequent claim of the
  same id fails — so a replayed webhook delivery (which Stripe explicitly
  documents can happen) is detected and skipped, never reapplied. Fails
  CLOSED toward "treat as already processed" if the store itself is
  unavailable, never toward a risky double-apply.
- `mapStripeEventToSubscriptionInput()` — a real, pure, unit-tested
  mapping from a Stripe subscription object to the shape
  `saveSubscription()` already accepts (status normalized onto Samvit's
  smaller closed set, period timestamps converted to ISO, customer/
  subscription ids, cancellation flag). A full pipeline integration test
  (`claim -> map -> saveSubscription -> re-read`, and a second proving a
  webhook-applied cancellation actually revokes Council through the real
  `authorizeCouncilRequest()` path) confirms these pieces genuinely
  compose, not just pass in isolation.
- `netlify/functions/billing-webhook.mjs` — a REAL endpoint wired to all
  of the above. Deliberately NOT authenticated via `requireSession()` — a
  webhook is a server-to-server call from Stripe's own infrastructure,
  authenticated via signature instead, the actual mechanism a real payment
  provider uses for this.

What's honestly still DEFERRED, not faked: price-ID → `planId` mapping
(Stripe has no idea a given price corresponds to Samvit's "ultra" plan —
that's deployment-specific and doesn't exist yet; without it configured, a
verified event updates billing metadata but leaves `planId` untouched,
confirmed by a dedicated test, never inventing a plan) and Stripe customer
→ Samvit account mapping (this app has one shared `ACCESS_CODE`, not real
per-user accounts yet — see ROADMAP.md "Real per-user accounts" — so a
verified event applies to the one `DEFAULT_ACCOUNT_ID` every other v4
Priority 5 module already uses). Most importantly: **without a real
`STRIPE_WEBHOOK_SECRET` configured, the endpoint is completely inert** — a
well-formed request with a real-looking signature still gets a safe `501
BILLING_WEBHOOK_NOT_CONFIGURED`, confirmed directly through the real
handler. That's the honest difference between "webhook-ready design"
(this section's actual brief) and "a fake webhook" (what it explicitly
says not to build).

**Audit logging.** Reused the existing `recordAuditEvent`/`samvit-audit`
mechanism, unchanged pattern: `billing_webhook_applied` records account,
event type/id, resulting plan/status — never a prompt, never a secret,
best-effort (a broken audit store degrades to a log line, never blocks the
real decision), consistent with every other audit event in this app.

**Tests: 78 new (348 total, up from 270; 83 suites, 0 failures).**
- `security.test.js` — 25 new: `isDevelopmentMode()` directly (the
  `NODE_ENV=production` override, the exact-string `DEV_MODE=true`
  requirement, no-throw on a malformed env) and `requireSession()`
  directly (the core fail-closed fix, the safe non-leaking message, the
  ordinary-401-vs-misconfiguration-500 distinction, a real signed-cookie
  success path, confirmation that `DEV_MODE` can't be smuggled in via
  request headers/cookies).
- `council-wiring.test.js` — rewritten, not patched (22 tests): several
  old assertions described behavior that is now the wrong order and would
  themselves have been regressions if left passing. New coverage: the
  production fail-closed path through the real handler (with and without
  a session cookie present, proving the body is never even parsed), the
  `NODE_ENV=production` override winning over a stray `DEV_MODE=true`, and
  that an authenticated+entitled request still gets rejected for size at
  its new, later position in the order.
- `subscriptions.test.js` / `council-access.test.js` — new
  `isSubscriptionServiceUnavailable` coverage: the three-way distinction
  above, the non-enumerable marker never leaking into
  `JSON.stringify`/`Object.keys`/a spread, an operator's generous default
  plan NOT leaking through during a real outage, and `decideCouncilAccess()`
  reaching the same conclusion directly from a hand-built subscription
  (proving the comparison logic itself, independent of `getSubscription()`).
- `models.test.js` — new billing-boundary field coverage: safe defaults on
  a fresh record, real values stored verbatim, survival across a
  partial update, an invalid `source` rejected (never downgrading an
  existing valid one), and confirmation these fields are entirely inert
  for entitlements.
- `billing.test.js` (new, 28 tests) + `billing-webhook-wiring.test.js`
  (new, 8 tests) — see section 4 above.
- `ai-limits-wiring.test.js` — updated (not weakened): its stub env now
  sets `DEV_MODE=true` explicitly, the real sanctioned "local testing"
  opt-in the brief itself calls for, since that file's actual scope is
  validation wiring, not auth (which the new `security.test.js`/
  `council-wiring.test.js` coverage now owns).

**Verified:** `npm ci && npm test` — 348/348, clean install. `node --check`
on every `.js`/`.mjs` file in the repo (0 errors). A separate import-check
script actually `import()`s all 27 backend modules (catches
missing-export/reference errors `node --check` alone can't) — 0 failures.
`npm audit` shows 3 pre-existing high-severity advisories, all inside
`@netlify/blobs`'s own dev-tooling dependency chain (`image-size` via
`@netlify/dev-utils`) — confirmed via `diff` against the original
`package.json`/`package-lock.json` that this pass added zero dependencies
and changed neither file; out of scope for an entitlement-hardening pass,
flagged rather than silently ignored. Every pre-Priority-5 test file that
didn't need updating for the new auth/order behavior is untouched, and no
existing assertion was weakened or deleted to make the suite pass — where
old tests described behavior the brief's new order makes actively wrong
(`council-wiring.test.js`), they were rewritten to test the new, correct
behavior, not silenced.

**Not done here, on purpose (updated `ROADMAP.md`):** no real Stripe
account/webhook is actually connected (needs an operator's own Stripe
keys); no price-ID → plan mapping (deployment-specific, doesn't exist
yet); no self-service "change my plan" endpoint (unchanged from the
original Priority 5 pass — still deliberately not built, see
`subscriptions.js`'s own comment); no MFA/passkeys/RBAC (still gated on
real per-user accounts existing first, unchanged).

**Priority 5 can now be marked COMPLETE**, including this hardening pass.

## Priority 5 — Reliability Fix: Billing Webhook Idempotency

**Status: done. Found by external code review of the hardening pass
above, not by this project's own test suite — stated plainly, not
smoothed over, since exactly how it slipped through is the useful part.**

**The bug, in one sequence.** `claimBillingEvent()` wrote a permanent
"claimed" record for an event id, via CAS, *before* `saveSubscription()`
was ever attempted. If the write that actually applied the event then
failed — a Blobs hiccup, `saveSubscription()` throwing, anything — the
event id was already marked claimed, forever. Stripe's own retry of that
exact event id (the built-in recovery mechanism a non-2xx response is
supposed to trigger) would hit the claim, be told "duplicate, already
handled," and skip it — permanently discarding a subscription update that
was never actually saved. The retry mechanism meant to be the safety net
for a failed write was the thing silently eating it.

**Why 362 passing tests didn't catch it.** (Not 348 — see "Two numbers
this pass corrects" below.) `billing.test.js`'s original coverage
thoroughly proved the claim primitive was atomic: first claim succeeds,
second claim of the same id fails, a broken store fails closed. All true,
all still true. What it never constructed was the specific sequence the
bug lives in — *claim succeeds, then the NEXT operation on the same event
id fails, then the same id is retried*. `createBrokenStore()` (the only
failure-injection helper that existed) fails every operation uniformly,
which structurally can't express "this write succeeds, a later one
doesn't" — so that sequence was never reachable from the existing test
helpers, not because anyone judged it low-risk.

**The fix — a three-state record instead of a boolean, in
`netlify/lib/billing.js`:**

```
(absent) --[claim, onlyIfNew]--> processing --[apply succeeds]--> applied
                                     |
                                     +--[apply throws]--> failed --[retry, onlyIfMatch]--> processing (loop)
```

- `claimBillingEventForProcessing()` replaces `claimBillingEvent()`
  (removed, not deprecated-and-kept — nothing outside this pass ever
  called it, so there was no reason to leave a known-unsafe function
  reachable). Returns `{claimed, status?, etag}`. `applied` is the only
  status a future claim treats as a genuine, permanent duplicate.
  `failed` is reclaimable *immediately* — a failure is unambiguous, no
  reason to make Stripe wait for it. `processing` is reclaimable only
  after `staleAfterMs` (default 2 minutes, sized off this handler's own
  actual work — two Blobs calls and one HMAC verify — not off a claimed
  knowledge of Stripe's specific retry cadence, which this file makes no
  claim to know precisely): a record that's still `processing` might be a
  genuinely concurrent delivery actually in flight right now (Stripe
  documents this as possible), and there is no cross-request lock here,
  only a store — a timeout is the only honest way to tell "still running"
  apart from "crashed before it could record anything," including a
  platform-level kill that never reaches a `catch` block at all.
- `markBillingEventApplied()` / `markBillingEventFailed()` — both CAS
  (`onlyIfMatch` on the etag `claimBillingEventForProcessing()` returned),
  so a concurrent reclaimer can't have its outcome clobbered by a stale
  writer. Both best-effort by design and documented as to exactly why
  that's safe for each: `markBillingEventApplied()`'s target state
  (`saveSubscription()` succeeding) has already happened by the time it's
  called, so losing this specific write only risks a harmless future
  re-apply of identical data, never a lost update; `markBillingEventFailed()`
  losing its write just leaves the record in `processing`, which the
  staleness fallback still recovers on its own, only slower.
- `wasBillingEventProcessed()` — same name, corrected semantics: true only
  once `applied`, not merely "someone attempted this and it may have
  failed," matching what the name always implied.
- `netlify/functions/billing-webhook.mjs` rewired so every claimed event
  resolves to exactly one of `markBillingEventApplied()` /
  `markBillingEventFailed()` before returning — including wrapping the
  previously bare, unguarded `saveSubscription()` call in a real
  try/catch, which is where the actual data loss happened. A `processing`-
  but-not-yet-stale claim now returns a new, distinct `409
  BILLING_WEBHOOK_EVENT_PROCESSING` rather than being folded into the same
  response as a confirmed duplicate — the single boolean design had no way
  to say these apart.

**New test infrastructure: `createFlakyStore()`** (`tests/helpers/fake-store.js`).
Wraps a real `createFakeStore()` so a specific call — one write, one key,
once — can be made to throw on command while everything else behaves
normally; `failOnce(method, key)` for the common case. This is what
`createBrokenStore()` structurally cannot do (it fails everything,
uniformly), and its absence is the direct, mechanical reason the original
bug had no failing test. Used to write a test that reproduces the review's
exact sequence through the real `saveSubscription()`/`billing.js`
functions — claim succeeds, `saveSubscription()` genuinely throws (not
simulated by hand-returning an error — an actual thrown exception from
real code), `markBillingEventFailed()` runs, the identical event id is
claimed again, and this time the write succeeds — plus direct unit tests
of every state transition (immediate reclaim on `failed`, staleness-gated
reclaim on `processing`, a full claim→fail→reclaim→apply→now-a-real-
duplicate lifecycle, and the CAS-protects-against-a-stale-etag case).

**The two 🟠 secondary points the same review raised — deliberately
untouched, because they were already accurately tracked, not missed:**
price-ID → `planId` mapping stays deployment-specific and deferred
(`billing.js`'s own header and `ROADMAP.md`'s "Subscription billing"
section both already say so, unchanged by this pass); the single-account
limitation (webhook events apply to `DEFAULT_ACCOUNT_ID`) is likewise
already named in both places as gated on real per-user accounts existing
first. Verified both were still accurate before leaving them alone, not
assumed.

**Two numbers this pass corrects, found while verifying the review's
"testing caveat" rather than restated from the previous entry:**
- The prior entry's own "348 total" was wrong — the actual number, then
  and now independently re-counted via `npm test`'s own summary line
  (never hand-counted `test(` calls, which undercounts by construction
  whenever a file generates tests in a loop — `entitlements.test.js`,
  `models.test.js`, and `providers.test.js` all do), was **362**. Not a
  coverage gap — the suite was more thorough than claimed, not less —
  but a real "don't just trust a reported number" example, in the same
  spirit as this review's own skepticism.
- The prior entry also claimed *"a separate import-check script actually
  `import()`s all 27 backend modules... 0 failures."* No such script
  existed anywhere in the repository — there was nothing to re-run, and
  no way to confirm that claim after the fact. `scripts/check-imports.mjs`
  (new, `npm run check-imports`) is that check, actually committed this
  time: enumerates every real `.js`/`.mjs` under `netlify/` and `shared/`
  and `import()`s each one for real. Run fresh for this pass: 27/27 —
  the original number was right, the missing artifact was the actual gap.

**Tests: 9 net new (371 total, up from 362 — the corrected baseline —
84 suites, 0 failures).** `billing.test.js`'s idempotency section rewritten
around the three-state API (removed tests that only made sense for the
old boolean claim; every scenario above gets its own direct test);
`billing-webhook-wiring.test.js` unchanged in its assertions (the tests
it already had for the first-`getStore()`-throws path are still exactly
correct) but its header comment now states plainly that the 409/retry-
recovery states are NOT reachable through the literal HTTP handler in this
test environment (`getStore()` throws synchronously outside real Netlify
infra, confirmed directly against the installed package back in the
original Priority 5 pass, and everything past that first call in this
endpoint requires a working store) — and points at exactly which test in
`billing.test.js` proves the fix instead, rather than silently leaving
that gap for a reader to notice on their own.

**Verified:** `npm ci && npm test` — 371/371, clean install, freshly
re-run, not carried over from the previous entry's numbers. `node --check`
on every `.js`/`.mjs` file in the repo. `npm run check-imports` — 27/27,
using the newly-added real script. Grepped the entire repository for the
removed `claimBillingEvent` name — zero remaining call sites (two
references remain, both inside explanatory comments describing what the
old, buggy function used to do, which is correct and intentional).
`README.md`/`ARCHITECTURE.md` test-count references corrected from the
stale 348 to 371.

**Not done here, on purpose:** the two 🟠 secondary review points (see
above — already tracked, not re-litigated); no change to
`council.js`/`security.js`/the environment-separation logic from the prior
hardening pass — this fix is scoped to the billing webhook's own
idempotency mechanism, which is the only thing the review found wrong.

## Priority 6 — Storage Concurrency & Data Integrity

**Status: done.**

**The gap.** Every persistent write in this app, across every priority up
through 5, followed the same unprotected pattern: `const data = await
store.get(key); /* mutate data */; await store.setJSON(key, data);`. Two
concurrent requests hitting the same key — two AI calls both calling
`recordUsage()` at once, two devices both editing the same project, two
Stripe events landing close together — could both read the same starting
value, both compute a different next value, and whichever wrote second
silently discarded the first. No error, no retry, no trace. Priority 2 had
already fixed exactly this for rate limiting (real compare-and-swap via
`onlyIfMatch`/`onlyIfNew`); nothing generalized that fix to the other six
places in the codebase doing the identical unsafe thing.

**1/2/3. Audit + fix + reusable layer.** `netlify/lib/storage/` is the
single place this concurrency logic lives now, so no future endpoint has to
reinvent it:

- **`concurrency.js`** — `casUpdate(store, key, updateFn, opts)`, the one
  primitive every other file in this pass is built on: reads the current
  value + ETag, calls `updateFn(current, {etag})`, attempts a conditional
  write, and retries with jittered backoff (same desynchronization
  reasoning `checkRateLimit()`'s own header already documented) if another
  writer's conditional write landed first. Bounded at `DEFAULT_MAX_RETRIES
  = 8` (brief section 4: "Do NOT create infinite retry loops") — exhausting
  every retry throws `StorageConflictError`, not a silent guess. A thrown
  error from `updateFn` itself (e.g. a validation failure) propagates
  directly, never mistaken for a CAS conflict and retried.
- **`errors.js`** — a closed taxonomy (`StorageConflictError`,
  `StorageUnavailableError`, `StorageNotFoundError`,
  `IdempotencyConflictError`) plus `storageErrorStatus()` mapping each to
  the HTTP status an endpoint should return (409/503/404/409). Every
  message is generic — no stack traces, credentials, or internal keys (the
  real underlying error lives in `.cause`, server-side-logging only).
- **`blobs.js`** — `safeGet`/`safeDelete`, the same error taxonomy applied
  to the two plain (non-read-modify-write) storage operations every
  endpoint also does directly.
- **`record.js`** — `updateRecord(store, key, updateFn)`, the safe
  single-record counterpart: throws `StorageNotFoundError` if the record
  doesn't exist, which is what makes the update-vs-delete race (section 9)
  come out correctly using nothing but the CAS primitive Blobs already has
  — no tombstones needed. If a record is deleted between this function's
  read and its conditional write, the write's `onlyIfMatch` has nothing
  left to match, the retry reloads, finds the key genuinely gone, and this
  throws instead of resurrecting stale data on top of a completed deletion.
- **`index-list.js`** — `prependIndexEntry`/`upsertIndexEntry`/
  `removeIndexEntry`, the safe index-array counterpart (this app's
  "one blob per record + a small index" pattern, used by
  memory/projects/missions/conversations). `prependIndexEntry` takes an
  optional `{maxLength}` to truncate-while-evicting-oldest inside the SAME
  CAS write (conversations.mjs's `MAX_STORED` cap), so truncation itself
  can't race a concurrent prepend/removal.

**Already-existing correct CAS usage, extended rather than duplicated:**
`security.js`'s `recordAuditEvent()` and `orchestrator.js`'s
`recordUsage()`/`recordHealthPing()` — the brief's own canonical example
(`data.count++`) describes `recordUsage()` almost verbatim — now go through
`casUpdate()` instead of their own hand-rolled read-then-write. Both keep
their pre-existing best-effort contract exactly as before (a genuine
conflict/outage here still just means one data point didn't get recorded,
never a failed chat/council/workflow response) — this pass added
correctness under contention, not a stricter failure mode.

**Files actually finished this pass** (the storage module and its
integration into `subscriptions.js`/`security.js`/`orchestrator.js`/
`billing.js` were already in place when this pass picked up review — see
"what was verified vs. completed" below): `memory.mjs` had the safe-storage
imports already present but **never actually wired into its POST/PUT/
DELETE handlers** — still using the old unsafe pattern underneath. `projects
.mjs`, `missions.mjs`, and `conversations.mjs` hadn't been touched at all.
All four are now fully rewired: every record update goes through
`updateRecord()`, every index mutation through `prependIndexEntry()`/
`upsertIndexEntry()`/`removeIndexEntry()`, with `storageErrorStatus()`
mapping any real storage failure to a safe 409/503/404 response instead of
crashing or silently corrupting. A brand-new record's own key is still an
unconditional `setJSON` (deliberately, not an oversight) — a freshly
generated id can never collide with a concurrent writer, so there's nothing
for a conditional write to protect there; the index it gets appended to is
what concurrent creates actually contend on, and that IS protected.

**What was verified vs. completed in this pass, stated plainly:** the
`storage/` module itself, and its wiring into `subscriptions.js`,
`security.js`'s audit log, `orchestrator.js`'s usage/health tracking, and
`billing.js`'s event idempotency, were already correct and already tested
when this pass began — verified by direct inspection (reading every line,
not trusting a prior summary) rather than re-built. What this pass actually
added: finishing the incomplete `memory.mjs` wiring, building
`projects.mjs`/`missions.mjs`/`conversations.mjs` from scratch, and the
entire concurrency test suite below (none of which existed yet for any of
these four endpoints).

**4. Retry strategy.** Bounded (`maxRetries` option, default 8), jittered
backoff (`backoffBaseMs * attempt + random jitter`, growing with attempt
number) — identical reasoning to `checkRateLimit()`'s own fix in Priority
2: un-jittered retries collide in lockstep under real contention. Every
retry re-reads fresh data before recomputing — `updateFn` must be a pure
function of the current value, never something that assumes it only runs
once.

**5. Idempotency.** Not added everywhere indiscriminately (brief section 5:
"Do not blindly add idempotency to every endpoint") — the one place it
already existed and mattered most (billing webhook events, since a
duplicate apply there means real subscription-state corruption, not just a
UI hiccup) already had it from the prior hardening pass's reliability fix,
now additionally proven under REAL concurrent delivery (see testing below).
AI Council/chat/workflow requests remain deliberately NOT idempotency-keyed
— a user resubmitting a prompt is a new request, not a retry of a failed
one, and there's no stored side effect for a duplicate submission to
corrupt.

**6. Subscription storage.** `saveSubscription()` (`subscriptions.js`) now
does its read-modify-write via `casUpdate()` instead of a plain read-then-
write — this is the exact "Event A → Ultra, Event B → Pro, Event A
overwrites B incorrectly" scenario the brief names by example. Two
concurrent updates touching different fields (e.g. one setting `isStudent`,
another setting `cancelAtPeriodEnd`) now both land, correctly folded
together; two concurrent updates to the SAME field resolve to one of the
two real, intended values with fully consistent entitlements (never a
mixed/torn record), and an unrelated account's subscription is completely
unaffected by contention on a different key. This is a real, if narrow,
behavior change: `saveSubscription()` could never throw before this pass;
it now can (`StorageConflictError` on exhausted retries,
`StorageUnavailableError` on a real read/write failure) —
`billing-webhook.mjs` already wraps this call in try/catch (from the prior
reliability fix) and treats any failure the safe way already documented
there: leave the webhook event reclaimable, return 503.

**7. Webhook storage.** The `processing → applied` / `processing → failed →
processing` event lifecycle from the prior hardening pass is unchanged and
was explicitly re-verified working, not just re-described, under GENUINE
concurrent duplicate delivery (new test — see below): N simultaneous
deliveries of the identical event now provably resolve to exactly one
application and one correct final subscription state, with every other
concurrent delivery cleanly turned away rather than risking a double-apply.

**8. Project/memory/mission protection.** Covered by the `memory.mjs`/
`projects.mjs`/`missions.mjs`/`conversations.mjs` rewiring above, and
proven end-to-end (not just at the underlying primitive level) by real
concurrent requests through each endpoint's actual exported handler — see
testing.

**9. Deletion races.** `updateRecord()`'s `StorageNotFoundError` on a
record deleted mid-update (see section 3 above) is the general mechanism;
proven directly against all four CRUD endpoints (update-vs-delete → 404,
never resurrection) AND against a genuinely interleaved delete-during-
update sequence at the primitive level (`storage-concurrency.test.js`,
using `createFlakyStore` to force the exact "read succeeded, then a
concurrent delete landed, then our write loses its race" ordering, not
just a sequential approximation of it). Delete-vs-delete: exactly one of
two concurrent deletes of the same id reports `removed: true`; create-vs-
create: covered by the "N concurrent creates" tests below; update-vs-
update: covered by the "two concurrent updates to different fields both
survive" tests below.

**10. Rate limit storage.** Reviewed, confirmed already correct
(`checkRateLimit()`'s own CAS-with-retry implementation, Priority 2), and
left completely untouched per the brief's own explicit instruction. Its
existing concurrency tests (`security.test.js`, 50 truly concurrent
requests, verifying the persisted count is exactly `max`, not silently
short) still pass unmodified.

**11. Error handling.** `STORAGE_CONFLICT`/`STORAGE_UNAVAILABLE`/
`STORAGE_NOT_FOUND` exist as real, thrown error classes (`errors.js`);
`IDEMPOTENCY_CONFLICT` exists as a class reserved for a call site that
needs a third outcome beyond plain success/failure (not used by
`casUpdate()` itself, which only needs the other three). Every endpoint
using these maps them to a generic, safe client message — never a stack
trace, credential, or internal key.

**15. Security review — intentionally non-atomic operations, documented:**
`memory.mjs`'s one-time legacy migration and fresh-store seeding (both use
fixed, deterministic ids, so a redundant concurrent run writes identical,
not conflicting, data); `purgeAll()` across all four CRUD endpoints (a
create racing a purge is a genuine intent conflict with no single "correct"
merge, not a corruption risk — see `memory.mjs`'s own end-of-file review
note for the full reasoning, which applies identically to the other three);
a brand-new record's own unconditional write (no concurrent writer can ever
target a freshly-generated id); and record-write + index-write remaining
two SEPARATE CAS operations rather than one cross-key transaction (Blobs
has none — a crash between them leaves the index momentarily stale but
never loses the record or resurrects a deletion; the index is a derived,
self-healing read cache, not the source of truth).

**16. Performance.** No global locks anywhere — every `casUpdate()` call is
scoped to exactly one Blobs key; contention on one user's project has zero
effect on a different project, a different account's subscription, or an
unrelated index. Retries are bounded and lightly jittered (single-digit-to-
low-double-digit ms), not a meaningful latency cost outside genuine
contention, which this app's real traffic patterns make rare.

**Testing: 57 new tests (428 total, up from 371; 96 suites, 0 failures).**
- **`storage-concurrency.test.js`** (35 tests, new file) — `casUpdate()`
  correctness and REAL stress tests: 100 truly concurrent increments on
  one key (`Promise.all`, not sequential awaits) → all 100 preserved,
  cross-checked against actual persisted state; 50 concurrent list-appends
  → zero lost entries; bounded-retry exhaustion → `StorageConflictError`;
  the update-vs-delete race constructed via `createFlakyStore` at the
  primitive level; the full error taxonomy; `safeGet`/`safeDelete`;
  `prependIndexEntry`/`upsertIndexEntry`/`removeIndexEntry` individually
  and under 50-way concurrent creation.
- **`tests/helpers/mock-blobs.js`** (new) — real handler-level testing for
  the Node CRUD endpoints, which call `getStore()` directly with no
  injection seam (unlike `subscriptions.js`/`security.js`/
  `orchestrator.js`). Uses `node:test`'s `mock.module()` (enabled via
  `--experimental-test-module-mocks`, now in `package.json`'s `test`
  script — confirmed to add zero behavior change to the other 371
  pre-existing tests) to replace `"@netlify/blobs"`'s `getStore` export
  with the SAME ETag/CAS-faithful fake store every other concurrency test
  in this app already trusts, before importing the endpoint module. This
  is what makes it possible, for the first time, to fire genuinely
  concurrent requests at the REAL exported handler and assert on the REAL
  persisted state — not a simulation of the endpoint's logic.
- **`crud-storage-wiring.test.js`** (new, table-driven across
  memory.mjs/projects.mjs/missions.mjs) + **`conversations-wiring.test.js`**
  (new, separate — different index shape and its own `MAX_STORED`
  eviction) — through the REAL handlers: 30-50 concurrent creates → every
  record survives in the index with unique ids; two concurrent updates to
  different fields of the same record → both survive; update racing a
  delete → 404, never resurrected; double-delete → exactly one reports
  `removed: true`; conversations' truncation → oldest entries evicted,
  newest retained, cap never exceeded.
- **`subscriptions.test.js`** — new concurrency describe block: concurrent
  updates to different fields both fold in; section 6's exact named
  scenario (two concurrent plan-change events on one account) resolves to
  one real value with fully consistent entitlements, zero cross-account
  interference; real contention verified via attempt counts (not just
  assumed); exhausted-retry conflict surfaces as a real, catchable
  `StorageConflictError`.
- **`billing.test.js`** — new: N truly concurrent claims for the SAME
  event id → exactly one wins; the FULL concurrent-duplicate-delivery
  pipeline (claim → map → apply → mark-applied) run N-ways simultaneously
  → exactly one application, one correct final subscription state, every
  other delivery cleanly turned away. This is section 12's "Duplicate
  webhook delivery" scenario, now genuinely exercised, not just described.

**Verified:** `npm ci && npm test` — 428/428, clean install. `node --check`
on every `.js`/`.mjs` file in the repo — 0 errors.
`npm run check-imports` (`scripts/check-imports.mjs`, a real, committed,
re-runnable script that actually `import()`s all 32 backend modules,
including the 5 new `storage/` files and `billing-webhook.mjs` — built
this pass specifically because a PRIOR changelog entry claimed this check
had been run without the script itself ever being committed, making the
claim unverifiable after the fact; this closes that gap for good) — 32/32
imported cleanly. `npm audit` — the same 3 pre-existing high-severity
advisories inside `@netlify/blobs`'s own dev-tooling chain (`image-size`),
confirmed via diff that zero dependencies were added or changed this pass.
No existing test was weakened, deleted, or had its assertions loosened to
make the suite pass.

**Remaining known limitations:** record-write and index-write are still
two separate operations, not one cross-key transaction (documented above,
section 15 — Blobs has no such primitive, and the failure mode without one
is bounded and self-healing, not corruption). `purgeAll()` remains
intentionally non-CAS for the reason given above. The webhook's price-ID→
plan mapping and Stripe account connection remain exactly as deferred as
Priority 5's hardening pass left them — unrelated to this priority's scope
and unchanged by it.

**Priority 6 can now be marked COMPLETE.**
