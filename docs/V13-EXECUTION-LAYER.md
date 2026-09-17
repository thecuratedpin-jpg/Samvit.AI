# Samvit V13 — the verified computer-execution loop

This record continues `docs/V12-DESKTOP-BRIDGE.md`. V12.1 built the bridge
and the tools; V13 closes the gaps that stage honestly listed as "not yet
done", and proves the composite loop end-to-end:

```
GOAL → PLAN → ACT on the paired PC → OBSERVE → VERIFY
→ SUCCESS / REPAIR / REPLAN / ASK USER → mission outcome that tells the truth
```

Measured before and after, on the same tree:

```
npm test      -> 268 tests, 257 pass / 11 fail (Linux)   [V12.1 baseline]
              -> 279 tests, 279 pass / 0 fail  (Linux, this change)
npm run build -> 125 server/shared modules checked; 0 errors
```

No existing system was rewritten or duplicated. The device queue, the policy
engines, pairing/security, the mission runtime and its leases/checkpoints are
the same ones V12 built; every change below extends them.

---

## 1. What the audit found (Phase 0, recorded honestly)

The audit confirmed V12.1 had already implemented most of the target loop —
cloud computer tools, device policy with ALLOW/DENY/ASK_USER, the leased
queue, durable receipts, per-action observation/verification, and
WAITING_FOR_USER. The genuine defects and missing pieces were:

1. **Dead experience system (bug).** `runtime.js` called `worldState(...)`
   but never imported it. The ReferenceError was swallowed by a best-effort
   try/catch, so learned-experience hints never influenced any mission. One
   line fixed; the system it enables was already built and tested.
2. **A receipt written too late (P3 bug).** `agent/main.js` wrote the durable
   receipt *after* `transport.complete()` succeeded. The dangerous window —
   "the effect happened on the PC but the report never landed" (crash or
   network loss inside `complete`) — left **no receipt**, so the redelivered
   action executed the state-changing operation a second time. The receipt is
   now written immediately after execution, before reporting. This is the
   exact scenario P3 exists to prevent.
3. **Platform-blind tests.** 11 executor/live tests failed on Linux because
   they passed POSIX temp paths into functions whose contract is Windows-canonical
   paths. The implementation was *correct*; the tests were not platform-aware.
4. **Offline devices were handled by waiting.** A mission action aimed at a
   provably-dark computer was queued anyway, then burned the 45s wait per
   attempt against a device that could not answer.
5. **Device verifications stopped at the queue record.** A mission could end
   `completed` even when a promised file effect was never observed, because
   the queue's verification lived only inside the tool-result text.
6. **Planning was device-blind.** The planner never learned which folders
   were authorised, which commands were approved, or whether the computer was
   online — so plans could commit to work the target could not do.
7. **No per-device queue cap, sparse attribution in the trace, no CI.**

---

## 2. What was built

### P1 — device-aware missions and planning

* `createJob` accepts `requiredCapabilities` (validated against the desktop
  capability catalog, ≤8) and stores them on the mission.
* New pure `missingRequirements(device, capabilities)` in
  `netlify/lib/devices/dispatch.js` turns capability needs into exact gaps:
  `fs.write` needs *a folder authorised for reading AND writing*; `dev.run`
  needs *an approved development command*; a revoked device needs re-pairing.
  Creation refuses a mission whose target cannot satisfy it — **naming the
  exact missing requirement** instead of pretending the task can complete.
* `deviceContextSummary()` gives the planner a bounded, server-derived view
  of the target (presence, authorised folders, approved commands, the
  `local_pc`/`sandbox` distinction). It is the *only* discovery the planner
  gets — nothing scans the machine. `runtime.runJob` builds it once per run
  and `planning.analyzeAndPlan` weaves it into the plan prompt.

### P6 — offline devices: fast fail, park, resume

* `requestDeviceAction({requireOnline: true})` returns a structured
  `status: 'offline'` **before** policy or queue when the device has not been
  seen inside the staleness window (raised to 120s, exactly two agent
  heartbeat-touch windows so a healthy agent never flaps). Nothing is
  enqueued — there is nothing to retry wastefully.
* The mission-side tool layer converts `offline` into the standard
  `awaiting_user_decision` flow: the mission parks in `WAITING_FOR_USER` with
  an explanation and two options ("keep waiting" / "stop the mission").
  Each park gets a fresh deterministic decision id, so every answer is
  distinct and auditable; a recorded **stop** ends the mission honestly.
* Answering a decision now resets the worker *attempt* counter (that counter
  guards crash-loops, not user pauses) while time and cost budgets are
  preserved — a mission may park and resume as many times as the user needs.
* The queue gained a per-device outstanding cap (`MAX_OUTSTANDING_PER_DEVICE`
  = 25), closing the "no queue depth limit per device" gap.

### P4 — device verification reaches the mission verdict

