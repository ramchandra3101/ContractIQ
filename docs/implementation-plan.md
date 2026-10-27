# ContractIQ implementation plan

Updated: 2026-10-26. This is the canonical delivery checklist for the project. Update this document as work lands; README remains the quick-start guide.

## 1. Current position

**Milestone 1 is complete: the foundation is implemented, unit-tested and verified against real infrastructure (2026-10-26).** M2 is next. Milestones 2 through 6 are planned. The application cannot yet upload or process contracts.

On 2026-10-26 the target stack changed (section 3): Anthropic SDK replaces OpenAI, LlamaParse replaces PDF.js/Tesseract parsing, DuckDB is added as the analytics store, Arize (Phoenix locally) provides LLM tracing, and Cloud Run is the deployment target. The M1 operational stack (PostgreSQL, Redis/BullMQ, S3-compatible storage) is kept; MinIO was replaced by RustFS because its images left Docker Hub.

| Milestone | Status | Deliverable |
| --- | --- | --- |
| 1. Foundation | Complete; verified 2026-10-26 | Workspace, API, database schema, Compose, health checks |
| 2. Durable ingestion | Not started | Validated upload, storage, outbox, queue, job lifecycle, ownership |
| 3. Parsing arms | Not started | LlamaParse tiers and Claude native PDF behind one parser contract, parse cache, cost metering |
| 4. Grounded extraction | Not started | Mock/Anthropic providers, Zod structured outputs, evidence verification, Arize tracing |
| 5. Evaluation and analytics | Not started | Official CUAD preparation, DuckDB analytics store, per-field precision/recall, parser cost/quality comparison |
| 6. Cloud Run and hardening | Not started | GCP deployment, retention, security and recovery checks |

Verified 2026-10-26 in a local Docker Sandbox (`sbx`, Docker 29.9.2, Compose v5.6.1): image build, Compose startup, migrations, readiness, dependency failure, persistence and rate-limit checks (16/16 passing), plus `pnpm build`, `pnpm lint` and 21 passing Vitest tests on Node 24.22.1. The development laptop has no Docker; use `sbx` (section 14). CI success on GitHub has not been observed yet.

Current `LLM_PROVIDER=mock` is configuration only. MockProvider itself does not exist yet. Current `pnpm eval` intentionally fails with a not-implemented message. Retention and PDF limits are configuration only.

## 2. Product objective and what the project must prove

Take messy contract PDFs in, return clean structured JSON records with verifiable evidence, and measure quality and cost from day one against labelled data (CUAD).

The finished project must answer, with measured numbers:

1. **Which documents were chosen** and why (eligible set, exclusions, scanned vs native mix).
2. **Parser performance against cost**: OCR-style vs multimodal parsing, quality per dollar per page.
3. **Which categories the model handled well and which it did not**: precision and recall per field, broken down by field type.
4. **How schema validation was handled**: schema validity rate, rejection reasons, retries, and evidence verification failures.

Initial extraction categories:

| Category | CUAD field type | Why it is in the first five |
| --- | --- | --- |
| Governing Law | Short value (jurisdiction) | Near-universal, easy baseline |
| Termination for Convenience | Clause span | Common, phrasing varies |
| Exclusivity | Clause span | Often absent, tests no-answer handling |
| Non-Compete | Clause span | Confusable with Exclusivity |
| Change of Control | Clause span | Rare, long clauses, cross-page |

CUAD field types to report separately: clause spans, short values (parties, dates, jurisdictions), and yes/no style categories. Design the category registry and schemas for all 41 CUAD categories; adding the rest is tracked expansion after the first five are benchmarked.

Main application, workers, data preparation and evaluation use Node.js and strict TypeScript. A frontend is out of scope; the MVP is a REST API.

