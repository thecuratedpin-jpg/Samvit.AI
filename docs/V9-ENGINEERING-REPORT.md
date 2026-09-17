# Samvit V9 engineering report

This release completes the local source integration and validation of the V9 orchestration foundation. It is not a claim of unrestricted autonomy or production certification. Live deployment, credentials and service validation remain operator tasks.

## Preserved infrastructure

V8 already had account isolation, verified-mailbox authentication, encrypted personal provider connections, streaming chat, sequential teams, fallback combos, monthly allowance reservations, student-verification integration, Stripe test-mode reconciliation and deletion handling. These remain intact. No live-payment gate was removed and no provider key is included in the archive.

## Architecture and capabilities

Ask Samvit is the default workspace. A narrow deterministic classifier handles obvious tasks; ambiguous tasks use a model analyzer and schema-validated planner. The planner produces an acyclic graph with a single terminal result, authorized tools and verification requirements. The runtime dispatches independent nodes within plan concurrency limits, checkpoints results, supports partial completion and permits one bounded replan. Users can pause, resume or cancel saved missions.

Native tool calling supports OpenAI-compatible, Anthropic and Gemini wire formats. The server validates tool arguments, grants and confirmations, limits loops and reuses existing monthly metering. Provider health, estimated cost, context limits and catalog capabilities inform selection. Configured credentials are not treated as proof of model access. Independent strategy branches prefer different available targets; model diversity is not guaranteed when only one eligible target exists.

Implemented tools: finite arithmetic, public HTTPS fetching, configured Brave search, attached text-file reading/search, project-scoped memory retrieval, and private text/Markdown/CSV/slide-outline artifacts. Embedding retrieval uses explicitly authorized OpenAI embeddings when configured; otherwise retrieval is lexical. Text resources and job records are account scoped and included in account deletion.

Jobs use Netlify Blobs conditional writes, expiring worker leases and authenticated background functions. A scheduled dispatcher retries queued/stale work. Browser polling shows durable progress and completion notices. Existing chat streaming remains; mission output is checkpointed rather than token streamed.

Verification checks claims against actually retrieved source URLs, marks conflicts and missing freshness evidence, and never equates model agreement with proof. Exact arithmetic is deterministic. Model factual review remains fallible.

## Security and budgets

- Tool permission decisions are server controlled; external text is labeled untrusted. No shell, arbitrary filesystem access, publishing, messaging or financial-action tool is registered.
- HTTPS fetching rejects private/reserved destinations, resolves and pins public IPv4 addresses, refuses redirects, caps response size and time, and restricts agent URLs to user-provided or actual search-result URLs.
- CSV export parses quoted fields before escaping formula prefixes. Rendered mission content is escaped, including model output and errors.
- Worker tokens are short-lived and audience bound. Job ownership, session invalidation, project boundaries, cancellation and lease ownership are checked before work.
- Mission limits and monthly allowance are separately enforced. Mission estimates conservatively retain reservations, including failures; monthly metering settles reported usage when available. This is not an exact provider invoice. Positive operator cost estimates are required for search and embeddings.
- External search queries and authorized context still reach chosen service providers. These controls reduce prompt-injection impact; they do not prove complete resistance to all adversarial content.

## Local validation

