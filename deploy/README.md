# Local infrastructure

This deployment starts the complete standalone platform: PostgreSQL,
Meilisearch, the one-shot migration runner, Platform API and Web. PostgreSQL is
the source of truth; the Meilisearch volume is a rebuildable index. Agents run
separately in agent-compose and reach this deployment through Platform API.

`ADMIN_TOKEN` protects the Web `/admin` control plane. Use a separate random value of at
least 24 characters; the browser keeps it only in the current tab's `sessionStorage`.

## Start

```bash
cp .env.example .env
# Replace the required secrets and model settings.
docker compose up -d --wait
```

Compose passes PostgreSQL connection fields separately, so generated passwords
may safely contain URI-reserved characters such as `@`, `:`, `/`, `?` or `#`.

The default host endpoints are Web `http://127.0.0.1:3000`, API
`http://127.0.0.1:8080` and Meilisearch `http://127.0.0.1:7700`. PostgreSQL is
intentionally available only inside the Compose network. Override host-side
ports when occupied. Set a `*_BIND_ADDR` explicitly only when another host
must connect, protect that interface with a firewall, and do not expose
PostgreSQL or Meilisearch directly to the public Internet.

From the repository root use `task platform:up` to start existing images or
`task platform:rebuild` to build and start them. Both commands
use the repository-level `.env` as the single configuration source shared with
the Agent project. Stop services with `task platform:down`.

## Migrate and verify

The migration runner records each file and its SHA-256 checksum. Running it
again is a no-op; editing an already applied migration fails instead of
silently changing history. A PostgreSQL session advisory lock serializes
concurrent migrators across checksum validation and all migration transactions.

```bash
# Low-level migration usage is for CI or an externally reachable PostgreSQL.
# The default Compose stack does not publish PostgreSQL on the host.
export DATABASE_URL='postgresql://github_stars:password@postgres.example:5432/github_stars'
deploy/scripts/migrate.sh

export MEILI_URL='http://127.0.0.1:7700'
deploy/scripts/smoke-test.sh
```

`task platform:smoke` starts two Compose migrators concurrently and then runs a third time,
exercises foreign keys, idempotency constraints, checks and indexes, and
verifies Meilisearch health without exposing PostgreSQL to the host. The lower-level
`smoke-test.sh` remains available for CI environments that provide `DATABASE_URL`
and `MEILI_URL`. The schema check writes a
single deterministic fixture (`github_id=123`) and is intended for a fresh test
database. Remove local infrastructure and its data with:

```bash
docker compose down -v
```

With the full platform running, verify the offline fake GitHub/LLM harness,
real Collector and Curator scripts, reconciliation, adaptive refresh, analysis
submission, the background indexer, Meilisearch and the Web API proxy:

```bash
API_URL=http://127.0.0.1:8080 \
WEB_URL=http://127.0.0.1:3000 \
task platform:e2e
```

The task reads the effective Agent token from the running API container.

The E2E test writes a uniquely suffixed `example/delta-tool-*` repository, so it
can be repeated without deleting existing data. Run it against a development
database. It does not contact GitHub or an LLM and does not require either
external credential.

Back up PostgreSQL with `pg_dump`; Meilisearch can be rebuilt from PostgreSQL.
Do not commit `.env` or embed production credentials in Compose.

The repository includes repeatable operational commands instead of relying on an unverified
`pg_dump` instruction:

```bash
task ops:backup -- ./postgres.dump
task ops:restore-drill -- ./postgres.dump
task ops:check
```

The restore drill uses a uniquely named temporary database and never overwrites the live database.
See `docs/operations.md` for recovery, consistency, metrics and evaluation procedures.
