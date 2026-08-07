import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { FakeJobs, FakeRepository, FakeSearch } from "../src/fakes.js";

const token = "this-is-a-long-enough-agent-token";
const deps = () => ({ repositories: new FakeRepository(), jobs: new FakeJobs(), search: new FakeSearch(), agentToken: token });
describe("platform API contract", () => {
  it("reports health and readiness", async () => { const app = buildApp(deps()); expect((await app.inject({ url: "/healthz" })).statusCode).toBe(200); expect((await app.inject({ url: "/readyz" })).json()).toEqual({ status: "ready" }); });
  it("returns stable paginated public results", async () => { const app = buildApp(deps()); const r = await app.inject({ url: "/api/v1/projects" }); expect(r.statusCode).toBe(200); expect(r.json()).toEqual({ items: [], page: 1, pageSize: 20, total: 0 }); });
  it("returns public synchronization and analysis progress", async () => { const app = buildApp(deps()); const r = await app.inject({ url: "/api/v1/stats" }); expect(r.statusCode).toBe(200); expect(r.json()).toEqual({ totalStars: 0, syncedRepositories: 0, analyzedRepositories: 0, pendingAnalysis: 0, updatedAt: null }); });
  it("protects control runs and deduplicates active operations", async () => {
    const d = { ...deps(), adminToken: "admin-token-1234567890123456" }; const app = buildApp(d);
    expect((await app.inject({ method: "POST", url: "/api/v1/admin/runs", payload: { operation: "sync" } })).statusCode).toBe(401);
    const headers = { authorization: `Bearer ${d.adminToken}` };
    const first = await app.inject({ method: "POST", url: "/api/v1/admin/runs", headers, payload: { operation: "sync" } });
    const second = await app.inject({ method: "POST", url: "/api/v1/admin/runs", headers, payload: { operation: "sync" } });
    expect(first.statusCode).toBe(202); expect(second.json().id).toBe(first.json().id);
    expect((await app.inject({ url: "/api/v1/admin/runs", headers })).json().items).toHaveLength(1);
  });
  it("protects and exposes active jobs, queue summary, and bounded recent failures", async () => {
    const d = { ...deps(), adminToken: "admin-token-1234567890123456" };
    d.jobs.active = [{ id: "11111111-1111-4111-8111-111111111111", type: "analyze_repository", status: "running", repositoryId: "22222222-2222-4222-8222-222222222222", fullName: "owner/repo", priority: 100, attempts: 1, maxAttempts: 5, workerId: "curator-1", startedAt: "2026-07-16T00:00:00.000Z", lastHeartbeatAt: "2026-07-16T00:00:00.000Z", leasedUntil: "2026-07-16T00:30:00.000Z", runId: "run-1", sandboxId: "sandbox-1" }];
    const app = buildApp(d); const headers = { authorization: `Bearer ${d.adminToken}` };
    expect((await app.inject({ url: "/api/v1/admin/jobs/active" })).statusCode).toBe(401);
    expect((await app.inject({ url: "/api/v1/admin/jobs/active", headers })).json()).toEqual({ items: d.jobs.active });
    expect((await app.inject({ url: "/api/v1/admin/jobs/summary", headers })).json()).toMatchObject({ counts: {}, oldestPendingAt: null });
    expect((await app.inject({ url: "/api/v1/admin/jobs/recent-failures?limit=101", headers })).statusCode).toBe(400);
  });
  it("protects and exposes bounded agent-compose runs", async () => {
    const agentRuns = { list: async () => [{ id: "a".repeat(64), agentName: "star-curator", triggerId: "curate", source: "cron" as const, status: "running" as const, startedAt: "2026-07-16T00:00:00Z", completedAt: null, durationMs: null, sandboxId: null, summary: null, error: null }], logs: async () => "bounded log" };
    const d = { ...deps(), agentRuns, adminToken: "admin-token-1234567890123456" }; const app = buildApp(d); const headers = { authorization: `Bearer ${d.adminToken}` };
    expect((await app.inject({ url: "/api/v1/admin/agent-runs" })).statusCode).toBe(401); expect((await app.inject({ url: "/api/v1/admin/agent-runs?limit=101", headers })).statusCode).toBe(400);
    expect((await app.inject({ url: "/api/v1/admin/agent-runs?limit=10", headers })).json()).toMatchObject({ source: "agent-compose", items: [{ source: "cron", status: "running" }] });
    const logs = await app.inject({ url: `/api/v1/admin/agent-runs/${"a".repeat(64)}/logs?tail=200`, headers }); expect(logs.body).toBe("bounded log"); expect((await app.inject({ url: "/api/v1/admin/agent-runs/not-an-id/logs", headers })).statusCode).toBe(400);
  });
  it("reports an unconfigured bridge", async () => { const d = { ...deps(), adminToken: "admin-token-1234567890123456" }; const response = await buildApp(d).inject({ url: "/api/v1/admin/agent-runs", headers: { authorization: `Bearer ${d.adminToken}` } }); expect(response.statusCode).toBe(503); expect(response.json()).toMatchObject({ error: { code: "AGENT_COMPOSE_UNAVAILABLE", retryable: true } }); });
  it("prioritizes one project analysis without creating a competing control run", async () => {
    const d = { ...deps(), adminToken: "admin-token-1234567890123456" }; const app = buildApp(d); const id = "11111111-1111-4111-8111-111111111111";
    const response = await app.inject({ method: "POST", url: `/api/v1/admin/projects/${id}/analyze`, headers: { authorization: `Bearer ${d.adminToken}` }, payload: {} });
    expect(response.statusCode).toBe(202); expect(response.json()).toMatchObject({ status: "queued", jobId: expect.any(String) }); expect(response.json()).not.toHaveProperty("run");
    expect(d.jobs.operations).toContainEqual({ operation: "prioritize-analysis", repositoryId: id });
    const status = await app.inject({ url: `/api/v1/admin/projects/${id}/analysis-status`, headers: { authorization: `Bearer ${d.adminToken}` } });
    expect(status.json()).toMatchObject({ repositoryId: id, state: "queued", attempts: 0, maxAttempts: 5 });
  });
  it("validates query and uses contract error envelope", async () => { const app = buildApp(deps()); const r = await app.inject({ url: "/api/v1/search?q=" }); expect(r.statusCode).toBe(400); expect(r.json()).toMatchObject({ error: { code: "VALIDATION_ERROR", retryable: false } }); });
  it("protects internal APIs", async () => { const app = buildApp(deps()); const r = await app.inject({ method: "POST", url: "/internal/v1/jobs/claim", payload: {} }); expect(r.statusCode).toBe(401); expect(r.json().error.code).toBe("UNAUTHORIZED"); });
  it("reconciles missing analysis jobs through the protected API", async () => { const d = deps(); const app = buildApp(d); const r = await app.inject({ method: "POST", url: "/internal/v1/jobs/reconcile-analysis", headers: { authorization: `Bearer ${token}`, "idempotency-key": "reconcile-1" }, payload: { limit: 500 } }); expect(r.statusCode).toBe(200); expect(r.json()).toEqual({ created: 0, revived: 0, remaining: 0 }); expect(d.jobs.operations).toContainEqual({ operation: "reconcile-analysis", limit: 500, key: "reconcile-1" }); });
  it("requires idempotency key before writes", async () => { const app = buildApp(deps()); const payload = { observedAt: "2026-07-14T00:00:00Z", repositories: [] }; const r = await app.inject({ method: "POST", url: "/internal/v1/github/stars/reconcile", headers: { authorization: `Bearer ${token}` }, payload }); expect(r.statusCode).toBe(400); expect(r.json().error.code).toBe("IDEMPOTENCY_KEY_REQUIRED"); });
  it("accepts a valid full-star reconciliation", async () => { const d = deps(); const app = buildApp(d); const r = await app.inject({ method: "POST", url: "/internal/v1/github/stars/reconcile", headers: { authorization: `Bearer ${token}`, "idempotency-key": "reconcile-20260714" }, payload: { observedAt: "2026-07-14T00:00:00Z", repositories: [{ githubId: "9007199254740993", fullName: "owner/repo", owner: "owner", name: "repo", htmlUrl: "https://github.com/owner/repo", starredAt: "2026-07-13T00:00:00Z" }] } }); expect(r.statusCode).toBe(200); expect(r.json()).toEqual({ upserted: 1, unstarred: 0 }); expect(d.repositories.reconciliations).toHaveLength(1); });
  it("accepts a reconciliation larger than Fastify's default body limit", async () => { const app = buildApp(deps()); const r = await app.inject({ method: "POST", url: "/internal/v1/github/stars/reconcile", headers: { authorization: `Bearer ${token}`, "idempotency-key": "reconcile-large-payload" }, payload: { observedAt: "2026-07-14T00:00:00Z", repositories: [{ githubId: "1", fullName: "owner/large", owner: "owner", name: "large", htmlUrl: "https://github.com/owner/large", description: "x".repeat(1_100_000), starredAt: "2026-07-13T00:00:00Z" }] } }); expect(r.statusCode).toBe(200); });
  it("returns protected due repositories with stable fields", async () => { const d = deps(); d.repositories.due = [{ githubId: "123", fullName: "owner/repo", readmeEtag: '"r"', releaseEtag: null, nextCheckAt: "2026-07-14T00:00:00.000Z" }]; const app = buildApp(d); expect((await app.inject({ url: "/internal/v1/repositories/due" })).statusCode).toBe(401); const r = await app.inject({ url: "/internal/v1/repositories/due?asOf=2026-07-14T00:00:00Z&limit=10", headers: { authorization: `Bearer ${token}` } }); expect(r.statusCode).toBe(200); expect(r.json()).toEqual({ items: d.repositories.due, nextCursor: null }); });
  it("accepts explicit conditional refresh states", async () => { const app = buildApp(deps()); const r = await app.inject({ method: "POST", url: "/internal/v1/repositories/123/refresh", headers: { authorization: `Bearer ${token}`, "idempotency-key": "refresh-123-20260714" }, payload: { metadata: {}, readme: { status: "not_modified" }, release: { status: "missing" }, fetchedAt: "2026-07-14T00:00:00Z" } }); expect(r.statusCode).toBe(200); expect(r.json()).toMatchObject({ changed: true, nextCheckAt: "1970-01-01T00:00:00.000Z" }); });
  it("requires starredAt because persistence does", async () => { const app = buildApp(deps()); const r = await app.inject({ method: "POST", url: "/internal/v1/github/stars/reconcile", headers: { authorization: `Bearer ${token}`, "idempotency-key": "reconcile-no-starred" }, payload: { observedAt: "2026-07-14T00:00:00Z", repositories: [{ githubId: "1", fullName: "owner/repo", owner: "owner", name: "repo", htmlUrl: "https://github.com/owner/repo" }] } }); expect(r.statusCode).toBe(400); expect(r.json().error.code).toBe("VALIDATION_ERROR"); });
  it("limits search agent candidate count", async () => { const app = buildApp(deps()); const r = await app.inject({ method: "POST", url: "/internal/v1/search/projects", headers: { authorization: `Bearer ${token}` }, payload: { query: "git diff", limit: 21 } }); expect(r.statusCode).toBe(400); });
  it("creates a bounded agent run and exposes status plus replayable SSE", async () => {
    const d = deps(); const project = { id: "11111111-1111-4111-8111-111111111111", githubId: "1", fullName: "dandavison/delta", owner: "dandavison", name: "delta", htmlUrl: "https://github.com/dandavison/delta", description: "diff pager", primaryLanguage: "Rust", topics: ["git"], licenseSpdx: "MIT", starsCount: 1, forksCount: 0, openIssuesCount: 0, pushedAt: "2026-07-01T00:00:00Z", githubUpdatedAt: "2026-07-01T00:00:00Z", starredAt: "2026-01-01T00:00:00Z", unstarredAt: null, archived: false, activityClass: "hot", updatedAt: "2026-07-01T00:00:00Z", analysis: { summaryZh: "改善 git diff 可读性", categories: ["Git 工具"], keywords: ["diff"], aliases: [], useCases: [], problemsSolved: [], targetUsers: [], technologies: ["Rust"], limitations: [], confidence: .9 } };
    d.repositories.projects = [project]; d.search.result = { items: [{ project, matchedFields: ["summary_zh"], highlights: {}, dataUpdatedAt: project.updatedAt }], page: 1, pageSize: 20, total: 1, indexVersion: "repositories_v1" };
    const app = buildApp(d); const created = await app.inject({ method: "POST", url: "/api/v1/agent/search", payload: { query: "让 git diff 更好看" } });
    expect(created.statusCode).toBe(202); expect(created.json()).toMatchObject({ status: "running" });
    await new Promise((resolve) => setImmediate(resolve)); const id = created.json().runId;
    const status = await app.inject({ url: `/api/v1/agent/search/${id}` }); expect(status.json()).toMatchObject({ status: "completed", answer: { confidence: expect.any(Number), recommendations: [{ project: { fullName: "dandavison/delta" } }] } });
    const events = await app.inject({ url: `/api/v1/agent/search/${id}/events` }); expect(events.headers["content-type"]).toContain("text/event-stream"); expect(events.body).toContain("event: search.completed"); expect(events.body).toContain("event: answer.completed");
  });
  it("returns claimed jobs with frozen top-level shape", async () => { const d = deps(); d.jobs.jobs = [{ id: "11111111-1111-4111-8111-111111111111", type: "analyze_repository", repositoryId: "22222222-2222-4222-8222-222222222222", attempts: 1, leasedUntil: "2026-07-14T01:00:00Z", payload: { snapshotId: "33333333-3333-4333-8333-333333333333", contentHash: `sha256:${"a".repeat(64)}`, fullName: "owner/repo", metadata: {}, readmeText: "README", releaseText: null } }]; const app = buildApp(d); const r = await app.inject({ method: "POST", url: "/internal/v1/jobs/claim", headers: { authorization: `Bearer ${token}` }, payload: { types: ["analyze_repository"], workerId: "curator-1", limit: 1, leaseSeconds: 1800 } }); expect(r.statusCode).toBe(200); expect(r.json().jobs[0]).toMatchObject({ id: d.jobs.jobs[0]!.id, type: "analyze_repository", repositoryId: d.jobs.jobs[0]!.repositoryId, attempts: 1, payload: { fullName: "owner/repo", readmeText: "README" } }); });
  it("accepts a minimum priority boundary for dedicated click workers", async () => { const d = deps(); const app = buildApp(d); const response = await app.inject({ method: "POST", url: "/internal/v1/jobs/claim", headers: { authorization: `Bearer ${token}` }, payload: { types: ["analyze_repository"], workerId: "priority-curator", limit: 1, leaseSeconds: 1800, minPriority: 100 } }); expect(response.statusCode).toBe(200); });
  it("renews a job lease through the authenticated heartbeat endpoint", async () => { const d = deps(); const app = buildApp(d); const id = "11111111-1111-4111-8111-111111111111"; const response = await app.inject({ method: "POST", url: `/internal/v1/jobs/${id}/heartbeat`, headers: { authorization: `Bearer ${token}`, "idempotency-key": "heartbeat-1" }, payload: { workerId: "curator-1", leaseSeconds: 300, sandboxId: "sandbox-1" } }); expect(response.statusCode).toBe(200); expect(response.json()).toHaveProperty("leasedUntil"); expect(d.jobs.operations).toContainEqual({ operation: "heartbeat", id, workerId: "curator-1", leaseSeconds: 300, key: "heartbeat-1" }); });
  it("exposes only controlled operational job statuses", async () => {
    const app = buildApp(deps());
    const headers = { authorization: `Bearer ${token}` };
    expect((await app.inject({ url: "/internal/v1/jobs?status=dead", headers })).statusCode).toBe(200);
    expect((await app.inject({ url: "/internal/v1/jobs?status=pending", headers })).statusCode).toBe(400);
    expect((await app.inject({ url: "/internal/v1/jobs", headers })).statusCode).toBe(400);
  });
  it("queues idempotent manual recovery operations", async () => {
    const d = deps(); const app = buildApp(d); const id = "11111111-1111-4111-8111-111111111111";
    const headers = { authorization: `Bearer ${token}`, "idempotency-key": "manual-operation-1" };
    const retry = await app.inject({ method: "POST", url: `/internal/v1/jobs/${id}/retry`, headers });
    const recollect = await app.inject({ method: "POST", url: `/internal/v1/projects/${id}/recollect`, headers });
    const reanalyze = await app.inject({ method: "POST", url: `/internal/v1/projects/${id}/reanalyze`, headers, payload: { analysisVersion: "v2" } });
    expect([retry.statusCode, recollect.statusCode, reanalyze.statusCode]).toEqual([200, 200, 200]);
    expect(recollect.json()).toEqual({ repositoryId: id, scheduled: true, nextCheckAt: "2026-07-15T00:00:00.000Z" });
    expect(d.jobs.operations).toEqual([
      { operation: "retry", id, key: "manual-operation-1" },
      { operation: "recollect", repositoryId: id, key: "manual-operation-1" },
      { operation: "reanalyze", repositoryId: id, analysisVersion: "v2", key: "manual-operation-1" },
    ]);
  });
  it("records bounded query feedback for offline evaluation", async () => {
    const d = deps(); const app = buildApp(d);
    const payload = { queryId: "11111111-1111-4111-8111-111111111111", queryText: "git diff 工具", resultRepositoryIds: [], rating: 1, action: "helpful", metadata: { source: "test" } };
    const response = await app.inject({ method: "POST", url: "/api/v1/feedback", payload });
    expect(response.statusCode).toBe(201);
    expect(d.jobs.operations).toContainEqual({ operation: "feedback", input: payload });
  });
  it("protects and records index consistency checks", async () => {
    const d = { ...deps(), adminToken: "admin-token-1234567890123456" }; const app = buildApp(d);
    expect((await app.inject({ url: "/api/v1/admin/operations/status" })).statusCode).toBe(401);
    const response = await app.inject({ url: "/api/v1/admin/operations/status", headers: { authorization: `Bearer ${d.adminToken}` } });
    expect(response.statusCode).toBe(200); expect(response.json()).toMatchObject({ consistent: true, repositories: { starred: 0 }, githubSync: { healthy: false, staleAfterHours: 26 }, index: { documents: 0 } });
  });
  it("persists and exposes GitHub Stars sync lifecycle", async () => {
    const d = { ...deps(), adminToken: "admin-token-1234567890123456" }; const app = buildApp(d);
    const id = "11111111-1111-4111-8111-111111111111";
    const agentHeaders = { authorization: `Bearer ${token}`, "idempotency-key": "sync-run-1" };
    expect((await app.inject({ method: "POST", url: "/internal/v1/github/stars/sync-runs", headers: agentHeaders, payload: { id, source: "daily", startedAt: "2026-07-23T00:00:00Z" } })).statusCode).toBe(201);
    expect((await app.inject({ method: "POST", url: `/internal/v1/github/stars/sync-runs/${id}/complete`, headers: agentHeaders, payload: { observedAt: "2026-07-23T00:01:00Z", result: { reconciled: 5071 } } })).statusCode).toBe(200);
    const status = await app.inject({ url: "/api/v1/admin/github-sync/status", headers: { authorization: `Bearer ${d.adminToken}` } });
    expect(status.statusCode).toBe(200); expect(status.json()).toMatchObject({ healthy: false, staleAfterHours: 26 });
    expect(d.jobs.operations).toContainEqual({ operation: "github-sync-start", id, source: "daily", startedAt: "2026-07-23T00:00:00Z" });
    expect(d.jobs.operations).toContainEqual({ operation: "github-sync-complete", id, observedAt: "2026-07-23T00:01:00Z", result: { reconciled: 5071 } });
  });
});
