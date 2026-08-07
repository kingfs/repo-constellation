import { z } from "zod";
import type { PoolConfig } from "pg";

const schema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  HOST: z.string().min(1).default("0.0.0.0"),
  DATABASE_URL: z.string().url().optional(),
  PGHOST: z.string().min(1).optional(),
  PGPORT: z.coerce.number().int().min(1).max(65535).default(5432),
  PGUSER: z.string().min(1).optional(),
  PGPASSWORD: z.string().min(1).optional(),
  PGDATABASE: z.string().min(1).optional(),
  MEILISEARCH_URL: z.string().url(),
  MEILISEARCH_API_KEY: z.string().min(1),
  MEILISEARCH_INDEX: z.string().regex(/^[A-Za-z0-9_-]+$/).default("repositories_v1"),
  PLATFORM_AGENT_TOKEN: z.string().min(24),
  ADMIN_TOKEN: z.string().min(24).optional(),
  AGENT_COMPOSE_URL: z.string().url().optional(),
  AGENT_COMPOSE_AUTH_TOKEN: z.string().min(1).optional(),
  AGENT_COMPOSE_PROJECT: z.string().min(1).default("repo-constellation"),
  AGENT_COMPOSE_AGENTS: z.string().min(1).default("star-sync,star-sync-control,star-curator"),
  AGENT_COMPOSE_TIMEOUT_MS: z.coerce.number().int().min(100).max(30_000).default(5000),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  INDEXER_ENABLED: z.string().regex(/^(true|false)$/).default("true").transform((v) => v === "true"),
  INDEXER_WORKER_ID: z.string().min(1).max(200).default("platform-api-indexer"),
  INDEXER_POLL_INTERVAL_MS: z.coerce.number().int().min(100).max(300_000).default(5000),
  INDEXER_BATCH_SIZE: z.coerce.number().int().min(1).max(100).default(10),
  INDEXER_LEASE_SECONDS: z.coerce.number().int().min(30).max(86_400).default(300),
  INDEXER_README_MAX_CHARS: z.coerce.number().int().min(0).max(1_000_000).default(100_000),
  ANALYSIS_MIN_CONCURRENCY: z.coerce.number().int().min(1).max(16).default(1),
  ANALYSIS_MAX_CONCURRENCY: z.coerce.number().int().min(1).max(16).default(4),
  ANALYSIS_INITIAL_CONCURRENCY: z.coerce.number().int().min(1).max(16).default(2),
}).superRefine((value, context) => {
  if (value.ANALYSIS_MIN_CONCURRENCY > value.ANALYSIS_INITIAL_CONCURRENCY || value.ANALYSIS_INITIAL_CONCURRENCY > value.ANALYSIS_MAX_CONCURRENCY) context.addIssue({ code: z.ZodIssueCode.custom, path: ["ANALYSIS_INITIAL_CONCURRENCY"], message: "must be between ANALYSIS_MIN_CONCURRENCY and ANALYSIS_MAX_CONCURRENCY" });
  if (value.DATABASE_URL || (value.PGHOST && value.PGUSER && value.PGPASSWORD && value.PGDATABASE)) return;
  context.addIssue({ code: z.ZodIssueCode.custom, path: ["DATABASE_URL"], message: "DATABASE_URL or PGHOST/PGUSER/PGPASSWORD/PGDATABASE is required" });
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = schema.safeParse(env);
  if (!result.success) {
    throw new Error(`invalid configuration: ${result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  }
  return result.data;
}

export function postgresPoolConfig(config: Config, max: number): PoolConfig {
  const common = { max, connectionTimeoutMillis: 5000 };
  return config.DATABASE_URL
    ? { ...common, connectionString: config.DATABASE_URL }
    : { ...common, host: config.PGHOST, port: config.PGPORT, user: config.PGUSER, password: config.PGPASSWORD, database: config.PGDATABASE };
}
