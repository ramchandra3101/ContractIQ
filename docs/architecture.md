# ContractIQ architecture and implementation ledger

The [implementation plan](implementation-plan.md) is the canonical delivery checklist and status tracker. This document is a shorter architecture overview.

## Implemented: foundation (Milestone 1)

Fastify API and shared strict TypeScript packages. Zod validates environment configuration before startup. Prisma defines all six requested models and database uniqueness constraints. PostgreSQL, persistent Redis (AOF, no eviction), RustFS (S3-compatible; replaced MinIO, whose images left Docker Hub) and bucket initialization run through Compose. Health probes are bounded and independent of authentication. API authentication resolves a server-configured token to an owner ID. Authorization on documents will be enforced when document routes are added.

Database constraints reserve the following invariants:

| Constraint | Example |
| --- | --- |
| Document `(ownerId, idempotencyKey)` | Two retries for owner A/key K cannot create two documents. The future upload handler must compare checksums and return 409 for different content. |
| Job `(documentId, version)` | Two deliveries cannot create duplicate version 1 jobs. |
| Page `(jobId, pageNumber)` | Retrying page 3 upserts the same artifact. |
| Field `(jobId, category, instance)` | Replaying an extraction cannot append duplicate instance 0 rows. |
| Outbox `(jobId, type)` | One durable publication intent per job and event type. |

These constraints alone do not implement job processing or exactly-once external API calls. All statuses and transitions still need transactional application services. Model invocation records allow nullable usage and pricing, so unavailable cost information is not represented as zero.

## Planned: durable ingestion (Milestone 2)

Stream authenticated uploads into bounded temporary storage, inspect PDF signature and structure in a resource-limited child process, and enforce page limits. Write content to object storage before committing Document, ProcessingJob, and OutboxEvent in a single PostgreSQL transaction. Reconcile orphaned objects when database commit fails. Claim outbox records with expiring leases and publish stable BullMQ job IDs. A crash after queue publication but before marking the outbox row published may republish; worker database claims must prevent duplicate execution. Reconcile failed and missing queue jobs against database state. Add ownership-filtered document, job, result and page routes plus idempotent reprocessing.

## Planned: parser arms (Milestone 3)

One DocumentParser contract with interchangeable arms so evaluation can hold everything downstream constant: LlamaParse tiers `fast` (no AI model, OCR-style), `cost_effective`, `agentic` and `agentic_plus`, plus a `claude-pdf` multimodal arm that passes the PDF directly to Claude. PDF.js stays only for local validation and page counting. Parser output is cached by `(checksum, arm, version)` in object storage so retries never pay twice. Each page records billed units and cost.

## Planned: grounded extraction (Milestone 4)

Anthropic SDK `messages.parse` with Zod structured outputs (`zodOutputFormat`) and a deterministic MockProvider. Five initial CUAD categories, registry extensible to 41, each tagged with its field type. Separate present, absent, unknown and error states. Bounded overlapping windows. Anthropic citations cannot be combined with structured outputs, so quotations are verified by our own code against the reference text. Schema validation outcomes (valid, Zod-rejected, refused, truncated, retried) are recorded per call. Arize Phoenix traces LLM and parser calls via OpenInference.

## Planned: evaluation and analytics (Milestone 5)

TypeScript CUAD preparation, contract-disjoint splits, one-to-one span matching, per-field and per-field-type precision/recall/F1, no-answer accuracy, schema validity and evidence support rates, latency and cost. Every parser arm runs on the same eligible contracts. Results are written as Parquet and loaded into a per-run DuckDB file; reports are SQL over DuckDB. PostgreSQL stays the operational store; DuckDB is analytics only.

## Planned: Cloud Run and hardening (Milestone 6)

API on Cloud Run, worker on Cloud Run with min instances 1 (BullMQ cannot scale to zero), Cloud SQL, Memorystore, GCS through the S3 interoperability API, eval as a Cloud Run job, Secret Manager, Arize AX or self-hosted Phoenix. Retention cleanup, adversarial PDF and ownership tests, runbooks.

## Validation boundary

Unit tests inject dependency probes to test failures deterministically. They are not evidence that PostgreSQL, Redis or object storage are running. CI's Compose smoke test exercises real migrations and readiness. Local Docker checks require Docker to be installed and running.