* `environment.verifyDeviceObservations()` folds the queue's per-action
  verifications into the same record shape as the sandbox VFS verification:
  method `device-observation`, checked/matched/missing, and
  `independentlyProven` only when every promised effect was confirmed by the
  computer's own report.
* `agent.js` collects the verification of every `computer_*` tool result;
  `runtime.js` merges sandbox and device records via
  `mergeEnvironmentVerifications` (now mix-aware: `mixed-observation`,
  `deviceIds`). A promised effect the device never confirmed makes the
  mission end **`partial`** with the missing effect named — never `completed`.
* Read-only actions promise no effect and are labelled `unverifiable`, so
  they can never inflate the verdict.

### P8 — attributable observability

* Trace entries may now carry `deviceId`, `actionId` and `capability`
  (bounded like every field; ids only, never payloads), so the trace answers
  *"Samvit is doing X on device Y because mission Z requires it."*
* The safety audit trail records the device a decision applied to.
* The Computers page shows online/offline/never-connected badges, and a
  **Recent actions** panel with each action's outcome — VERIFIED / UNVERIFIED
  (with reason) / FAILED / NO RESPONSE — plus its mission link.

### P7 — platform-aware testing and CI

* `agent/executor.js` gained a narrow, explicit seam: an injectable **host
  path bridge** ({toHostPath, fromHostPath}, default `nativeHost` ≈ identity).
  All containment decisions are still computed on Windows-canonical paths via
  `shared/desktop.js`, which is **byte-for-byte unchanged**. The bridge only
  changes where bytes land when a syscall happens.
* `tests/helpers/device-host.js`: on **Windows** the executor and live tests
  run on the native path — real temp directories, real junctions, the genuine
  end-to-end pipeline. **Elsewhere** a POSIX bridge maps synthetic drive
  letters (`C:\`, `Z:\`) onto one temp folder, so the full pipeline
  (canonicalise → scope check → realpath → re-check → command floor) is
  exercised unchanged on every platform.
* `.github/workflows/tests.yml`: a required matrix that runs the **identical
  suite on `windows-latest` and `ubuntu-latest`** plus `npm run build`. A
  failure on either platform is a real failure.

---

## 3. Proof, not compilation

`tests/device-mission-v13.test.js` (11 tests) proves the composite the system
exists for. Highlights:

* **LIVE MISSION** — a real HTTP server hosts the real
  `/api/device-agent`; a mission is created with
  `requiredCapabilities`; the mission runtime plans, dispatches through the
  policy engine and queue; the **real agent daemon loop** (`runOnce` + real
  transport + real executor + durable receipts) polls over HTTP and performs
  `mkdir` then `write` then `read` on a real directory; the test asserts the
  file exists on disk with the exact content, every queue action is verified
  and attributable to the mission, the environment verdict is `verified` and
  independently proven, and the trace carries device/action/capability ids.
* **Offline park → resume** — a mission targeting a never-connected device
  parks in `WAITING_FOR_USER` with nothing queued; bringing the device online
  and answering resumes from the checkpoint and completes with real effects
  verified. **Offline stop** — the mission ends `failed` with the reason
  recorded and no fabricated output.
* **Unobserved effect** — an action that "completes" but whose promised file
  was never observed ends the mission `partial`, with the missing effect
  named in the verdict and trace.
* **Crash between effect and report** — the effect runs once; the report
  crashes; the action is redelivered; the durable receipt replays instead of
  re-executing; the queue records exactly one verified completion.
* **Requirements** — `missingRequirements` unit coverage plus `createJob`
  refusing unsatisfiable missions with the exact gap; the planner receiving
  the device note.
* **Caps and attribution** — per-device queue cap; trace attribution fields.

Combined with the pre-existing suites (pairing, replay protection, scope
containment, junction escape, command floor, kill switches, decisions,
leases, retries, receipts), every item in the mission brief's test list is
covered.

---

## 4. Platform statement (explicit, per the brief)

The Windows path-security implementation is intentionally Windows-specific
and was **not** weakened. `shared/desktop.js` received zero changes in this
increment (it is also unchanged in behaviour since V12). The executor tests
run natively on Windows in CI; the POSIX bridge used elsewhere performs only
the final syscall-path mapping and still runs every containment rule. Known
limitation: the POSIX bridge is a *test harness* — production agents are
still expected to run on Windows, because scopes are Windows-canonical paths.

## 5. Remaining gaps (still honest)

* **No Netlify-deployed test.** The live proofs run against the real handlers
  over real HTTP locally, with a fake blob store standing in for Netlify
  Blobs.
* **One agent session per computer.** Two agents on one machine would share
  a session; scaling limit, not a security issue.
* **Model-driven device missions remain stub-driven in tests** (`runAgent` is
  replaced so no model API is required in CI). The real planner/agent path is
  identical code, but it is not exercised with a live model in tests.
* **Browser/screen/application adapters remain declared-only**, deliberately.
* **Recovery is user-driven.** A parked mission resumes when the user answers
  or the dispatcher re-runs it; there is still no always-on worker.