Reference: [Project 1: Document intelligence pipeline](https://github.com/aishwaryanr/awesome-generative-ai-guide/blob/main/youtube/ai-engineer-projects.md). The brief lists LlamaIndex/OpenAI/Anthropic SDKs, LlamaParse or Docling, OpenAI Structured Outputs, Pydantic, DuckDB, FastAPI, Docker with Cloud Run, and Arize. This project substitutes Anthropic structured outputs, Zod and Fastify for the OpenAI/Pydantic/FastAPI items.

## 3. Stack and ownership

| Technology | Responsibility | Delivery |
| --- | --- | --- |
| Node.js 24 LTS, strict TypeScript, pnpm | Runtime, typing, workspaces | M1 |
| Fastify, Zod, Pino | REST API, boundary/config/LLM-output validation, safe logs | M1, expanded each milestone |
| Prisma, PostgreSQL | Durable source of truth for documents, jobs, results, invocations | M1 schema, M2 lifecycle |
| Redis, BullMQ | Dispatch, bounded concurrency, retries | M2 |
| RustFS locally (replaced MinIO), GCS in production (S3 interoperability API) | Original PDFs, cached parser output | M2 |
| PDF.js | Local structural validation and page counting only (not a parser arm) | M2 |
| LlamaParse (`@llamaindex/llama-cloud`) | OCR-style and agentic parsing arms | M3 |
| Anthropic SDK (`@anthropic-ai/sdk`) | Multimodal PDF arm, structured extraction (`messages.parse` + `zodOutputFormat`), Batches API for evaluation runs | M3, M4, M5 |
| DuckDB (`@duckdb/node-api`) | Analytics store for evaluation runs, per-field metrics, cost and latency analysis | M5 |
| Arize Phoenix locally, Arize AX optional in production (OpenInference over OpenTelemetry) | LLM and parser call tracing, eval run inspection | M4 tracing, M6 production export |
| Vitest | Unit, integration, security, evaluation tests | Every milestone |
| Docker Compose, GitHub Actions, Cloud Run | Local services, CI, deployment | M1 local, M6 Cloud Run |

Package versions observed on npm on 2026-10-26: `@anthropic-ai/sdk` 1.3.0, `@llamaindex/llama-cloud` 2.19.0, `@duckdb/node-api` 2.0.0-r.1 (pre-release tag; pin exactly), `@arizeai/openinference-instrumentation-anthropic` 1.0.0, `@arizeai/phoenix-otel` 2.3.0. Re-check when each lands. Do not add a dependency until its working integration and tests land.

Storage roles, stated once so they do not blur:

| Store | Owns | Does not own |
| --- | --- | --- |
| PostgreSQL | Operational truth: documents, jobs, page artifacts, fields, invocations, outbox | Ad hoc analytics over thousands of eval rows |
| DuckDB | Analytics: eval runs, per-field metrics, cost/latency joins, report queries | Live job state (single writer, local file) |
| Redis | Delivery only; losing it must not lose work | Any durable state |
| RustFS / GCS | Binaries: original PDFs, raw parser responses | Metadata |

Example: an eval run writes per-document predictions to Postgres through the normal pipeline, then `pnpm eval` exports them with gold labels to Parquet and loads them into `reports/<run-id>/analytics.duckdb`. A query like "recall by category for `agentic` vs `fast` tier" runs in DuckDB without touching the production database.

## 4. Target workflow and boundaries

1. Authenticate the caller and resolve a trusted owner ID.
2. Receive a bounded PDF upload with an idempotency key.
3. Validate signature, structure, encryption policy, byte count and page count locally (PDF.js, isolated, bounded).
4. Store the original under an immutable, server-generated object key.
5. Commit Document, ProcessingJob and OutboxEvent together in PostgreSQL.
6. Publish the outbox event to BullMQ using a stable job ID; reconcile interruptions.
7. Worker claims the processing version and selects the parser arm from the job's config snapshot.
8. The parser arm produces normalized per-page text with provenance, or (Claude PDF arm) the PDF is passed directly to extraction.
9. Deterministic candidate retrieval creates bounded, overlapping extraction windows.
10. MockProvider or AnthropicProvider returns Zod-validated category results.
11. Evidence verification checks quotations and pages against a reference text.
12. Persist results, usage and cost, then transition the processing version to a terminal state.
13. Return owned document status, pages and results through REST endpoints.
14. Run reproducible evaluation on a contract-disjoint benchmark; load results into DuckDB; export reports.

PostgreSQL owns durable state. A database transaction cannot atomically include S3, Redis, LlamaParse or Anthropic calls, so compensation, reconciliation and idempotent external calls are required.

Example: the dispatcher publishes job J and crashes before marking its outbox event published. It may publish J again. Stable queue IDs plus a database claim/fencing mechanism must prevent two workers from committing the same processing version, and the parse cache (section 9) prevents paying LlamaParse twice for the same file.

## 5. API contract to implement

All `/api/v1/*` routes require authentication. Every document/job lookup includes the authenticated owner constraint. Return 404 for inaccessible resources. Never accept a client-supplied owner ID as authority.

| Endpoint | Planned behavior | Milestone |
| --- | --- | --- |
| `POST /api/v1/documents` | Multipart PDF plus required `Idempotency-Key`, optional `parser` arm; 202 with document/job IDs | M2 |
| `GET /api/v1/documents/:id` | Owned metadata, current version, status, latest job | M2 |
| `GET /api/v1/documents/:id/result` | Versioned extraction JSON: category instances, state, evidence, verification outcome | Contract in M2, populated in M4 |
| `GET /api/v1/documents/:id/pages` | Paginated page artifacts, parser arm, warnings | Contract in M2, populated in M3 |
| `POST /api/v1/documents/:id/reprocess` | Idempotently create a new processing version, optionally with a different parser arm | M2 |
| `GET /api/v1/jobs/:id` | Owned job status, attempts, timestamps, safe failure code, cost | M2 |
| `GET /health/live` | Process liveness | M1 implemented |
| `GET /health/ready` | Bounded PostgreSQL, Redis and bucket checks | M1 implemented |

Freeze request/response Zod schemas and tests before implementing M2 routes. Result semantics: 202 while processing, 200 for a completed result, 409 with a safe error code for a failed version. Never return an empty successful extraction for unfinished work.

Upload replay: same owner/key/checksum returns the original resource; same owner/key with different content returns 409. Reprocessing has its own idempotency scope. Reject reprocess while another version of the same document is active.

Error envelope: `{ "error": { "code": "...", "message": "...", "requestId": "..." } }`. Document 400, 401, 404, 409, 413, 415, 422, 429 and 503. Known M1 gap to fix in M2: the error handler maps every thrown 4xx other than 413/429 to `BAD_REQUEST`; 404, 409, 415 and 422 need their own codes.

## 6. Database and state invariants

| Model | Required durable information |
| --- | --- |
| Document | Owner, upload idempotency key, checksum, immutable object key, size/pages, current version, retention deadline |
| ProcessingJob | Document/version, pipeline/config snapshot (including parser arm and model), status transitions, attempts, heartbeat, timestamps, failure code |
| PageArtifact | Job/page, parser arm/tier/version, normalized text, warnings, duration, parser cost |
| ExtractedField | Job/category/instance, present/absent/unknown/error state, value, evidence and verification outcome |
| ModelInvocation | Provider/model, prompt/schema/pricing version, usage (including cache read/write tokens), estimated cost, duration, invocation identity/status |
| OutboxEvent | Job/type, payload, publication status, attempts, availability and expiring lease |

M2 must add worker lease/fencing fields and reprocessing idempotency. M3 must add a parse-cache table keyed by `(checksum, parser, tier, parserVersion)` pointing to a stored raw response, plus parser cost on PageArtifact. M4 must make `ModelInvocation.invocationKey` include the attempt number, because the current `(jobId, invocationKey)` unique constraint would otherwise collapse paid retries into one row.

Job transitions: `PENDING -> QUEUED -> RUNNING -> SUCCEEDED`, retryable attempts return to a dispatchable state, exhausted/permanent failures move to `FAILED`. Updates are conditional and never downgrade RUNNING or SUCCEEDED.

Example: an old worker loses its lease, then returns after another worker finishes. Its stale fencing token prevents it from overwriting newer artifacts or terminal state. Paid attempts from both workers remain recorded in ModelInvocation.

## 7. Milestone 1: foundation

Implemented:

- [x] pnpm workspace and strict TypeScript configuration.
- [x] Fastify API, Pino logging, validated Zod configuration.
- [x] Bearer-token to owner mapping, consistent errors and per-process rate limiting.
- [x] Public liveness and bounded dependency readiness probes.
- [x] Prisma models, initial migration SQL and client package.
- [x] PostgreSQL, Redis, S3-compatible storage, bucket initialization and API Compose definitions.
- [x] Non-root API container settings and graceful shutdown.
- [x] README, environment example and CI workflow.
- [x] Historical build/lint/schema checks and 18 passing unit tests.
- [x] Provider configuration switched from OpenAI to Anthropic (`LLM_PROVIDER=mock|anthropic`).

Close-out before advancing:

- [x] Docker image build and Compose startup (`docker compose --profile app up -d --build`).
- [x] Migration applied to a clean database; second `migrate deploy` reports no pending migrations; 7 tables present.
- [x] Readiness 200 with real dependencies; stopping postgres, redis or storage each returns 503 with only that dependency false, and recovers to 200.
- [x] A Postgres row, a Redis key (AOF) and a stored object survive `docker compose down` / `up` with volumes kept.
- [x] Rate limiting fixed and tested. The bug was real: with `global: true`, `@fastify/rate-limit` adds route-level hooks that run after the app-level auth hook, so 130 bad-token requests in one minute all returned 401 and none returned 429. The limiter is now an app-level `onRequest` hook registered before auth; live check returned 429 after 120 requests. Two Vitest tests fail on the old code and pass on the fix.
- [x] MinIO replaced by RustFS `1.0.3` plus `amazon/aws-cli` bucket init: `minio/minio` and `minio/mc` no longer exist on Docker Hub, so the previous Compose file and CI could not start.
- [x] API container runs as UID 1000 with a read-only root filesystem.
- [ ] Observe a green GitHub Actions run (CI pulls the same images).

Acceptance: a clean checkout can follow README and reach healthy infrastructure with no paid API key.

## 8. Milestone 2: durable ingestion and job lifecycle

- [ ] Define API schemas, upload/reprocess idempotency semantics and ownership-scoped repositories.
- [ ] Streaming multipart upload limits, bounded temporary files and SHA-256 checksums.
- [ ] Isolated PDF.js structural validation with timeout/memory limits, page cap and explicit encrypted/malformed PDF rejection.
- [ ] Store immutable originals using server-generated keys; clean temporary files on every exit path.
- [ ] Transactionally create document, version 1 job and outbox event after successful object storage.
- [ ] Handle concurrent idempotency races and checksum conflicts.
- [ ] Leased outbox publication, bounded batches, backoff, stable BullMQ job IDs, safe shutdown.
- [ ] Worker process with database claims, heartbeats, fencing, whole-job timeout and BullMQ retries.
- [ ] Reconcile unpublished events, missing queue entries, stale running jobs and exhausted failures.
- [ ] Orphan-object cleanup with a grace period.
- [ ] All document/job routes, including explicit pending result/page responses.
- [ ] Versioned, idempotent reprocessing that preserves previous completed versions.
- [ ] Integration tests and curl examples.

Acceptance tests:

- [ ] Upload a native seed PDF; the original object exists, rows commit, a real worker receives the job.
- [ ] Duplicate/concurrent requests return one document/job; conflicting content returns 409.
- [ ] Owner B cannot read, list, or reprocess owner A's document, or read its job.
- [ ] Oversized, renamed non-PDF, malformed, encrypted and excessive-page inputs fail safely.
- [ ] Kill the dispatcher before/after queue publication; restart and observe recovery without duplicate work.
- [ ] Redis outage leaves durable work recoverable; storage/database failures leave no falsely accepted job.

Workers at this milestone perform validation only and must not mark extraction complete.

## 9. Milestone 3: parser arms

The brief's central trade-off is OCR-style vs multimodal parsing. Each arm implements one contract so evaluation can swap them with everything downstream held constant.

```ts
interface DocumentParser {
  readonly arm: ParserArm;
  parse(input: ParseInput): Promise<ParseResult>;
}
```

| Arm | Implementation | Class | LlamaParse list price (2026-10-26) |
| --- | --- | --- | --- |
| `llamaparse-fast` | LlamaParse tier `fast` ("runs no AI model over the page") | OCR-style | 1 credit/page = $0.00125 |
| `llamaparse-cost-effective` | LlamaParse tier `cost_effective` | Model-assisted | 3 credits/page = $0.00375 |
| `llamaparse-agentic` | LlamaParse tier `agentic` | Model-assisted | 10 credits/page = $0.0125 |
| `llamaparse-agentic-plus` | LlamaParse tier `agentic_plus` | Model-assisted | 45 credits/page = $0.05625 |
| `claude-pdf` | No separate parser: the PDF goes to Claude as a `document` block (text plus page images) | Multimodal | Anthropic token pricing; measure per page with `messages.countTokens` |

Prices come from the LlamaParse pricing page ($1.25 per 1,000 credits). LlamaParse docs do not say which model family each paid tier uses, so the report labels them by tier, not as "VLM". Re-check prices before each benchmark run and store the pricing version with the results.

Tasks:

- [ ] Define ParseInput/ParseResult: page numbers, normalized markdown/text per page, warnings, duration, billed units (pages or tokens), parser tier and pinned version.
- [ ] Implement `LlamaParseParser` with `client.files.create({ purpose: 'parse' })` then `client.parsing.parse({ file_id, tier, version, expand: ['markdown'] })`, reading `result.markdown.pages[i].markdown`. Pin a dated `version` (docs: `latest` is for development; arbitrary dates are rejected).
- [ ] Parse cache: key `(checksum, arm, version)`, store the raw response in object storage, never call LlamaParse twice for the same key. LlamaParse also caches re-parses for 48 hours at zero credits, but this project does not rely on that.
- [ ] Per-run page budget and spend guard: refuse to start a run whose estimated pages x price exceeds the configured cap.
- [ ] Handle LlamaParse `RateLimitError` (429) and timeouts with bounded retries; `client.parsing.parse()` polls internally and has a longer default timeout than single calls.
- [ ] Implement `ClaudePdfParser` contract for the multimodal arm. Anthropic PDF limits: 32 MB per request, 600 pages per request (100 for 200K-context models). Larger contracts are split into page ranges with overlap.
- [ ] Data handling note in README: LlamaParse and Anthropic receive full contract content. CUAD is public; private contracts need a data-processing decision before use.
- [ ] Fixtures: native, scanned, mixed and rotated PDFs with known content.

Acceptance: the same input and arm produce identical cached output; each arm records billed units and cost per page; failures are recorded per page, not dropped.

## 10. Milestone 4: structured, evidence-backed extraction

- [ ] Define `LLMProvider`; implement deterministic `MockProvider` with fixtures.
- [ ] Implement `AnthropicProvider` with `client.messages.parse({ ..., output_config: { format: zodOutputFormat(schema) } })` from `@anthropic-ai/sdk/helpers/zod`. `parsed_output` is null when parsing fails; treat that as a schema failure, never as "absent".
- [ ] Default model `claude-opus-5-5` with `output_config.effort` set explicitly (its default is `medium`). Model and effort are configuration so M5 can compare cheaper models on the same eval.
- [ ] Handle `stop_reason` before reading output: `refusal`, `max_tokens` (truncated JSON) and `end_turn`. Use typed SDK errors (`Anthropic.RateLimitError`, `Anthropic.APIConnectionError`) for retry decisions.
- [ ] Prompt caching: stable system prompt and category instructions first, document text after the breakpoint; verify `usage.cache_read_input_tokens > 0` on repeated categories for the same document.
- [ ] Citations are not used: Anthropic returns 400 when citations are combined with `output_config.format`. Evidence is verified by our own code instead.
- [ ] CUAD category registry: initial five, extensible to all 41 labels, each tagged with its field type.
- [ ] Present, absent, unknown and error are distinct states; multiple instances per category.
- [ ] Deterministic candidate retrieval with bounded overlapping windows; never send an unbounded document in one prompt.
- [ ] Treat document text as untrusted data; the prompt says to ignore instructions inside it.
- [ ] Evidence verification: every quotation must match the reference text after documented normalization. Reference text is the parser output for LlamaParse arms and the CUAD-provided contract text (or `llamaparse-fast` output for uploads) for the `claude-pdf` arm.
- [ ] Record schema validation outcomes: valid, Zod-rejected (with issue paths), refused, truncated, retried. These feed the "how we handled schema validation" report.
- [ ] Persist usage and estimated cost per attempt, including uncertainty after interrupted requests.
- [ ] Arize tracing: `@arizeai/phoenix-otel` plus `@arizeai/openinference-instrumentation-anthropic`, with a Phoenix container in Compose. Spans carry job ID, arm, category and token counts; document text and prompts are excluded from production traces (allowed locally on CUAD only).
- [ ] End-to-end local processing with no paid key using MockProvider.

Example: a clause starts on page 4 and ends on page 5. An overlapping window includes both; the instance references both pages. A repeated prediction from the next window is deduplicated by verified source span, not by its generated summary.

Acceptance: fixture clauses return verified evidence; hallucinated quotes fail verification; failed analysis stays unknown or error. Mock results prove plumbing, not accuracy.

## 11. Milestone 5: CUAD evaluation and DuckDB analytics

Data preparation (TypeScript):

- [ ] Resolve CUAD from the official Atticus Project source; record URL, license, version and checksums.
- [ ] Download and unpack with size and path traversal limits; raw data stays outside Git (`data/`).
- [ ] Convert annotations to a canonical format: contract, category, field type, gold spans.
- [ ] Deterministic contract-disjoint train/dev/test manifests with duplicate-content checks.
- [ ] Tune prompts and retrieval on dev only; freeze before test.
- [ ] Align gold spans to each arm's parsed text; report alignment failures separately from model failures.
- [ ] Document selection: record the eligible set, the excluded set with reasons, and the native vs scanned mix. This answers "which documents you chose".

Metrics (per field, broken down by field type):

- [ ] Exact normalized span match and token-overlap match with documented tokenizer and threshold.
- [ ] One-to-one maximum matching per contract/category so duplicates cannot inflate recall.
- [ ] TP/FP/FN, precision, recall and F1 per category, per field type, micro and macro.
- [ ] No-answer accuracy, evidence support rate, schema validity rate.
- [ ] P50/P95 latency per stage, parser cost per page, LLM cost per document, total cost per document.

Example: one gold span and two identical predictions give one TP and one FP, not two TPs. Unknown predictions are reported as unknown and never count as correct no-answers.

Parser comparison:

- [ ] Run every arm on the same declared eligible contracts with the same extraction model, prompt and schema.
- [ ] Report the cost/quality frontier: F1 per category vs total cost per document, per arm.
- [ ] Use the Anthropic Batches API for eval extraction (50% of list price per the Anthropic docs; results arrive in any order, keyed by `custom_id`).
- [ ] Start with a dev subset small enough to fit the budget; scale only after the cost per document is measured.

DuckDB analytics:

- [ ] `packages/evaluation` writes predictions, gold labels, matches, invocations and parser costs as Parquet per run.
- [ ] Load into `reports/<run-id>/analytics.duckdb` with views: `field_metrics`, `field_type_metrics`, `arm_cost_quality`, `schema_outcomes`, `latency`.
- [ ] Optional: query operational Postgres directly through DuckDB's `postgres` extension instead of exporting (verify against the DuckDB version pinned at that time).
- [ ] Export JSON, CSV and Markdown reports generated by SQL over DuckDB; record git revision, dataset checksum, arm/model/prompt/schema/pricing versions and concurrency.
- [ ] Vitest metric tests with hand-calculated examples; replace the failing `pnpm eval` placeholder.

Acceptance: reports reproduce from manifests and configuration; no fabricated numbers; every arm that was not run is marked not run.

## 12. Milestone 6: Cloud Run deployment and hardening

GCP mapping for the kept M1 stack:

| Local | GCP | Note |
| --- | --- | --- |
| API container | Cloud Run service | Scales on requests |
| Worker + dispatcher | Cloud Run service with min instances 1 and CPU always allocated, or a Cloud Run worker pool | BullMQ workers poll Redis and cannot scale to zero |
| PostgreSQL | Cloud SQL for PostgreSQL | Connect through the Cloud SQL connector or private IP |
| Redis | Memorystore for Redis | Needs VPC access from Cloud Run |
| RustFS | GCS via the S3 interoperability API (HMAC keys) | Keeps the existing S3 client; verify `forcePathStyle` behavior |
| `pnpm eval` | Cloud Run job | Writes Parquet/DuckDB output to GCS |
| Phoenix | Arize AX, or self-hosted Phoenix | Export endpoint via configuration |
| Secrets | Secret Manager | Anthropic, LlamaParse, API keys |

- [ ] Separate migration image/job from the minimal runtime image.
- [ ] Terraform or documented `gcloud` commands for every resource above.
- [ ] OpenTelemetry spans across API, outbox, worker, parsing, extraction, verification, persistence; no document text in production telemetry.
- [ ] Metrics: queue lag, oldest pending event, retry/failure rate, parser arm usage, token usage, spend.
- [ ] Retention for originals, parse cache, derived artifacts and records; coordinate with active jobs.
- [ ] Distributed rate limiting, explicit proxy trust (Cloud Run fronts the service), key rotation.
- [ ] Adversarial PDF, decompression bomb, path traversal, ownership and concurrency tests.
- [ ] Runbooks: migration rollout, backup/restore, rollback, scaling, queue recovery.
- [ ] Measure idle and per-document GCP cost; record it next to the eval cost tables.

Acceptance: deployment and recovery runbooks have executable commands and recorded validation. Local development and CI work without paid keys.

## 13. Planned repository layout

```text
apps/api/                 REST transport and authentication (existing)
apps/worker/              BullMQ worker, dispatcher, reconciliation, retention
packages/core/            Shared configuration and domain contracts (existing)
packages/database/        Prisma schema, migrations, persistence (existing)
packages/storage/         S3/GCS operations and cleanup
packages/parsing/         PDF validation, parser arms, parse cache
packages/extraction/      Retrieval, providers, Zod schemas, evidence verification
packages/evaluation/      CUAD preparation, metrics, DuckDB analytics, reports
fixtures/                 Small authored PDFs and mock fixtures
scripts/                  Developer commands
docs/                     Plan, architecture, API and deployment documentation
```

## 14. Commands and verification cadence

| Command | Current behavior | Target behavior |
| --- | --- | --- |
| `pnpm dev` | API dev process | API plus worker/dispatcher |
| `pnpm build` | Prisma generate and compile | All packages |
| `pnpm test` | Foundation Vitest tests | Deterministic default suite, no paid keys |
| `pnpm lint` | ESLint and type checks | Same, extended |
| `pnpm db:migrate` | Apply migrations | Same |
| `pnpm eval` | Explicit not-implemented failure | CUAD runner writing DuckDB and reports |

Docker without Docker Desktop: the laptop uses Docker Sandboxes (`/opt/homebrew/bin/sbx`, v0.49.2). Sandbox `contractiq-m1` has its own Docker engine. Copy the working tree in (never bind-mount: Linux `pnpm install` would overwrite macOS `node_modules`), then run Compose inside it:

```sh
tar --exclude=node_modules --exclude=dist --exclude=.git --exclude=.env -czf /tmp/ciq.tgz .
sbx cp /tmp/ciq.tgz contractiq-m1:/tmp/ciq.tgz
sbx exec contractiq-m1 sh -c 'mkdir -p ~/contractiq && tar -xzf /tmp/ciq.tgz -C ~/contractiq && cd ~/contractiq && cp -n .env.example .env && docker compose --profile app up -d --build'
```

Sandbox notes: the global sbx network policy is `balanced`, which blocks plain HTTP, so `deb.debian.org:80` is allowed for this sandbox only (needed by `apt-get` in the Dockerfile). sbx stops idle sandboxes, and Compose services have no restart policy, so run `docker compose --profile app up -d` at the start of each `sbx exec`. Cloud sandboxes (`sbx --cloud`) need a Docker Agentic Platform subscription.

Tests needing Docker, and tests needing paid APIs (LlamaParse, Anthropic), are separate commands and never part of default CI.

For each milestone: implement a runnable slice, run build/lint/tests, execute its acceptance checks, update this document and README, and report actual command results.

## 15. Decisions and risks

| Issue | Resolution |
| --- | --- |
| Docker not available on the development machine | Run Docker workloads in a local `sbx` sandbox (section 14) |
| Local Node is 22.14.0, repo requires 24 | Install Node 24 locally; until then, Node 24 checks run in a `node:24-bookworm-slim` container in the sandbox |
| Partial writes across DB, queue, storage and paid APIs | M2 compensation, leases, fencing; M3 parse cache; M4 per-attempt invocation records |
| LlamaParse and Anthropic spend on 510 CUAD contracts | Page budget, cost guard, dev subset first, Batches API, parse cache |
| Contract text sent to third parties | Public CUAD only until a data-processing decision exists |
| Structured outputs cannot be combined with Anthropic citations | Own evidence verification against reference text |
| Gold annotations vs parsed text differ | Alignment step, failures reported separately |
| Cloud Run vs always-on BullMQ workers | Min instances 1 or worker pool; measure idle cost |
| DuckDB is single-writer and Cloud Run disk is ephemeral | DuckDB for analytics only, persisted as files in GCS per run |
| All 41 categories | Registry in M4; implement after the five-category baseline |

## 16. Next work and completion definition

Next: observe a green CI run, then M2 API contracts and ingestion.

The MVP is usable after M4: an authenticated user uploads a PDF, chooses a parser arm, polls the job and retrieves grounded JSON locally with MockProvider. The hiring-manager deliverable is complete after M5: a reproducible report showing document selection, the parser cost/quality frontier, per-field and per-field-type precision/recall, and schema validation outcomes.

Final release checklist:

- [ ] All eight endpoints behave as documented with ownership enforcement.
- [ ] Retries do not duplicate committed results or paid parser calls.
- [ ] Every parser arm produces traceable page references through extraction.
- [ ] Five categories support multiple instances and distinct uncertainty/error states.
- [ ] No unbounded prompt.
- [ ] Retention is enforced.
- [ ] Local startup works with no paid key; paid paths respect budgets.
- [ ] CUAD reports in DuckDB disclose accuracy, failures, latency and costs per arm without fabricated results.
- [ ] Cloud Run deployment and recovery checks pass.
- [ ] Remaining limitations are documented.
