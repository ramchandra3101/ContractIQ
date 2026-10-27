# ContractIQ

Node.js / TypeScript document intelligence pipeline. **Current implementation: Milestone 1 foundation.** Document upload, processing, OCR, extraction, and evaluation are not implemented yet. No extraction or benchmark results are claimed.

Follow the [complete implementation plan](docs/implementation-plan.md) for current status, all six milestones, remaining requirements, acceptance tests, and the release checklist.

## Requirements and local setup

Node.js 24 LTS, pnpm 10.28.2, and Docker Compose v2.

Use **pnpm**, not `npm install`, to install this repository's dependencies. After cloning, run the commands below from the repository root. One `pnpm install` creates the root and package-level `node_modules` directories automatically, including dependency links for `apps/api` and `packages/*`. No separate install inside each package is needed. These directories are generated locally and excluded from Git.

If Corepack is unavailable, install pnpm with `npm install -g pnpm@10.28.2` and skip the two Corepack commands below.

```sh
corepack enable
corepack prepare pnpm@10.28.2 --activate
cp .env.example .env
pnpm install
pnpm build
docker compose up -d postgres redis storage storage-init
# Export DATABASE_URL for Prisma CLI (the API dev command loads .env automatically).
export DATABASE_URL='postgresql://contractiq:local-postgres-password@localhost:5432/contractiq'
pnpm db:migrate
pnpm dev
```

Alternatively, after creating `.env`, run `docker compose --profile app up --build`. This applies migrations before starting the API. Compose credentials are local development defaults. Ports bind only to loopback.

```sh
curl http://localhost:3000/health/live
curl http://localhost:3000/health/ready
pnpm test
pnpm lint
pnpm build
```

Liveness returns 200 while the API is serving. Readiness checks PostgreSQL, Redis, and the configured S3 bucket (RustFS locally) concurrently, returning 503 on dependency failure or timeout. It does not yet validate migration compatibility.

API routes require `Authorization: Bearer <token>`. `API_KEYS_JSON` maps tokens to owner IDs; tokens must have at least 32 characters. For example, the local example token maps to `local-user`. Health routes are public. Unknown authenticated routes return a consistent 404; unimplemented document endpoints do not pretend to accept work.

`pnpm eval` deliberately exits with an explanatory error until Milestone 5. The `mock` configuration default requires no paid API key; a mock extraction provider will be implemented in Milestone 4. `LLM_PROVIDER=anthropic` requires `ANTHROPIC_API_KEY`.

Target stack: Fastify, Zod, Prisma/PostgreSQL, Redis/BullMQ, RustFS (local S3)/GCS, LlamaParse (parsing arms), Anthropic SDK (multimodal arm and structured extraction), DuckDB (evaluation analytics), Arize Phoenix (tracing), Cloud Run (deployment). LlamaParse and Anthropic receive full contract content; use public CUAD data until a data-processing decision exists for private contracts.

## Workspace

- `apps/api`: Fastify, Pino logging, authentication, rate limits, consistent errors, health checks, graceful shutdown.
- `packages/core`: strict Zod environment configuration.
- `packages/database`: Prisma models, generated client boundary, PostgreSQL migration.
- `docs/architecture.md`: pipeline design, invariants, and remaining milestones.
- `.github/workflows/ci.yml`: build, lint, tests, container startup, migration and readiness smoke check.

## Security and deployment boundaries

This foundation is not yet a production document-processing service. Rotate development credentials, use a secret manager and TLS, restrict health endpoints at the ingress, and replace static API-key provisioning with your identity system as needed. Rate limiting currently applies per process and client IP; Redis-backed distributed enforcement is future work. The API does not trust forwarded IP headers by default.

Normal logs omit request bodies, authorization headers, raw URLs and internal dependency errors. Configuration failures report variable names only. The application image runs as a non-root user; Compose drops capabilities and sets resource limits and a read-only filesystem. Retention and upload limits are validated configuration; retention deletion and PDF validation are future work.

Prisma 6.19 is explicitly pinned for its stable generated-client interface. Dependencies are locked with pnpm. Container tags should be resolved to reviewed digests before production deployment. The runtime currently includes build dependencies to make the migration command available; separate migration and minimal runtime images are a later optimization.

## Reference

[AI Engineer Projects, Project 1](https://github.com/aishwaryanr/awesome-generative-ai-guide/blob/main/youtube/ai-engineer-projects.md) motivates the document intelligence workflow and per-field accuracy/cost evaluation. This repository follows the requested Node.js stack instead of the reference's Python stack.
