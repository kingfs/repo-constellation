# Platform API

TypeScript service implementing `docs/api-contract-v1.md`. PostgreSQL is the fact source; Meilisearch is a replaceable query index. Internal routes require the exact `PLATFORM_AGENT_TOKEN` bearer token and every write requires an `Idempotency-Key`.

```bash
npm install
npm run dev
```

The repository deployment uses the root `.env` through Docker Compose. For a
standalone API process, export the variables validated by `src/config.ts` before
running `npm run dev`; a second service-local env file is intentionally not maintained.

Checks:

```bash
npm test
npm run lint
npm run build
```

The PostgreSQL adapter expects the Phase 1 tables in `docs/design.md`: `repositories`, `repository_snapshots`, `repository_analyses`, and `jobs`. It uses transactions, uniqueness constraints and advisory transaction locks for idempotent effects. The service never treats Meilisearch as authoritative.

For integration, PostgreSQL `jobs` is the sole reliable side-effect channel. Fact changes and their follow-up jobs are committed in one transaction; leased workers provide at-least-once processing. `outbox_events` remains reserved for a future end-to-end publisher/consumer implementation and is deliberately not partially populated.

Operational recovery is available through authenticated internal endpoints: list `dead`, `failed`, or `running` jobs; retry a terminal job; schedule project recollection through the existing Collector due flow; or enqueue deduplicated reanalysis. These operations never mutate snapshots or analyses directly. See `docs/api-contract-v1.md` for the frozen contract.

Admin agent runs use agent-compose's read-only Connect RPC endpoints. Configure `AGENT_COMPOSE_URL`
(`http://agent-compose:7410` in Compose), `AGENT_COMPOSE_AUTH_TOKEN` when daemon Bearer authentication
is enabled, `AGENT_COMPOSE_PROJECT`, and optionally the comma-separated
`AGENT_COMPOSE_AGENTS`. The bridge never invokes the CLI or accepts daemon/project paths from callers.
It merges automatic Scheduler events with manual/API runs and returns bounded, redacted log events.

## Repository indexer

The API process runs a deterministic background worker for `index_repository` jobs. It leases jobs through PostgreSQL, loads the repository's current snapshot and latest analysis, and idempotently replaces the Meilisearch document by repository UUID. It waits for each Meilisearch task before completing the job; failures are returned to the job adapter for retry. Unstarred or deleted repositories are removed from search.

Indexer settings:

```dotenv
INDEXER_ENABLED=true
INDEXER_WORKER_ID=platform-api-indexer
INDEXER_POLL_INTERVAL_MS=5000
INDEXER_BATCH_SIZE=10
INDEXER_LEASE_SECONDS=300
INDEXER_README_MAX_CHARS=100000
```

All values are validated at startup. `SIGINT` and `SIGTERM` stop polling before the database pool is closed.

Meilisearch is derived data. To discard it and rebuild every currently starred repository from PostgreSQL:

```bash
npm run build
npm run rebuild-index
```

The rebuild clears the configured versioned index, walks repository UUIDs in stable batches, and skips unstarred repositories. Run only one rebuild for an index at a time; normal job processing remains safe because document writes are idempotent.

## Search Agent runtime contract

`POST /api/v1/agent/search` accepts `{ "query": "..." }` and returns HTTP 202
with `runId`, `status`, and `eventsUrl`. `GET /api/v1/agent/search/:runId`
returns status and the final answer. The `eventsUrl` replays and follows SSE events
named `run.started`, `search.started`, `search.completed`,
`candidates.compared`, `answer.completed`, and `run.failed`.

The built-in `BoundedSearchAgent` is the first integration runtime adapter. It
only uses the existing search and repository read interfaces, with at most three
search rounds, 20 hits per round, and ten compared candidates. Answers include matching reasons, source freshness,
alternatives, and confidence. Run state is process-local; `AgentSearchRuntime`
is the replacement boundary for an agent-compose bridge or durable run store
without changing the HTTP, SSE, or Web contracts. The local store retains at
most 500 concurrent/recent runs, evicts the oldest completed run at capacity,
and lazily removes completed runs after 15 minutes; at full active-run
capacity, creation returns HTTP 429.
