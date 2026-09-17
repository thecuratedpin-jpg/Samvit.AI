# Samvit V11 — Architecture & Implementation Record

This document describes what V11 actually added on top of the V10 codebase,
what was **already present** before this work (so it is not double-counted),
and what remains honestly unimplemented. Where a claim here and the code
disagree, the code is right.

Scope rule followed throughout: **audit → plan → implement in phases → test →
verify → continue**, and **no wholesale rewrite**. Every existing module was
extended in place; every one of the 173 tests that passed before this work
still passes, and none were weakened.

---

## 1. Audit result — what V10 already had

The V10 snapshot was substantially further along than a first reading
suggests. The following brief phases were **already implemented** and were
therefore *not* rebuilt:

| Phase | Already present in V10 | Where |
|---|---|---|
| 3 — Mission system | Persistent missions with goal, plan, task graph, status, attempts, lease, budget, trace, timestamps | `intelligence/jobs.js`, `intelligence/runtime.js` |
| 4 — Autonomous loop | PLAN → EXECUTE → OBSERVE → VERIFY → REPLAN, with bounded waves, attempts, time, calls and spend | `intelligence/runtime.js` |
| 6 — Model routing | Capability matrix scoring, reasoning budgets (TRIVIAL…MAX), health/cooldown observation, dynamic fallback | `intelligence/model-routing.js`, `intelligence/model-call.js` |
| 8 — Background execution | Signed worker dispatch, scheduled dispatcher, lease/heartbeat recovery, pause/resume/cancel | `intelligence/dispatch.js`, `functions/orchestration-dispatch.mjs` |
| 9 — Verification | Claim-level verification with freshness rules, citation downgrade, honest `independentlyProven` | `intelligence/verification.js` |
| — Safety substrate | Tool grants, per-tool risk, `confirmationRequired`, SSRF guards, no `eval` anywhere | `intelligence/tools.js`, `intelligence/safe-fetch.js` |

