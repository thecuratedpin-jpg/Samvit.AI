# Samvit V12 — Desktop Bridge: audit, plan and record

The mission is to evolve V11 into a secure autonomous computer agent. This
document records the audit that was actually run, the one architectural
constraint that determines the whole design, the plan, and — at the end —
what was built versus what remains.

Rule followed: **audit → plan → implement phase-by-phase → test → verify**.
No rewrite. The VFS sandbox stays. The existing permission system stays and is
extended, not replaced.

---

## 1. Audit

### Baseline (measured, not assumed)

```
npm test    -> 210/210 passing
npm run build -> 111 server/shared modules checked, 0 errors
```

### Systems that already exist and are reused as-is

| Brief phase | Already present | Where |
|---|---|---|
| 3 — Permission levels | `OBSERVE / SAFE_ACTION / SENSITIVE_ACTION / HIGH_IMPACT_ACTION`, `ACTION_POLICY`, kill switch, audit | `intelligence/permissions.js` |
| 5 — Observation + verification | Environment snapshot/diff/verify, per-task verification | `intelligence/environment.js` |
| 7 — Background missions | Persistent jobs, leases, heartbeats, budgets, checkpoints, recovery, pause/resume/cancel | `intelligence/jobs.js`, `intelligence/runtime.js` |
| 8 — Task graph | Bounded DAG with dependencies, kinds (`work`/`verify`/`synthesis`), dynamic repair | `intelligence/planning.js`, `intelligence/runtime.js` |
| 9 — World model | Durable facts, constraints, decisions, experience, `worldState()` | `intelligence/world-state.js` |
| 10 — Experience | Outcome aggregation by signature + conservative `planningHints()` | `intelligence/world-state.js` |
| 11 — Model routing | Capability matrix, reasoning budgets, health/cooldown, fallback | `intelligence/model-routing.js` |
| 13 — Voice | Opt-in engine, wake phrase, no privilege escalation | `src/voice.js` |
| 14 — Notifications | `completionNotification()` with honest caveat | `intelligence/trace.js` |
| 15 — Injection resistance | Untrusted-data framing, schema validation, SSRF guards, no `eval` | `intelligence/agent.js`, `safe-fetch.js` |
| 16 — Observability | Fixed-field trace, `scrub()`, `reasoningSummary()` | `intelligence/trace.js` |
| — | Sandboxed VFS + allow-listed terminal | `intelligence/vfs.js`, `terminal.js` |

**Conclusion: roughly two thirds of this brief is already implemented.** The
genuine gap is the headline milestone — the bridge to the user's real computer.

### The constraint that determines the design

Samvit runs on **Netlify Functions: request-scoped, no persistent inbound
connection.** The cloud therefore *cannot dial* a process on the user's PC.

So the desktop agent **polls outbound**. This is not a compromise — it is the
more secure shape:

* no listening port on the user's machine,
* no inbound firewall rule,
* the agent is the only party that ever initiates a connection,
* revoking a device is a single server-side flag.

```
Samvit Cloud (Netlify)                    User's Windows PC
┌────────────────────────────┐            ┌─────────────────────────────┐
│ /api/devices      (UI)      │            │  samvit-agent (Node)        │
│   pair / list / revoke      │            │                             │
│ /api/device-agent (agent)   │  ◄──poll───│  signed + short-lived token │
│   session / poll / complete │  ──result─►│  scope enforcement          │
│                            │            │  capability execution       │
│ samvit-devices store        │            │                             │
│  device records + queue     │            │  Windows filesystem         │
└────────────────────────────┘            └─────────────────────────────┘
```

---

## 2. Plan

### Phase 1 — Desktop agent (`agent/`)
A dependency-free Node daemon. Structured capabilities only — **no arbitrary
PowerShell, cmd, or filesystem API is ever exposed to a model**:

`fs.list` `fs.stat` `fs.read` `fs.search` `fs.write` `fs.mkdir` `fs.move`
`fs.copy` `fs.delete` `dev.run` `env.inspect` `request_user_decision`

`dev.run` takes a structured `{executable, args[]}`, never a shell string, and
is allow-listed by executable **and** by the device's approved command list.

