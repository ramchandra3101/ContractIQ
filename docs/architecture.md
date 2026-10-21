# ContractIQ architecture and implementation ledger

## Implemented: foundation (Milestone 1)

Fastify API and shared strict TypeScript packages. Zod validates environment configuration before startup. Prisma defines all six requested models and database uniqueness constraints. PostgreSQL, persistent Redis (AOF, no eviction), MinIO and bucket initialization run through Compose. Health probes are bounded and independent of authentication. API authentication resolves a server-configured token to an owner ID. Authorization on documents will be enforced when document routes are added.

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

Stream authenticated uploads into bounded temporary storage, inspect PDF signature and structure in a resource-limited child process, and enforce page limits. Write content to MinIO before committing Document, ProcessingJob, and OutboxEvent in a single PostgreSQL transaction. Reconcile orphaned objects when database commit fails. Claim outbox records with expiring leases and publish stable BullMQ job IDs. A crash after queue publication but before marking the outbox row published may republish; worker database claims must prevent duplicate execution. Reconcile failed and missing queue jobs against database state. Add ownership-filtered document, job, result and page routes plus idempotent reprocessing.

## Planned: parsers and routing (Milestone 3)

DocumentParser interface and separate PDF.js, Tesseract and vision adapters. Preserve page/block references and real coordinates only. Inspect text count, image coverage, corruption, rotation and layout. Default to reliable native text; route scans to OCR with bounded CLI subprocesses, pixel/page limits, timeouts and container isolation. Store routing thresholds and decisions with each processing version.

## Planned: grounded extraction (Milestone 4)

OpenAI Responses structured outputs and deterministic MockProvider. Five initial CUAD categories with a schema extensible to 41. Separate present, absent, unknown and error states. Candidate retrieval and overlapping windows retain source offsets. Verify each quotation against source text and preserve multiple instances. Enforce per-document budgets before paid calls; account for uncertain costs after interrupted calls.

## Planned: evaluation (Milestone 5)

TypeScript official CUAD downloader/preparer, contract-disjoint splits, one-to-one span matching, exact and token-overlap precision/recall/F1, micro/macro metrics, no-answer accuracy, evidence/schema rates, latency percentiles, cost and routing counts. Compare strategies on identical eligible contracts, report unsupported cases and keep synthetic scans in a separate derived dataset. Export measured JSON/CSV/Markdown only.

## Planned: operational hardening (Milestone 6)

OpenTelemetry tracing without sensitive text, optional budgeted vision escalation, retention cleanup, adversarial PDF/OCR and ownership tests, deployment runbook. Seed PDF contracts and mock extraction fixtures arrive with parser/extraction milestones. No Python service or scripts are required.

## Validation boundary

Unit tests inject dependency probes to test failures deterministically. They are not evidence that PostgreSQL, Redis or MinIO are running. CI's Compose smoke test exercises real migrations and readiness. Local Docker checks require Docker to be installed and running.
