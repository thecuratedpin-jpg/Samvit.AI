# V9 architecture audit and implementation map

The V8 source is the baseline; existing chat, Council, sequential teams, goals, account and payment APIs remain compatible. No visual redesign is part of this upgrade.

| Boundary | V8 implementation | V9 direction |
| --- | --- | --- |
| Browser | Plain ES modules, hash routes, SSE chat; appearance remains local | Add one automatic mission entry point and durable progress |
| Providers | Four direct adapters; 15 connection choices; encrypted keys; priority/round-robin routing | Add native tool-call wire adapters without changing existing streaming contracts |
| Routing | Catalog/price preference and keyword classifier | Cheap exact calculations; model-generated specification and DAG for other work |
| Teams/Council | Sequential handoff and request-scoped critique | Bounded DAG strategies, independent work, verification and synthesis |
| Goals | Stored records and linear workflow | Separate durable orchestration jobs; preserve old goal records |
| Memory | Per-account indexed records; lexical ranking | Project-scoped retrieval, recency/importance and optional local semantic adapter |
| Tools | Plugin registry plus fetch URL | Schema-validated registry, explicit grants, pinned public DNS and bounded bodies |
| Auth | Verified mailbox, versioned sessions, first-owner claim | Revalidate identity/version for background work and tool access |
| Budget | CAS reservations before provider dispatch, conservative unknown usage | Preserve monthly ledger; add per-job cumulative cost/step/tool/time caps |
| Billing | Test-only Stripe, ownership binding, refunds/disputes holds | Preserve all gates; no live payment activation |
| Persistence | Netlify Blobs, conditional writes, account prefixes | Fenced job leases/checkpoints and account-scoped resources |
| Tests | 140 unit/integration tests, fake service responses | Preserve suite; add graph, tool, native adapter, job and security tests |

Audit findings: the existing orchestrator.js is a usage/health recorder, not an agent runtime. Legacy router.js is heuristic; team-runner.js truthfully has no tools. Existing memory has no embeddings. Some historical comments predate account isolation. The old fetch plugin validates host strings but does not pin public DNS and reads unbounded response bodies. Some legacy CRUD/plugin routes have inconsistent mutation-origin/rate handling. Blobs listing and indexes limit scale; independent records are not database transactions. Billing, email and verifier tests do not establish real external-service readiness.

Implementation boundaries: new modules live under netlify/lib/intelligence; provider response formats remain at the adapter boundary. Plans cannot grant permissions, choose arbitrary network endpoints or execute shell commands. External text is data and cannot grant authority. Hidden model reasoning is neither requested nor exposed. Traces record operational metadata, outputs and short verification summaries.

Scheduled dispatch plus authenticated background workers decouple jobs from browser lifetime. A job has a bounded lifetime and fenced state writes. Interrupted work is retried only within explicit attempt/cost limits; uncertain model costs remain charged. The browser polls durable state and displays completion, pause, cancel and partial failure.