### Phase 2 — Pairing (`intelligence/devices/registry.js`)
Short-lived single-use pairing code → hashed device token → HMAC-signed
requests with timestamp + nonce replay protection → short-lived session token
for polling → revocation. The cloud stores only a hash of the token, so a
storage leak cannot be replayed against a device.

### Phase 3 — Scopes (`shared/desktop.js`)
Windows-hardened path containment: rejects `..` traversal, UNC paths, device
paths (`\\?\`, `\\.\`), alternate data streams, reserved device names
(`CON`, `NUL`, `COM1`…), drive-relative paths and control characters; normalises
case and separators. The agent additionally resolves the **real** path
(`realpath`) and re-checks containment, so a symlink or junction cannot escape.

### Phase 4 — Policy engine (`intelligence/devices/policy.js`)
Model output → ACTION REQUEST → policy → `ALLOW | DENY | ASK_USER` → agent.
Pure decision function plus a store-backed entry point with audit, mirroring
`council-access.js`'s existing convention.

### Phase 5 — Observation loop
Every action carries an expected effect; the agent returns a real observation;
the cloud compares expected vs actual and refuses to report success on a
mismatch. Extends `environment.js`'s existing shape.

### Phase 6 — User decisions
`request_user_decision` moves a mission to `WAITING_FOR_USER`; the UI shows
what, why and the options; approving resumes from the checkpoint.

### Phase 12 — Adapter interfaces
`BrowserAdapter`, `ScreenObserver`, `ApplicationAdapter`, `ComputerAction` as
declared interfaces that plug into the same pipeline and report themselves
unavailable — architecture prepared, deliberately not implemented.

### Phase 15 — Global emergency stop
A deployment-wide stop, in addition to the existing per-account kill switch.

### Phases 7–11, 13, 14, 16
Reused and extended where the bridge touches them (notification, trace,
experience, routing).

---

## 3. Non-goals honoured

No foundation-model training. No model replacement. The VFS is kept. The
existing permission system is extended, not removed. No unrestricted OS access.
No unbounded loops. No silent destructive actions. No AGI claims.

---

## 4. What was built

```
npm test      -> 237/237 passing   (was 210; +27 desktop-bridge tests)
npm run build -> 123 modules, 0 errors  (was 111)
```

### Added

```
shared/desktop.js                         capability catalog, path hardening, scope rules,
                                          command floor, argument validation, observation check
netlify/lib/devices/registry.js           pairing, bearer auth, sessions, scopes, revocation
netlify/lib/devices/queue.js              action queue with leases + verification
netlify/lib/devices/policy.js             ALLOW / DENY / ASK_USER decision engine
netlify/functions/devices.mjs             /api/devices        (user-facing)
netlify/functions/device-agent.mjs        /api/device-agent   (agent-facing, polling)
agent/main.js                             the daemon (poll → execute → report)
agent/pair.js                             pairing CLI
agent/executor.js                         capability execution + realpath scope re-check
agent/transport.js                        short-lived session + replay-protected requests
agent/config.js                           credentials stored outside the repository
agent/adapters.js                         BrowserAdapter / ScreenObserver / ApplicationAdapter
src/computers.js                          pairing, folder authorisation, approvals, stop UI
tests/desktop-v11.test.js                 27 tests
```

### Modified

```
netlify/lib/intelligence/permissions.js   + deployment-wide emergency stop (fails closed)
netlify/lib/store-inventory.js            4 new stores registered for account deletion
netlify/functions/safety.mjs              operator-gated global stop
scripts/check-imports.mjs                 agent/ is now import-checked too
index.html, src/app.js                    Computers page
.env.example                              SAMVIT_OPERATOR_SECRET
```

### A cryptographic design error caught and corrected

The first version had the server verify an HMAC using a *hash* of the signing
key, which cannot work — and storing the real key would have been worse, since
a storage leak would then become the ability to impersonate a device. It was
replaced with a bearer token (SHA-256 stored, constant-time compared) used only
to mint a 10-minute session token, which is what polling actually uses. A
stored hash cannot be replayed; a stored HMAC key could have been.

### One deliberate divergence from the cloud engine

On the cloud, `OBSERVE` survives the kill switch so a user can inspect state.
For a **device**, the stop halts everything including reads — because every
device capability reaches into someone's real computer, and a stop that still
let Samvit read files would not be an emergency stop. Documented in
`devices/policy.js`.

---

## 5. What remains (honest status)

| Phase | Status |
|---|---|
| 1 Desktop agent | **Done.** 12 structured capabilities. No arbitrary shell anywhere. |
| 2 Device pairing | **Done.** Short-lived single-use code, hashed bearer, 10-min session, replay protection, revocation. |
| 3 Scoped permissions | **Done.** Allow-list scopes + realpath re-check; system dirs and drives cannot be authorised. |
| 4 Policy engine | **Done.** Pure `ALLOW/DENY/ASK_USER` + audited store-backed entry point. |
| 5 Observation loop | **Done.** Expected vs observed, per action, with leases. |
| 6 User decisions | **Backend + UI done.** `request_user_decision` capability and the approve/deny queue exist. *Not yet wired into the mission runtime's `WAITING_FOR_USER` status* — see below. |
| 7 Background missions | **Reused.** Existing leases/checkpoints/budgets already satisfy this; device actions inherit them. |
| 8 Hierarchical missions | **Reused.** The existing DAG is the objective/task/verification structure. |
| 9 World model | **Reused.** `world-state.js` already tracks durable facts and constraints. |
| 10 Experience | **Reused.** Aggregation by signature, unchanged. |
| 11 Model routing | **Reused.** PRO/FLASH propagation unchanged and still tested. |
| 12 Adapters | **Interfaces done, deliberately unimplemented.** |
| 13 Voice | **Reused.** Unchanged; grants nothing extra. |
| 14 Notifications | **Reused.** Completion notification carries an honest caveat. |
| 15 Security | **Done for the bridge.** Path traversal, UNC/device paths, ADS, reserved names, symlink escape, command floor, replay, revocation, injection framing, global stop. |
| 16 Observability | **Reused.** Device actions are audited; the queue record is the action log. |
| 17 Testing | **27 new tests**, all security-critical paths covered. |

### The two things I did not finish

1. **Mission → `WAITING_FOR_USER`.** The decision queue, the approve/deny UI and
   the `request_user_decision` capability all exist and are tested, but a
   *mission* does not yet pause itself into that state and resume from its
   checkpoint. Today the decision surfaces as an action awaiting approval,
   which is functional but not the full Phase 6 loop.
2. **Device actions are not yet callable from inside a mission.** They are
   reachable through `/api/devices` and the agent, but no cloud-side *tool*
   (`computer.*`) wraps them, so the model cannot yet request one during a
   mission. That is the next step, and the policy engine is already the right
   shape to receive it.

Neither is a safety gap — both are missing capability, not missing control.

---

# V12.1 — the end-to-end execution layer

Both of the gaps above are now closed. This section records that increment.

```
npm test      -> 268/268 passing   (was 237; +31)
npm run build -> 125 modules, 0 errors  (was 123)
```

## P0 — Samvit brain → real PC

Eleven first-class cloud tools now reach a paired computer:
`computer_inspect`, `computer_list`, `computer_read`, `computer_search`,
`computer_write`, `computer_mkdir`, `computer_move`, `computer_copy`,
`computer_delete`, `computer_run`, plus `request_user_decision`.

They do not touch the server filesystem. Each one validates arguments,
resolves the mission's device, checks pairing/revocation, applies the policy
engine (capability level → scopes → approved commands), enqueues a structured
action, waits for the agent, and returns the **real observation**. A timeout is
reported as a timeout; a verification mismatch is reported as one.

**Sandbox and local PC are separate surfaces.** They are unlocked by different
grants, so sandbox grants cannot reach a real computer or vice versa, every
local tool's description says `PAIRED LOCAL COMPUTER`, and every result carries
`environment: "local_pc"`.

## P1/P6 — device-aware planning and multi-device

Missions carry `deviceId` and `environment` (`sandbox` | `local_pc`).
`resolveTargetDevice` picks explicitly, auto-selects when exactly one computer
is paired, and **refuses to guess** between several — it names them and asks.
`deviceAvailability` reports platform, authorised folders, approved commands and
online/offline state, derived from the agent's last poll (no machine scanning).
A mission with no usable computer explains the exact missing requirement.

## P2 — real mission state machine

`waiting_for_user` is now a first-class, non-terminal status. A decision request
does not fail the mission: the task stays `pending`, the mission parks with
`pendingDecision`, and answering it records the answer, re-queues, and resumes
from that checkpoint. A parked mission is not claimable by a worker, is
idempotent if resumed without an answer, and cannot be answered twice, forged,
or answered across accounts.

## P3 — durable action receipts

The real reliability hole: the agent performs a state-changing operation, then
crashes before reporting. The lease expires, the action is redelivered, and the
operation runs twice. `agent/receipts.js` keeps a bounded, crash-safe receipt
log; a redelivered action is **replayed from its receipt** instead of executed
again. Only successful state-changing actions are receipted — a failure leaves
no receipt, so a genuine retry still happens.

## P4 — observation → verification → repair

Every action carries an expected effect; the agent returns a real observation;
the cloud compares them. Failures are now informative rather than generic:
a task failure keeps the real reason (which step broke and why), and a mission
that produces no deliverable records exactly which steps failed. Scope refusals
say *why* — "inside a folder authorised for reading only" is not the same as
"outside the authorised folders", and the shared wording is identical on the
cloud and agent sides.

## P7 — testing

31 new tests across two suites:

* `tests/desktop-e2e-v11.test.js` (28) — sandbox/local separation, device
  selection, missing/revoked device, permission denial, kill switch, out-of-scope
  path, junction escape, command approval, enqueue/completion/timeout/retry,
  duplicate delivery, durable receipts, verification failure, WAITING_FOR_USER,
  resume, cancel, offline recovery, multi-device isolation, least-privilege grants.
* `tests/desktop-live-v11.test.js` (3) — **the proof.** A real HTTP server
  serves the real `/api/device-agent` handler; the real agent transport polls it;
  the real executor writes to a real temporary directory. Verified: the file
  exists on disk with the expected content, the cloud verified the observation,
  an out-of-scope write was refused over the wire and nothing was written, and a
  real `node --version` came back through the pipeline.

### Platform-specific test limitations

The Windows path hardening in `shared/desktop.js` is deliberately
Windows-specific and is tested as such — those rules were **not** weakened to
make any platform pass. The executor tests use the OS temp directory, so they
run anywhere; the junction-escape test **skips itself** where symlinks cannot be
created without elevation. There is no separate CI job yet: `npm test` is the
single entry point and runs everything it can on the host platform.

## P8/P9 — observability and UI

Every action record carries `missionId`, `deviceId`, `capability`, the policy
decision, attempt count, observation, report, verification result and failure
code. The Computers page shows paired devices, online/offline state, authorised
scopes, approved commands, pending approvals and results. The mission panel
shows the decision prompt and resumes the mission when answered. No secrets,
tokens or file contents are logged.

## Bugs found and fixed during this increment

1. **Transport could never pair.** `post()` treated every non-`device` auth as a
   session, so `auth: 'none'` threw "No session token has been issued yet".
   Pairing would have failed against the live endpoint — the live test caught it.
2. **The agent's real result never reached the cloud.** Only the observation was
   stored, so the model got a boolean instead of file contents or command output.
3. **Optional tool arguments were required.** The schema helper marks every
   property required, so `computer_write` demanded `createFolders`. Fixed with
   explicit required lists.
4. **Swallowed failure reasons.** A failed task reported "Task could not complete
   within its tools, model access or budget" regardless of the actual cause,
   hiding which step broke. Now the real reason is preserved.
5. **Misleading scope message.** A read-only refusal claimed the path was
   "outside the authorised folders", which sends the user to the wrong fix.

## Remaining gaps

* **No live cloud deployment test.** The proof runs against the real handler
  over real HTTP but with a local server and a fake blob store, not Netlify.
* **Device actions inside a mission are proven at the unit and dispatch level,
  not by a full mission run against a live agent.** `runJob` + `requestDeviceAction`
  are each tested; the two are not yet driven together end to end.
* **One agent per computer.** Sessions are per device, so two agents on one
  machine would share a session. Not a security issue, but a scaling limit.
* **No queue depth limit per device.** `MAX_ACTIONS` bounds total history, not
  outstanding work for one computer.
* **Browser/screen/application adapters remain declared-only**, as the brief
  requires.