**Baseline defect found and fixed first.** Five test files
(`accounts`, `billing-v7`, `v6`, `setup`, `endpoints`) registered
`mock.module('@netlify/blobs', {exports: …})`. That key is only honoured by
Node ≥ 24; on Node 22 the mock silently exported nothing and the suite
aborted with *"does not provide an export named 'getStore'"*. The v8/v9
tests already used the portable `namedExports` key. Fixing those five call
sites (and `stripe`'s `defaultExport`) took the suite from **124 passing /
5 failing files** to **173 passing**. No assertion was changed.

---

## 2. What V11 added

### Phase 2 — Permission & Safety Engine (`intelligence/permissions.js`)

The one gate every state-changing action must pass.

* **Four ordered levels**: `OBSERVE` (0) → `SAFE_ACTION` (1) →
  `SENSITIVE_ACTION` (2) → `HIGH_IMPACT_ACTION` (3).
* **`ACTION_POLICY`** — every action category classified once, in source.
  The model never names a level; it names a verb. Categories not listed fall
  back to the tool's own declared `risk`, and anything both unlisted and
  undeclared defaults to `SENSITIVE_ACTION` — never `SAFE`.
* **`decideAction()`** — a *pure* function (no store, no I/O) returning
  `{allowed, level, levelName, requiresConfirmation, reason}`, so every rule
  is directly unit-testable. Reasons are specific: `not_granted`,
  `kill_switch`, `confirmation_required`, `safety_unavailable`, `permitted`.
* **Kill switch** — persisted per account, read at **every** gate including
  `runtime.js`'s `assertActive()`, so a *running* mission stops promptly.
  Observation stays available while the switch is on, so a user can still
  inspect what already happened.
* **Fail-closed on outage** — if the safety state cannot be read, every
  action above `OBSERVE` is denied. A storage blip must never grant authority.
* **Bounded audit trail** — last 200 decisions per account
  (`action`, `levelName`, `outcome`, `reason`, `at`).
* **`declaredConfirmation` can only raise a level**, never lower it — this is
  what let the engine adopt V10's existing `confirmationRequired` tools
  without loosening any of them.
* Wired into `executeTool()` as the single gate. `/api/safety` exposes state
  and audit, and toggles the switch.

### Phase 1 — Computer Agent Foundation (`intelligence/vfs.js`, `intelligence/terminal.js`)

**Honest constraint first:** Samvit runs on serverless functions. It cannot
reach the user's real computer, and it must not try. What V11 provides
instead is a *real* computer the agent can genuinely operate: a persistent,
per-account, quota-bounded **virtual filesystem**, plus a **sandboxed
terminal**.

* **`vfs.js`** — `listDir`, `statEntry`, `readFile`, `writeFile`, `makeDir`,
  `moveEntry`, `copyEntry`, `deleteEntry`, `walk`, `searchFiles`, `usage`.
  Real directory/file semantics including recursive copy and delete.
  * `splitPath()` is the single place a path becomes segments, so containment
    is enforced once. It rejects `..` outright (including a `..` that would
    normalise away — stricter and simpler to reason about), backslashes,
    control characters, over-long segments and over-deep nesting.
  * Quotas: 200 files, 100 KB/file, 2 MB total, depth 8.
  * All writes are CAS-protected via the existing `casUpdate()`.
* **`terminal.js`** — a command *interpreter*, not a shell.
  1. **Allow-listed verbs only** — `pwd ls tree find stat cat head wc grep
     mkdir touch write cp mv rm help`.
  2. **No shell surface** — `tokenize()` rejects `| & ; \` $ > < ( ) { }`
     newline, and wildcards `* ? [ ]`. There is no `eval`, no `child_process`
     and no host filesystem call in the import graph.
  3. **Structured actions** — each verb maps to a permission category from
     `ACTION_POLICY`, so `rm` *is* `delete_file` and is gated as such.
* **Nine new tools** registered: `inspect_environment`, `fs_list`, `fs_read`,
  `fs_stat`, `fs_search`, `fs_write`, `fs_mkdir`, `fs_move`, `fs_copy`,
  `fs_delete`, `terminal`. Each carries an explicit `action` category.
* **Least privilege at mission creation** (`jobs.js`): `allowComputer` grants
  `COMPUTER_GRANTS` (observe + reversible in-sandbox work). Deletion is
  deliberately excluded and needs **both** `allowDelete` *and* the
  pre-recorded `delete_file` confirmation.

### Phase 5 — World State & Experience (`intelligence/world-state.js`)

Memory answered *"what did the user say?"*. This answers *"what is true, and
what has actually worked?"* — four separately bounded layers:

* **Transient** — per-mission context; stays on the job record, never copied.
* **Durable** — facts upserted by `(kind, key)` across `project | file |
  environment | constraint | decision | goal | tool`. Corrected, never
  duplicated. Capped at 120.
* **Mission** — owned by `jobs.js`; referenced by id, so there is one truth.
* **Experience** — outcomes aggregated **by signature**
  (`capability:complexity:strategy`), not appended blindly: 40 identical runs
  collapse to one row with counts. Capped at 60, evicting least-proven first.
  Only the model that carried a *success* is credited.
* **`planningHints()`** is deliberately conservative: a strategy is only
  recommended after ≥2 attempts and ≥60% success, and only discouraged below
  34%. One bad run is noise, not a verdict.

### Phase 10 — Observability (`intelligence/trace.js`)

* `traceEntry()` emits **only** a fixed field whitelist
  (`at, kind, status, tool, model, provider, action, level, levelName, task,
  reason, latencyMs, estimatedMicroUsd, attempt, note`). Anything else passed
  in is dropped.
* `scrub()` is a second line of defence: it recursively deletes keys matching
  `reasoning | thinking | thought | chain_of_thought | cot | scratchpad | …`,
  so even a raw provider object passed through by mistake cannot leak hidden
  reasoning.
* `summarizeMission()` — plan, per-task status, models, tools, actions,
  retries, warnings, budget, and an evidence block whose
  `independentlyProven` is `true` only when a real verifier task produced a
  verification record.
* `reasoningSummary()` — concise prose of observable decisions, not thoughts.
* `completionNotification()` — Phase 8's required shape: requested,
  completed, changes, failures, warnings, verification, plus an
  `honestCaveat` whenever the result was not independently proven.
* Derived **on read** in `/api/orchestration`, so the trace panel and the
  notification can never drift from stored state.

### Phase 7 — Voice (`src/voice.js`)

`VOICE INPUT → recognition → Samvit core → mission system → text → synthesis`.

* **Not always-on.** The microphone opens only on explicit user action
  (`enable()`), and the wake phrase gates what is *acted on*.
* **Wake phrase** `"Hey Samvit"`, configurable, matched on a normalised
  letter/digit form so `"Hey Samvit,"` and `"hey   SAMVIT"` both work.
* **Interim results never become missions** — a half-heard sentence cannot
  start work. The phrase may be spoken separately from the command.
* **No privilege escalation.** A spoken goal is submitted through the exact
  same form/endpoint as a typed one, inheriting identical grants,
  confirmations, kill switch and audit.
* **Graceful degradation** — unsupported browsers get a disabled control and
  a clear message; a declined microphone turns voice off rather than retrying.
* `Permissions-Policy` changed from `microphone=()` to `microphone=(self)`.

### Phase 9 → computer actions — Environment Verification (`intelligence/environment.js`)

Claim verification (`verification.js`) reviews what a *model wrote*. It cannot
tell you whether a file was actually written. This closes that gap, and is the
one verification path in the system that is genuinely independent rather than
model-reviewed.

* **`vfs.snapshot()`** — a compact digest of every sandbox entry (type, bytes,
  truncated content hash). Bounded by the existing quotas, so a snapshot is
  always cheap.
* **`effectFor(call)`** — derives the observable change a tool call *promises*:
  `fs_write`/`fs_mkdir` → present, `fs_delete` → absent, `fs_move` → source gone
  + destination present, `fs_copy` → destination present. Sandboxed `terminal`
  verbs are mapped the same way by re-parsing the command. Read-only tools
  return `null`, so they can never be reported "missing". Malformed or
  traversal paths return `null` rather than a guess — a wrong expectation would
  produce a wrong verdict.
* **`verifyEnvironment()`** — checks the *after* snapshot directly (state-based,
  not diff-based, which avoids write-then-delete false positives), and reports
  `missing` (promised but not observed) and `unexpected` (changed but requested
  by nothing).
* **Runtime wiring** — `runtime.js` snapshots around every task whose tools can
  change the environment, verifies against that task's recorded effects, and
  aggregates per-task reports into `verification.environment`. A promised change
  that never happened makes the mission **`partial`**, not `completed`.
* **Honesty preserved** — mission-level `independentlyProven` stays `false`
  (model claims are still model-reviewed), while
  `verification.environment.independentlyProven` is `true` when every promised
  change was confirmed. The notification's `honestCaveat` states exactly that
  distinction instead of rounding up.

### Phase 3 → success criteria

`specSchema` now carries an optional `success_criteria` list, normalised by
`normalizeSuccessCriteria()` and fed into the planning prompt so the plan must
address each criterion. Deliberately validated **leniently** — it is advisory
metadata, so a model returning a stray `null` or eleven entries gets them
filtered and capped rather than failing the whole mission.

### Phase 5 → 6 closure

`runtime.js` reads `worldState()` once per mission and uses
`hints.preferredModel` to **promote** (never force) a proven model in the
candidate pool, and passes `experienceGuidance(hints)` into the planning
prompt as *evidence, not instruction*. Empty history produces an empty
string, so behaviour is unchanged on a cold start.

---

## 3. Testing

| | Before | After |
|---|---|---|
| Test files | 5 failing (aborted) | 0 failing |
| Tests passing | 124 (129 collected) | **209** |

New coverage (`tests/permissions-v11.test.js` — 14 tests, `tests/voice-v11.test.js` — 10 tests, `tests/environment-v11.test.js` — 12 tests):

* Level ordering; every policy category classified; unknown defaults strict.
* `decideAction` across grant / kill switch / confirmation; declaration can
  only raise a level; observation survives the kill switch.
* Kill switch persistence, **cross-account isolation**, audit contents.
* **Fail-closed** denial on an unreachable safety store (via
  `createFailingStore()`), with observation still permitted.
* VFS traversal/host-path/control-character rejection, deep-nesting and
  segment limits, real file operations, cross-account isolation, quotas,
  root-deletion refusal.
* Terminal: allow-listed execution, nine shell-injection shapes rejected,
  unknown verbs, usage errors, unterminated quotes, deletion denied without
  confirmation and allowed with it, non-zero exit on command failure.
* End-to-end tool gating: `fs_write` → `terminal cat` → kill switch blocks
  writes but not reads; deletion needs its own grant.
* `availableTools` exposes levels and withholds computer tools until granted.
* `createJob` least-privilege grant/confirm sets.
* Experience aggregation, model crediting, conservatism, bounding; durable
  fact upsert; `worldState` separation.
* Trace field whitelisting, `scrub()` removal, bounded appending, honest
  verification reporting and caveat.
* Voice wake-phrase matching, opt-in gating, interim-result safety,
  two-utterance flow, custom phrase, synthesis silencing, error handling,
  graceful degradation.
* `experienceGuidance` reach into the planner prompt, and no-guidance
  behaviour when history is absent.
* **Environment verification** (driven through the real VFS and the real tool
  pipeline, not mocks): effect derivation for every environment-changing tool
  and terminal verb; read-only and malformed calls yielding no expectation;
  snapshot diffing; a write that really happened verifying as `verified`; a
  write that never happened reported `unresolved`; deletion verified by
  absence; moves verified by source-gone + destination-present; unexplained
  changes surfaced as `unexpected`; per-task reports merging into an honest
  mission verdict; and mission summaries/notifications carrying the
  environment result without inflating the mission-level proof claim.
* Success-criteria normalisation, including malformed/oversized/non-array
  input never failing the mission.

`node scripts/check-imports.mjs` → **111 modules, 0 errors**.

---

## 4. Honestly still limited

Stated plainly, because the alternative is a claim the code cannot back:

1. **No host computer access.** The "computer" is the virtual sandbox. Real
   OS control would require a locally-installed agent, which this
   serverless deployment does not have. Nothing in V11 pretends otherwise —
   the tool descriptions and `inspect_environment` both say so.
2. **No native code execution.** There is no interpreter, compiler or
   `eval` path. `execute_code` exists in `ACTION_POLICY` as a
   `SENSITIVE_ACTION` category so that a future sandbox would be classified
   correctly, but no tool implements it.
3. **Voice depends on the browser.** Recognition uses the Web Speech API;
   quality and availability vary by browser, and Chrome's implementation is
   cloud-backed. There is no server-side STT/TTS.
4. **Experience is per-account, not cross-account.** A new account starts
   with no learned history, by design.
5. **Routing remains heuristic.** Candidate scoring is a capability matrix
   plus observed health; it is not a trained policy, and
   `observeModel()`'s cooldowns are a blunt instrument.
6. **Verification is split, and only one half is independent.** Computer
   actions are checked against real sandbox state, so
   `verification.environment.independentlyProven` is a genuine claim. Written
   *content* is still only model-reviewed: mission-level
   `independentlyProven` is `false` for every mission the pipeline can produce,
   and the notification says so. There is no external ground truth for prose.
7. **Netlify Functions still cannot run persistent background workers.** The
   dispatcher is a scheduled function polling a queue; a mission advances on
   dispatcher ticks, not continuously.
8. **The kill switch is per account, not global.** There is no operator-wide
   emergency stop.

---

## 5. Files

**Added**

```
netlify/lib/intelligence/permissions.js   Phase 2 — permission & safety engine
netlify/lib/intelligence/vfs.js           Phase 1 — virtual filesystem
netlify/lib/intelligence/terminal.js      Phase 1 — sandboxed terminal
netlify/lib/intelligence/world-state.js   Phase 5 — world state + experience
netlify/lib/intelligence/trace.js         Phase 10/8 — trace + notifications
netlify/lib/intelligence/environment.js   Phase 9 — environment verification
netlify/functions/safety.mjs              Phase 2 — /api/safety (kill switch)
src/voice.js                              Phase 7 — voice engine
tests/permissions-v11.test.js             regression tests
tests/voice-v11.test.js                   regression tests
tests/environment-v11.test.js             regression tests
docs/V11-ARCHITECTURE.md                  this document
```

**Modified**

```
netlify/lib/intelligence/tools.js         9 computer tools + engine as the single gate
netlify/lib/intelligence/jobs.js          allowComputer / allowDelete grants + confirmations
netlify/lib/intelligence/runtime.js       kill switch in assertActive, structured trace, experience
                                          recording, environment snapshot + verification per task
netlify/lib/intelligence/agent.js         records the environment effect each successful computer action promises
netlify/lib/intelligence/vfs.js           snapshot() — bounded real-state digest
netlify/lib/intelligence/planning.js      experienceGuidance() advisory planner context, success_criteria
netlify/functions/orchestration.mjs       derived trace/summary/notification, safety state, tool listing
netlify/lib/store-inventory.js            samvit-safety / samvit-vfs / samvit-world in the deletion inventory
index.html, src/app.js, src/intelligence.js, netlify.toml   voice wiring, permissions UI, kill switch, trace panel
package.json                              11.0.0
tests/{accounts,billing-v7,v6,setup,endpoints}.test.js      Node 22/24 mock-key portability fix
```
