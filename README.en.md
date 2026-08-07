# Repo Constellation

[中文](README.md) · [Design](docs/design.md) · [API contract](docs/api-contract-v1.md) · [Implementation status](docs/implementation-status.md)

Repo Constellation turns your GitHub Stars into a continuously updated, AI-curated knowledge base. It synchronizes starred repositories, reads metadata, README files and releases, produces structured Chinese summaries and classifications, and supports browsing, filtering, full-text search and evidence-based agent search.

This is more than a Stars backup and does not use the conventional chunk-and-embed RAG pipeline. Each repository is treated as an evolving knowledge object: analysis runs only when its content changes, and every result is tied to a content snapshot and analysis version.

> Repo Constellation is built on [chaitin/agent-compose](https://github.com/chaitin/agent-compose), which provides declarative agents, isolated runtimes, scheduling and event orchestration. This project adds the GitHub Stars Collector, Curator, Search Agent, data platform and web application.

## Features

- Safe, fully paginated GitHub Stars reconciliation
- Activity-aware README and release refresh scheduling
- Content hashing and idempotent LLM analysis
- Structured Chinese summaries, categories, keywords, use cases and limitations
- Faceted browsing and fuzzy/full-text search
- Multi-query Search Agent with bilingual expansion and evidence-backed comparison
- Durable jobs, leases, retries, recovery controls and operational status
- PostgreSQL as the source of truth and a rebuildable Meilisearch projection

## How it works

```text
GitHub API → Collector → PostgreSQL → Curator jobs → structured analysis
                            │                           │
                            └── Platform API → Indexer → Meilisearch
                                      │
                                      ├── Web
                                      └── Search Agent
```

Agents access business state only through the constrained Platform API. PostgreSQL is authoritative; Meilisearch is disposable. Repository content and user input are treated as untrusted data and cannot change agent permissions.

## Quick start

Prerequisites: Docker Engine with Compose v2, Node.js 22+, [Task](https://taskfile.dev/), the [agent-compose CLI](https://github.com/chaitin/agent-compose), a GitHub token, and a supported LLM provider.

```bash
git clone https://github.com/kingfs/repo-constellation.git
cd repo-constellation
cp .env.example .env
# Fill GITHUB_TOKEN, random service tokens, AGENT_MODEL and LLM_API_KEY.

task setup:deps
task start
```

The Compose stack starts agent-compose, PostgreSQL, Meilisearch, the Platform API and the web app. The host CLI then applies `agent-compose.yml` to the daemon. `task start` logs the local CLI in with `AGENT_COMPOSE_AUTH_TOKEN`; to log in again or apply only the agent project, run:

```bash
task agent:login
task agent:apply
```

Open <http://127.0.0.1:3000>, then run the first synchronization and curation:

```bash
task agent:sync
task agent:curate
```

Ports bind to `127.0.0.1` by default. Use HTTPS, authentication, rate limiting and a trusted reverse proxy before exposing the deployment publicly.

## Development

```bash
task setup:deps
task quality:lint
task quality:test
npm --prefix services/api run build
npm --prefix services/web run build
git diff --check
```

See [CONTRIBUTING.md](CONTRIBUTING.md), [security guidance](SECURITY.md), and the [integration gate](docs/integration-gate.md). The implementation boundary is documented in [docs/implementation-status.md](docs/implementation-status.md); planned design items are not necessarily implemented.

## License

Repo Constellation is available under the [MIT License](LICENSE). agent-compose and other dependencies retain their respective licenses.