- Clean dependency installation with `npm ci --ignore-scripts` succeeded. Install hooks were intentionally not executed.
- Full suite: **173 tests passed, zero failed**. This includes the existing 140 tests and 33 new orchestration/release tests.
- Production build: **104 server/shared modules checked, zero errors**, plus browser JavaScript syntax and static asset checks.
- New browser scenario exercises the real frontend with API fixtures: default assistant, mission creation, pause/resume/cancel, escaped HTML-like output, mobile overflow and legacy navigation.
- Tests exercise four native adapter formats, malformed calls, safety rejection, tool timeouts, budget contention, stale-worker fencing, partial failures, scoped memory, account boundaries, fresh-information requirements and ten simultaneous account jobs.
- All external provider, storage and billing responses in automated tests are controlled fixtures. No real model access or deployed Netlify worker was certified. The repo has no separate TypeScript or lint configuration; syntax/import checks are not a static type-check claim.
- Machine-readable audit output and validation logs are in `qa/`. The initial production audit reported zero known vulnerabilities. The final production-only audit request returned HTTP 403 from the registry; the successful final full audit lists only packages marked development-only in the final lockfile. Both results are retained. After compatible dependency fixes, five high advisories remain in Netlify's development image-tool chain (`sharp`, `ipx`, `@netlify/images`, `@netlify/dev`, `netlify-cli`). The suggested forced remediation downgrades the CLI to 23.13.5 across major versions and was not applied. This is an explicit remaining development-tool dependency risk, not a clean full audit.

## Configuration and operational limits

Preserve existing secrets and account data. Set `SAMVIT_PUBLIC_ORIGIN` to the deployed root HTTPS origin. Netlify background and scheduled functions must be enabled. Configure `BRAVE_SEARCH_API_KEY` and a positive `SAMVIT_SEARCH_COST_USD` for live search. Optional semantic retrieval requires `OPENAI_API_KEY`, `SAMVIT_SEMANTIC_MEMORY=true`, a positive `SAMVIT_EMBEDDING_USD_PER_MILLION` and per-mission user permission.

Free/Pro/Ultra/Ultimate allow 1/2/3/4 parallel nodes, respectively. Jobs have at most 4 free or 8 paid nodes, 4 agent steps per node, 3 worker attempts and 3 minutes of cumulative active time. The default UI spend cap is $0.03; users may raise it within their plan cap. Each account can store 50 text resources of up to 20,000 characters. Up to 8 resources can be attached to one mission. Memory retrieval considers up to 100 project memories; embeddings are recomputed rather than indexed persistently.

The dispatcher scans at most 1,000 job records and dispatches up to 3 jobs per scheduled run; mission history lists at most 100 records. This bounded implementation is for small deployments, not a high-volume queue. Monitor queued-job age and retained history. Worker recovery resumes at task checkpoints; interrupted native tool conversation state is not persisted. In-app completion notices are implemented; email/push completion notifications are not.

## Remaining limitations and next phase

Safe code execution, generated images, binary DOCX/XLSX/PPTX exports, publishing and external account actions are extension categories only. Slide artifacts are text outlines; CSV is a text spreadsheet exchange format. The system does not automatically write long-term memories. Freshness detection includes heuristics and model analysis; neither is infallible. Prices without live feeds remain labeled static estimates.

Before production, validate real provider tool access and rates, deployed background/scheduled execution, recovery after shutdown, Resend, SheerID, Stripe test flows, data backup and deletion. Keep real billing disabled until those operational gates are satisfied. The next engineering phase should replace bounded scans with an indexed queue, introduce persistent vector retrieval and add isolated executors and artifact renderers with separate permission and billing tests. Visual redesign remains outside this engineering phase.

## Changed files

See `V9-FILES-CHANGED.txt` for the exact source comparison with V8. Principal additions are `netlify/lib/intelligence/`, the orchestration/background/dispatcher/resource functions, `src/intelligence.js`, `src/intelligence.css`, three V9 test files and the V9 browser scenario. Main integration changes cover navigation, deletion-store inventory, legacy URL fetching, plugin request protection, dependency locks and configuration documentation.

## Protocol references

- [OpenAI function calling](https://developers.openai.com/api/docs/guides/function-calling)
- [Anthropic tools](https://platform.claude.com/docs/en/agents-and-tools/tool-use/define-tools)
- [Gemini function calling](https://ai.google.dev/gemini-api/docs/function-calling)
- [Netlify background functions](https://docs.netlify.com/build/functions/background-functions/)
- [Brave search API](https://api-dashboard.search.brave.com/app/documentation/web-search/get-started)
- [OpenAI embeddings](https://developers.openai.com/api/reference/resources/embeddings/methods/create)
