import { describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { PostgresAdapter } from "../src/postgres.js";

it("counts only active repositories analyzed for their current snapshot", async () => {
  const query = vi.fn().mockResolvedValue({ rows: [{ total_stars: 100, synced_repositories: 90, analyzed_repositories: 40, updated_at: new Date("2026-07-15T00:00:00Z") }] });
  const db = new PostgresAdapter({ query } as unknown as Pool);
  await expect(db.stats()).resolves.toEqual({ totalStars: 100, syncedRepositories: 90, analyzedRepositories: 40, pendingAnalysis: 60, updatedAt: "2026-07-15T00:00:00.000Z" });
  expect(query.mock.calls[0]![0]).toContain("ra.snapshot_id=r.current_snapshot_id");
  expect(query.mock.calls[0]![0]).toContain("r.unstarred_at IS NULL");
});

describe("job terminal state semantics", () => {
  it("atomically clears lease and stale error columns on completion", async () => { const query = vi.fn().mockResolvedValue({ rowCount: 1 }); const db = new PostgresAdapter({ query } as unknown as Pool); await db.complete("job", "worker", "complete-key"); expect(query.mock.calls[0]![0]).toContain("leased_until=NULL,leased_by=NULL,last_error=NULL"); });
  it("heartbeats only the current live lease and extends its deadline", async () => { const leasedUntil = new Date("2026-07-22T09:00:00Z"); const query = vi.fn().mockResolvedValue({ rowCount: 1, rows: [{ leased_until: leasedUntil }] }); const db = new PostgresAdapter({ query } as unknown as Pool); await expect(db.heartbeat("job", "worker", 300, "heartbeat-key", { sandboxId: "sandbox" })).resolves.toEqual({ leasedUntil: leasedUntil.toISOString() }); expect(query.mock.calls[0]![0]).toContain("last_heartbeat_at=now()"); expect(query.mock.calls[0]![0]).toContain("leased_by=$2"); });
  it("rejects a heartbeat after lease ownership is lost", async () => { const query = vi.fn().mockResolvedValue({ rowCount: 0, rows: [] }); const db = new PostgresAdapter({ query } as unknown as Pool); await expect(db.heartbeat("job", "old-worker", 300, "heartbeat-key")).rejects.toMatchObject({ code: "JOB_LEASE_CONFLICT" }); });
  it("atomically clears both lease columns on failure", async () => { const query = vi.fn().mockResolvedValue({ rowCount: 1 }); const db = new PostgresAdapter({ query } as unknown as Pool); await db.fail("job", "worker", "boom", true, "fail-key"); expect(query.mock.calls[0]![0]).toContain("leased_until=NULL,leased_by=NULL"); });
  it("accepts an already succeeded completion without retaining owner", async () => { const query = vi.fn().mockResolvedValueOnce({ rowCount: 0 }).mockResolvedValueOnce({ rowCount: 1 }); const db = new PostgresAdapter({ query } as unknown as Pool); await expect(db.complete("job", "different-worker", "same-key")).resolves.toBeUndefined(); expect(query.mock.calls[1]![0]).toContain("status='succeeded'"); expect(query.mock.calls[1]![0]).not.toContain("leased_by"); });
  it("marks terminal failures complete and uses bounded one-minute-first backoff", async () => { const query = vi.fn().mockResolvedValue({ rowCount: 1 }); const db = new PostgresAdapter({ query } as unknown as Pool); await db.fail("job", "worker", "boom", true, "fail-key"); const sql = query.mock.calls[0]![0]; expect(sql).toContain("completed_at=CASE WHEN attempts>=max_attempts OR NOT $3 THEN now()"); expect(sql).toContain("attempts-1"); expect(sql).toContain("least(greatest(attempts-1,0),8)"); });
});

describe("job recovery operations", () => {
  it("revives only skipped current-snapshot jobs that still lack an analysis", async () => {
    const client = { query: vi.fn(async (sql: string) => {
      if (sql.includes("SELECT r.id repository_id")) return { rows: [{ repository_id: "repo", full_name: "o/r", snapshot_id: "snap", content_hash: "sha256:x", metadata: {}, readme_text: "r", release_text: null, job_id: "job" }], rowCount: 1 };
      if (sql.startsWith("UPDATE jobs SET status='pending',priority=0")) return { rows: [], rowCount: 1 };
      if (sql.includes("SELECT count(*)::int count")) return { rows: [{ count: 4910 }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    }), release: vi.fn() };
    const db = new PostgresAdapter({ connect: vi.fn().mockResolvedValue(client) } as unknown as Pool);
    await expect(db.reconcileAnalysisQueue(500, "reconcile-key")).resolves.toEqual({ created: 0, revived: 1, remaining: 4910 });
    const select = client.query.mock.calls.find(([sql]) => String(sql).includes("SELECT r.id repository_id"))![0];
    expect(select).toContain("r.unstarred_at IS NULL");
    expect(select).toContain("a.content_hash=s.content_hash");
    expect(select).toContain("j.last_error LIKE 'skipped:%'");
    const update = client.query.mock.calls.find(([sql]) => String(sql).startsWith("UPDATE jobs SET status='pending',priority=0"))!;
    expect(update[0]).toContain("attempts=0"); expect(update[0]).toContain("last_error=NULL"); expect(update[1][1]).toMatchObject({ snapshotId: "snap", contentHash: "sha256:x" });
  });
  it("raises an existing current-snapshot analysis job to highest priority", async () => {
    const client = { query: vi.fn(async (sql: string) => {
      if (sql.includes("EXISTS(SELECT 1 FROM repository_analyses")) return { rows: [{ id: "repo", snapshot_id: "snap", analyzed: false }], rowCount: 1 };
      if (sql.startsWith("UPDATE jobs SET status='pending',priority=100")) return { rows: [{ id: "job" }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    }), release: vi.fn() };
    const db = new PostgresAdapter({ connect: vi.fn().mockResolvedValue(client) } as unknown as Pool);
    await expect(db.prioritizeAnalysis("repo")).resolves.toEqual({ jobId: "job", status: "queued" });
    expect(client.query.mock.calls.some(([sql]) => String(sql).includes("priority=100"))).toBe(true);
  });
  it("sweeps exhausted expired leases before claiming and never exceeds max attempts", async () => {
    const client = { query: vi.fn(async (sql: string) => sql.includes("RETURNING j.*") ? { rows: [], rowCount: 0 } : { rows: [], rowCount: 0 }), release: vi.fn() };
    const db = new PostgresAdapter({ connect: vi.fn().mockResolvedValue(client) } as unknown as Pool);
    await db.claim(["index_repository"], "worker", 10, 60);
    const exhaustedSweep = client.query.mock.calls.find(([sql]) => String(sql).includes("status='dead'"))![0];
    const claim = client.query.mock.calls.find(([sql]) => String(sql).includes("RETURNING j.*"))![0];
    expect(exhaustedSweep).toContain("attempts>=max_attempts");
    expect(claim).toContain("attempts<max_attempts");
  });
  it("applies the minimum priority boundary while claiming", async () => {
    const client = { query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }), release: vi.fn() };
    const db = new PostgresAdapter({ connect: vi.fn().mockResolvedValue(client) } as unknown as Pool);
    await db.claim(["analyze_repository"], "priority-worker", 1, 1800, 100);
    const claim = client.query.mock.calls.find(([sql]) => String(sql).includes("WITH picked AS"))!;
    expect(claim[0]).toContain("priority >= $5"); expect(claim[0]).toContain("started_at=now()"); expect(claim[1]).toEqual([["analyze_repository"], 1, "priority-worker", 1800, 100, null, null]);
  });

  it("records agent-compose correlation when claiming", async () => {
    const client = { query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }), release: vi.fn() };
    const db = new PostgresAdapter({ connect: vi.fn().mockResolvedValue(client) } as unknown as Pool);
    await db.claim(["index_repository"], "indexer", 1, 60, -1000, { runId: "run-1", sandboxId: "sandbox-1" });
    const claim = client.query.mock.calls.find(([sql]) => String(sql).includes("WITH picked AS"))!;
    expect(claim[1]).toEqual([["index_repository"], 1, "indexer", 60, -1000, "run-1", "sandbox-1"]);
  });

  it("skips obsolete or already analyzed jobs unless they are forced", async () => {
    const client = { query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }), release: vi.fn() };
    const db = new PostgresAdapter({ connect: vi.fn().mockResolvedValue(client) } as unknown as Pool);
    await db.claim(["analyze_repository"], "worker", 1, 1800);
    const sweep = client.query.mock.calls.find(([sql]) => String(sql).includes("analysis already exists"))![0];
    expect(sweep).toContain("analysis already exists");
    expect(sweep).toContain("payload->>'force'");
    expect(sweep).toContain("current_snapshot_id");
    expect(sweep).toContain("unstarred_at IS NOT NULL");
  });

  it("reclaims analysis workers with stale heartbeats without waiting for the long lease", async () => {
    const client = { query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }), release: vi.fn() };
    const db = new PostgresAdapter({ connect: vi.fn().mockResolvedValue(client) } as unknown as Pool);
    await db.claim(["analyze_repository"], "worker", 1, 300);
    const sweep = client.query.mock.calls.find(([sql]) => String(sql).includes("worker heartbeat lost"))![0];
    expect(sweep).toContain("last_heartbeat_at<now()-interval '2 minutes'");
    expect(sweep).toContain("attempts>=max_attempts");
    expect(sweep).toContain("type='analyze_repository'");
  });

  it("does not claim beyond the adaptive analysis capacity", async () => {
    const client = { query: vi.fn(async (sql: string) => sql.startsWith("SELECT count(*)::int count FROM jobs WHERE type='analyze_repository'") ? { rows: [{ count: 2 }], rowCount: 1 } : sql.startsWith("SELECT * FROM analysis_concurrency_state") ? { rows: [{ current_limit: 2, last_adjusted_at: new Date(), reason: "initialized" }], rowCount: 1 } : sql.includes("percentile_cont") ? { rows: [{ successes: 0, failures: 0, p95: null, backlog: 1000, severe: false }], rowCount: 1 } : { rows: [], rowCount: 0 }), release: vi.fn() };
    const db = new PostgresAdapter({ connect: vi.fn().mockResolvedValue(client) } as unknown as Pool);
    await expect(db.claim(["analyze_repository"], "second-curator", 1, 1800)).resolves.toEqual([]);
    expect(client.query.mock.calls.some(([sql]) => String(sql).includes("count(*)::int count") && String(sql).includes("leased_until>=now()"))).toBe(true);
  });

  it("limits a multi-job claim to the exact remaining analysis capacity", async () => {
    const client = { query: vi.fn(async (sql: string) => sql.startsWith("SELECT * FROM analysis_concurrency_state") ? { rows: [{ current_limit: 4, last_adjusted_at: new Date(), reason: "initialized" }], rowCount: 1 } : sql.includes("percentile_cont") ? { rows: [{ successes: 0, failures: 0, p95: null, backlog: 10, severe: false }], rowCount: 1 } : sql.startsWith("SELECT count(*)::int count FROM jobs WHERE type='analyze_repository'") ? { rows: [{ count: 2 }], rowCount: 1 } : { rows: [], rowCount: 0 }), release: vi.fn() };
    const db = new PostgresAdapter({ connect: vi.fn().mockResolvedValue(client) } as unknown as Pool, { analysisInitialConcurrency: 4, analysisMaxConcurrency: 4 });
    await db.claim(["analyze_repository"], "curator", 10, 1800);
    const claim = client.query.mock.calls.find(([sql]) => String(sql).includes("WITH picked AS"))!;
    expect(claim[1]).toEqual([["analyze_repository"], 2, "curator", 1800, -1000, null, null]);
  });

  it("increases concurrency for a healthy five-minute window with a small relative backlog", async () => {
    const client = { query: vi.fn(async (sql: string) => sql.startsWith("SELECT * FROM analysis_concurrency_state") ? { rows: [{ current_limit: 2, last_adjusted_at: new Date(Date.now() - 4 * 60_000), reason: "initialized" }], rowCount: 1 } : sql.includes("percentile_cont") ? { rows: [{ successes: 2, failures: 0, p95: 60, backlog: 2, severe: false }], rowCount: 1 } : sql.startsWith("SELECT count(*)::int count FROM jobs WHERE type='analyze_repository'") ? { rows: [{ count: 0 }], rowCount: 1 } : { rows: [], rowCount: 0 }), release: vi.fn() };
    const db = new PostgresAdapter({ connect: vi.fn().mockResolvedValue(client) } as unknown as Pool, { analysisInitialConcurrency: 2, analysisMaxConcurrency: 4 });
    await db.claim(["analyze_repository"], "worker", 1, 1800);
    const update = client.query.mock.calls.find(([sql]) => String(sql).startsWith("UPDATE analysis_concurrency_state"))!;
    expect(update[1]).toEqual([3, "healthy 5m window with relative backlog", 2, 0, 60, 2, true]);
    const statsSql = client.query.mock.calls.find(([sql]) => String(sql).includes("percentile_cont"))![0];
    expect(statsSql).toContain("interval '5 minutes'");
    expect(statsSql).toContain("interval '1 minute'");
  });

  it("reduces concurrency quickly when the provider reports pressure", async () => {
    const client = { query: vi.fn(async (sql: string) => sql.startsWith("SELECT * FROM analysis_concurrency_state") ? { rows: [{ current_limit: 4, last_adjusted_at: new Date(Date.now() - 61_000), reason: "healthy" }], rowCount: 1 } : sql.includes("percentile_cont") ? { rows: [{ successes: 8, failures: 0, p95: 50, backlog: 20, severe: true }], rowCount: 1 } : sql.startsWith("SELECT count(*)::int count FROM jobs WHERE type='analyze_repository'") ? { rows: [{ count: 0 }], rowCount: 1 } : { rows: [], rowCount: 0 }), release: vi.fn() };
    const db = new PostgresAdapter({ connect: vi.fn().mockResolvedValue(client) } as unknown as Pool, { analysisInitialConcurrency: 4, analysisMaxConcurrency: 4 });
    await db.claim(["analyze_repository"], "worker", 1, 1800);
    const update = client.query.mock.calls.find(([sql]) => String(sql).startsWith("UPDATE analysis_concurrency_state"))!;
    expect(update[1]).toEqual([3, "provider pressure in 1m window", 8, 0, 50, 20, true]);
  });

  it("manually retries only failed or dead jobs with a fresh attempt budget", async () => {
    const client = { query: vi.fn(async (sql: string) => {
      if (sql.startsWith("UPDATE jobs SET status='pending'")) return { rows: [{ id: "job", status: "pending" }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    }), release: vi.fn() };
    const db = new PostgresAdapter({ connect: vi.fn().mockResolvedValue(client) } as unknown as Pool);
    await expect(db.retry("job", "retry-key")).resolves.toEqual({ jobId: "job", status: "pending", retried: true });
    const update = client.query.mock.calls.find(([sql]) => String(sql).startsWith("UPDATE jobs SET status='pending'"))![0];
    expect(update).toContain("attempts=0"); expect(update).toContain("status IN ('failed','dead')"); expect(update).toContain("leased_until=NULL,leased_by=NULL");
  });

  it("queues reanalysis from the current immutable snapshot", async () => {
    const client = { query: vi.fn(async (sql: string) => {
      if (sql.includes("SELECT r.id,r.full_name,s.id snapshot_id")) return { rows: [{ id: "repo", full_name: "o/r", snapshot_id: "snap", content_hash: "sha256:x", metadata: {}, readme_text: "r", release_text: "v" }], rowCount: 1 };
      if (sql.startsWith("INSERT INTO jobs")) return { rows: [{ id: "job" }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    }), release: vi.fn() };
    const db = new PostgresAdapter({ connect: vi.fn().mockResolvedValue(client) } as unknown as Pool);
    await expect(db.reanalyze("repo", "v2", "manual-key")).resolves.toEqual({ jobId: "job" });
    const insert = client.query.mock.calls.find(([sql]) => String(sql).startsWith("INSERT INTO jobs"))!;
    expect(insert[1]).toEqual(expect.arrayContaining(["analyze_repository", "repo", "analyze:repo:sha256:x:v2", expect.objectContaining({ snapshotId: "snap", analysisVersion: "v2" })]));
    expect(insert[1][4]).toMatchObject({ force: true, requestedBy: "manual" });
  });

  it("schedules recollection through the Collector due flow without creating an orphan job", async () => {
    const nextCheckAt = new Date("2026-07-15T01:02:03Z");
    const client = { query: vi.fn(async (sql: string) => {
      if (sql.startsWith("UPDATE repositories SET next_check_at=now()")) return { rows: [{ id: "repo", next_check_at: nextCheckAt }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    }), release: vi.fn() };
    const db = new PostgresAdapter({ connect: vi.fn().mockResolvedValue(client) } as unknown as Pool);
    await expect(db.recollect("repo", "manual-key")).resolves.toEqual({ repositoryId: "repo", scheduled: true, nextCheckAt: nextCheckAt.toISOString() });
    expect(client.query.mock.calls.some(([sql]) => String(sql).startsWith("INSERT INTO jobs"))).toBe(false);
  });
});

it("reports retry-wait analysis state for the current snapshot", async () => {
  const query = vi.fn().mockResolvedValue({ rowCount: 1, rows: [{ id: "repo", current_snapshot_id: "snap", analyzed: false, job_id: "job", status: "pending", attempts: 1, max_attempts: 5, available_at: new Date(Date.now() + 60_000), leased_until: null, last_error: "provider unavailable" }] });
  const db = new PostgresAdapter({ query } as unknown as Pool);
  await expect(db.analysisStatus("repo")).resolves.toMatchObject({ repositoryId: "repo", state: "retry_wait", jobId: "job", attempts: 1, lastError: "provider unavailable" });
});

it("does not present an obsolete skipped task as an analysis failure", async () => {
  const query = vi.fn().mockResolvedValue({ rowCount: 1, rows: [{ id: "repo", current_snapshot_id: "snap", analyzed: false, job_id: "job", status: "succeeded", attempts: 0, max_attempts: 5, available_at: new Date(), leased_until: null, last_error: "skipped: analysis already exists or snapshot is no longer current" }] });
  const db = new PostgresAdapter({ query } as unknown as Pool);
  await expect(db.analysisStatus("repo")).resolves.toMatchObject({ state: "not_requested", lastError: null });
});

it("creates one idempotent index job for every repository newly marked unstarred", async () => {
  const client = { query: vi.fn(async (sql: string) => {
    if (sql === "BEGIN" || sql === "COMMIT" || sql.includes("pg_advisory_xact_lock")) return { rows: [], rowCount: 0 };
    if (sql.startsWith("UPDATE repositories SET unstarred_at")) return { rows: [{ id: "repo-a" }, { id: "repo-b" }], rowCount: 2 };
    if (sql.startsWith("INSERT INTO jobs")) return { rows: [{ id: "job" }], rowCount: 1 };
    throw new Error(`unexpected SQL: ${sql}`);
  }), release: vi.fn() };
  const db = new PostgresAdapter({ connect: vi.fn().mockResolvedValue(client) } as unknown as Pool);
  await expect(db.reconcile("2026-02-03T04:05:06.000Z", [], "reconcile-key")).resolves.toEqual({ upserted: 0, unstarred: 2 });
  const inserts = client.query.mock.calls.filter(([sql]) => String(sql).startsWith("INSERT INTO jobs"));
  expect(inserts).toHaveLength(2);
  expect(inserts[0]?.[1]).toEqual(expect.arrayContaining(["index_repository", "repo-a", "index:unstarred:repo-a:2026-02-03T04:05:06.000Z", { unstarredAt: "2026-02-03T04:05:06.000Z" }]));
  expect(client.query.mock.calls.find(([sql]) => String(sql).startsWith("UPDATE repositories SET unstarred_at"))?.[0]).toContain("RETURNING id");
});

it("queues a base index projection during Stars reconciliation", async () => {
  const client = { query: vi.fn(async (sql: string) => {
    if (sql.includes("INSERT INTO repositories")) return { rows: [{ id: "repo-a" }], rowCount: 1 };
    if (sql.startsWith("INSERT INTO jobs")) return { rows: [{ id: "job" }], rowCount: 1 };
    if (sql.startsWith("UPDATE repositories SET unstarred_at")) return { rows: [], rowCount: 0 };
    return { rows: [], rowCount: 0 };
  }), release: vi.fn() };
  const db = new PostgresAdapter({ connect: vi.fn().mockResolvedValue(client) } as unknown as Pool);
  await db.reconcile("2026-07-14T00:00:00Z", [{ githubId: "123", fullName: "o/r", owner: "o", name: "r", htmlUrl: "https://github.com/o/r", starredAt: "2026-01-01T00:00:00Z" }], "key");
  const insert = client.query.mock.calls.find(([sql]) => String(sql).startsWith("INSERT INTO jobs"))!;
  expect(insert[1]).toEqual(expect.arrayContaining(["index_repository", "repo-a", expect.stringMatching(/^index:base:repo-a:sha256:/), { source: "stars_reconcile" }]));
});

describe("adaptive persistence", () => {
  it("reconcile classifies activity and makes only new or pushed-changed rows immediately due", async () => {
    const calls: Array<[string, unknown[] | undefined]> = [];
    const client = { query: vi.fn(async (sql: string, values?: unknown[]) => { calls.push([sql, values]); return { rowCount: 0, rows: [] }; }), release: vi.fn() };
    const db = new PostgresAdapter({ connect: vi.fn().mockResolvedValue(client) } as unknown as Pool);
    await db.reconcile("2026-07-14T00:00:00Z", [{ githubId: "123", fullName: "o/r", owner: "o", name: "r", htmlUrl: "https://github.com/o/r", pushedAt: "2026-07-10T00:00:00Z", starredAt: "2026-01-01T00:00:00Z" }], "key");
    const upsert = calls.find(([sql]) => sql.includes("INSERT INTO repositories"))!;
    expect(upsert[0]).toContain("repositories.pushed_at IS DISTINCT FROM excluded.pushed_at");
    expect(upsert[1]![22]).toBe("hot");
    expect(upsert[1]![23]).toBe("2026-07-14T00:00:00Z");
  });

  it("lists only due starred repositories in cursor order", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ github_id: "9", full_name: "o/r", readme_etag: '"r"', release_etag: null, next_check_at: new Date("2026-07-14T00:00:00Z") }] });
    const db = new PostgresAdapter({ query } as unknown as Pool);
    await expect(db.dueRepositories("2026-07-14T00:00:00Z", 10, "8")).resolves.toMatchObject({ items: [{ githubId: "9", fullName: "o/r" }], nextCursor: null });
    expect(query.mock.calls[0]![0]).toContain("r.unstarred_at IS NULL AND r.next_check_at<=$1");
  });

  it("reuses current bodies on 304 and advances next_check_at without analysis", async () => {
    const queries: string[] = [];
    const client = { query: vi.fn(async (sql: string) => {
      queries.push(sql);
      if (sql.includes("SELECT r.id,r.full_name")) return { rowCount: 1, rows: [{ id: "repo", full_name: "o/r", activity_class: "hot", current_snapshot_id: "snap", readme_text: "README", readme_etag: '"r"', release_text: "release", release_etag: '"v"' }] };
      if (sql.includes("SELECT id FROM repository_snapshots")) return { rowCount: 1, rows: [{ id: "snap" }] };
      return { rowCount: 1, rows: [] };
    }), release: vi.fn() };
    const pool = { connect: vi.fn().mockResolvedValue(client) } as unknown as Pool;
    const db = new PostgresAdapter(pool);
    const result = await db.refresh("123", { metadata: {}, readme: { status: "not_modified" }, release: { status: "not_modified" }, fetchedAt: "2026-07-14T00:00:00Z" }, "refresh-key");
    expect(result).toMatchObject({ snapshotId: "snap", changed: false, analysisJobId: null });
    expect(queries.some((q) => q.includes("INSERT INTO repository_snapshots"))).toBe(false);
    expect(queries.some((q) => q.includes("next_check_at=$3"))).toBe(true);
  });
});
