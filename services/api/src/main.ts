import { Pool } from "pg";
import { buildApp } from "./app.js";
import { loadConfig, postgresPoolConfig } from "./config.js";
import { RepositoryIndexer } from "./indexer.js";
import { MeiliSearchAdapter } from "./meilisearch.js";
import { PostgresAdapter } from "./postgres.js";
import { BoundedSearchAgent } from "./search-agent.js";
import { MetricsRegistry } from "./metrics.js";
import { AgentComposeRunBridge } from "./agent-compose-runs.js";
import { ComposeSearchAgent } from "./compose-search-agent.js";

const config = loadConfig();
const pool = new Pool(postgresPoolConfig(config, 10));
const postgres = new PostgresAdapter(pool, { analysisMinConcurrency: config.ANALYSIS_MIN_CONCURRENCY, analysisMaxConcurrency: config.ANALYSIS_MAX_CONCURRENCY, analysisInitialConcurrency: config.ANALYSIS_INITIAL_CONCURRENCY });
const search = new MeiliSearchAdapter(config.MEILISEARCH_URL, config.MEILISEARCH_API_KEY, config.MEILISEARCH_INDEX);
const metrics = new MetricsRegistry();
const agentRuns = config.AGENT_COMPOSE_URL ? new AgentComposeRunBridge({ baseUrl: config.AGENT_COMPOSE_URL, authToken: config.AGENT_COMPOSE_AUTH_TOKEN, projectName: config.AGENT_COMPOSE_PROJECT, agentNames: config.AGENT_COMPOSE_AGENTS.split(",").map((value) => value.trim()).filter(Boolean), timeoutMs: config.AGENT_COMPOSE_TIMEOUT_MS }) : undefined;
const agentSearch = agentRuns
  ? new ComposeSearchAgent(agentRuns as AgentComposeRunBridge, "star-search", postgres)
  : new BoundedSearchAgent(search, postgres, { store: postgres, onEvent: (event) => metrics.increment("platform_agent_search_events_total", { type: event.type }) });
const app = buildApp({ repositories: postgres, jobs: postgres, search, agentRuns, agentSearch, metrics, agentToken: config.PLATFORM_AGENT_TOKEN, adminToken: config.ADMIN_TOKEN ?? config.PLATFORM_AGENT_TOKEN }, { level: config.LOG_LEVEL });
const indexer = new RepositoryIndexer(postgres, postgres, search, {
  workerId: config.INDEXER_WORKER_ID, batchSize: config.INDEXER_BATCH_SIZE, leaseSeconds: config.INDEXER_LEASE_SECONDS,
  pollIntervalMs: config.INDEXER_POLL_INTERVAL_MS, readmeMaxChars: config.INDEXER_README_MAX_CHARS,
}, app.log);
let indexerRun: Promise<void> | undefined;

const shutdown = async () => { indexer.stop(); await indexerRun; await app.close(); await pool.end(); };
process.on("SIGINT", () => void shutdown()); process.on("SIGTERM", () => void shutdown());
await search.ensureConfigured();
const interruptedRuns = await agentSearch.recover();
if (interruptedRuns) app.log.warn({ interruptedRuns }, "recovered interrupted agent search runs");
await app.listen({ host: config.HOST, port: config.PORT });
if (config.INDEXER_ENABLED) indexerRun = indexer.run();
