import { expect, it } from "vitest";
import { loadConfig, postgresPoolConfig } from "../src/config.js";
it("fails closed when required configuration is absent", () => expect(() => loadConfig({})).toThrow(/invalid configuration/));
it("requires either a database URL or complete structured settings", () => expect(() => loadConfig({ MEILISEARCH_URL: "http://search:7700", MEILISEARCH_API_KEY: "key", PLATFORM_AGENT_TOKEN: "123456789012345678901234" })).toThrow(/DATABASE_URL.*PGHOST/));
it("loads strict production configuration", () => expect(loadConfig({ DATABASE_URL: "postgres://x:x@db/x", MEILISEARCH_URL: "http://search:7700", MEILISEARCH_API_KEY: "key", PLATFORM_AGENT_TOKEN: "123456789012345678901234" }).PORT).toBe(8080));
it("loads optional agent-compose daemon authentication", () => expect(loadConfig({ DATABASE_URL: "postgres://x:x@db/x", MEILISEARCH_URL: "http://search:7700", MEILISEARCH_API_KEY: "key", PLATFORM_AGENT_TOKEN: "123456789012345678901234", AGENT_COMPOSE_AUTH_TOKEN: "daemon-secret" }).AGENT_COMPOSE_AUTH_TOKEN).toBe("daemon-secret"));
it("observes only the single Curator definition by default", () => expect(loadConfig({ DATABASE_URL: "postgres://x:x@db/x", MEILISEARCH_URL: "http://search:7700", MEILISEARCH_API_KEY: "key", PLATFORM_AGENT_TOKEN: "123456789012345678901234" }).AGENT_COMPOSE_AGENTS).toBe("star-sync,star-sync-control,star-curator"));
it("validates and coerces index worker configuration", () => {
  const base = { DATABASE_URL: "postgres://x:x@db/x", MEILISEARCH_URL: "http://search:7700", MEILISEARCH_API_KEY: "key", PLATFORM_AGENT_TOKEN: "123456789012345678901234" };
  expect(loadConfig({ ...base, INDEXER_ENABLED: "false", INDEXER_BATCH_SIZE: "25", INDEXER_POLL_INTERVAL_MS: "1000" })).toEqual(expect.objectContaining({ INDEXER_ENABLED: false, INDEXER_BATCH_SIZE: 25, INDEXER_POLL_INTERVAL_MS: 1000 }));
  expect(() => loadConfig({ ...base, INDEXER_ENABLED: "yes" })).toThrow(/INDEXER_ENABLED/);
  expect(() => loadConfig({ ...base, INDEXER_LEASE_SECONDS: "2" })).toThrow(/INDEXER_LEASE_SECONDS/);
});
it("supports structured PostgreSQL settings without URI encoding", () => {
  const config = loadConfig({ PGHOST: "postgres", PGUSER: "github_stars", PGPASSWORD: "p@ss:word#raw", PGDATABASE: "github_stars", MEILISEARCH_URL: "http://search:7700", MEILISEARCH_API_KEY: "key", PLATFORM_AGENT_TOKEN: "123456789012345678901234" });
  expect(postgresPoolConfig(config, 10)).toEqual(expect.objectContaining({ host: "postgres", user: "github_stars", password: "p@ss:word#raw", database: "github_stars", max: 10 }));
});
it("validates adaptive analysis concurrency bounds", () => {
  const base = { DATABASE_URL: "postgres://x:x@db/x", MEILISEARCH_URL: "http://search:7700", MEILISEARCH_API_KEY: "key", PLATFORM_AGENT_TOKEN: "123456789012345678901234" };
  expect(loadConfig({ ...base, ANALYSIS_MIN_CONCURRENCY: "1", ANALYSIS_INITIAL_CONCURRENCY: "2", ANALYSIS_MAX_CONCURRENCY: "4" })).toMatchObject({ ANALYSIS_MIN_CONCURRENCY: 1, ANALYSIS_INITIAL_CONCURRENCY: 2, ANALYSIS_MAX_CONCURRENCY: 4 });
  expect(() => loadConfig({ ...base, ANALYSIS_INITIAL_CONCURRENCY: "5", ANALYSIS_MAX_CONCURRENCY: "4" })).toThrow(/ANALYSIS_INITIAL_CONCURRENCY/);
});
