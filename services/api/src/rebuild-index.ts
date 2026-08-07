import { Pool } from "pg";
import { loadConfig, postgresPoolConfig } from "./config.js";
import { RepositoryIndexer } from "./indexer.js";
import { MeiliSearchAdapter } from "./meilisearch.js";
import { PostgresAdapter } from "./postgres.js";

const config = loadConfig();
const pool = new Pool(postgresPoolConfig(config, 5));
const postgres = new PostgresAdapter(pool);
const search = new MeiliSearchAdapter(config.MEILISEARCH_URL, config.MEILISEARCH_API_KEY, config.MEILISEARCH_INDEX);
const indexer = new RepositoryIndexer(postgres, postgres, search, {
  workerId: config.INDEXER_WORKER_ID, batchSize: config.INDEXER_BATCH_SIZE, leaseSeconds: config.INDEXER_LEASE_SECONDS,
  pollIntervalMs: config.INDEXER_POLL_INTERVAL_MS, readmeMaxChars: config.INDEXER_README_MAX_CHARS,
}, console);
try {
  await search.ensureConfigured();
  const total = await indexer.rebuild();
  console.info({ total }, "search index rebuilt from PostgreSQL");
} finally { await pool.end(); }
