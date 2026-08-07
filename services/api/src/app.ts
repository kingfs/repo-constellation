import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { ZodError } from "zod";
import type { Dependencies } from "./adapters.js";
import * as s from "./schemas.js";
import { PassThrough } from "node:stream";
import { BoundedSearchAgent } from "./search-agent.js";

const error = (code: string, message: string, retryable = false) => ({ error: { code, message, retryable } });
function idempotency(request: FastifyRequest): string {
  const key = request.headers["idempotency-key"];
  if (typeof key !== "string" || key.length < 8 || key.length > 200) throw Object.assign(new Error("Idempotency-Key is required (8-200 characters)"), { statusCode: 400, code: "IDEMPOTENCY_KEY_REQUIRED" });
  return key;
}

export function buildApp(deps: Dependencies, logger: boolean | object = false): FastifyInstance {
  const app = Fastify({ logger });
  const agentSearch = deps.agentSearch ?? new BoundedSearchAgent(deps.search, deps.repositories);
  app.setErrorHandler((cause, _request, reply) => {
    if (cause instanceof ZodError) return reply.status(400).send(error("VALIDATION_ERROR", cause.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")));
    const e = cause as Error & { statusCode?: number; code?: string; retryable?: boolean };
    const status = e.statusCode ?? 500;
    return reply.status(status).send(error(e.code ?? (status === 500 ? "INTERNAL_ERROR" : "REQUEST_ERROR"), status === 500 ? "internal server error" : e.message, e.retryable ?? status >= 500));
  });
  app.addHook("onResponse", async (request, reply) => {
    deps.metrics?.increment("platform_http_requests_total", { method: request.method, route: request.routeOptions.url ?? "unknown", status: String(reply.statusCode) });
  });
  app.get("/healthz", async () => ({ status: "ok" }));
  app.get("/readyz", async (_req, reply) => {
    try { await Promise.all([deps.repositories.ping(), deps.search.ping()]); return { status: "ready" }; }
    catch { return reply.status(503).send(error("NOT_READY", "dependencies are unavailable", true)); }
  });
  app.addHook("onRequest", async (request, reply) => {
    if (request.url.startsWith("/api/v1/admin/")) {
      if (!deps.adminToken || request.headers.authorization !== `Bearer ${deps.adminToken}`) return reply.status(401).send(error("UNAUTHORIZED", "valid admin bearer token required"));
      return;
    }
    if (!request.url.startsWith("/internal/")) return;
    if (request.headers.authorization !== `Bearer ${deps.agentToken}`) return reply.status(401).send(error("UNAUTHORIZED", "valid agent bearer token required"));
  });

  app.get("/api/v1/projects", async (req) => deps.repositories.list(s.parse(s.projectQuery, req.query)));
  app.get("/api/v1/projects/:id", async (req, reply) => {
    const id = s.parse(s.uuid, (req.params as { id?: string }).id);
    const project = await deps.repositories.get(id); return project ?? reply.status(404).send(error("PROJECT_NOT_FOUND", "project not found"));
  });
  app.get("/api/v1/search", async (req) => { const q = s.parse(s.searchQuery, req.query); return deps.search.search({ ...q, query: q.q }); });
  app.get("/api/v1/updates", async (req) => { const q = s.parse(s.updatesQuery, req.query); const items = await deps.repositories.updates(q.since, q.limit); return { items, page: 1, pageSize: q.limit, total: items.length }; });
  app.get("/api/v1/categories", async () => ({ items: await deps.repositories.categories() }));
  app.get("/api/v1/stats", async () => deps.repositories.stats());
  app.get("/api/v1/admin/runs", async () => ({ items: await deps.jobs.listControlRuns(30) }));
  app.get("/api/v1/admin/jobs/active", async () => ({ items: await deps.jobs.activeJobs() }));
  app.get("/api/v1/admin/jobs/summary", async () => deps.jobs.jobSummary());
  app.get("/api/v1/admin/jobs/recent-failures", async (req) => ({ items: await deps.jobs.recentJobFailures(s.parse(s.recentFailuresQuery, req.query).limit) }));
  app.get("/api/v1/admin/agent-runs", async (req) => {
    if (!deps.agentRuns) throw Object.assign(new Error("agent-compose bridge is not configured"), { statusCode: 503, code: "AGENT_COMPOSE_UNAVAILABLE", retryable: true });
    const query = s.parse(s.agentRunsQuery, req.query); return { items: await deps.agentRuns.list(query.limit), source: "agent-compose" };
  });
  app.get("/api/v1/admin/agent-runs/:id/logs", async (req, reply) => {
    if (!deps.agentRuns) throw Object.assign(new Error("agent-compose bridge is not configured"), { statusCode: 503, code: "AGENT_COMPOSE_UNAVAILABLE", retryable: true });
    const id = s.parse(s.agentRunId, (req.params as { id: string }).id); const query = s.parse(s.agentRunLogsQuery, req.query);
    return reply.type("text/plain; charset=utf-8").send(await deps.agentRuns.logs(id, query.tail));
  });
  app.get("/api/v1/admin/metrics", async (_req, reply) => reply.type("text/plain; version=0.0.4").send(deps.metrics?.render() ?? ""));
  app.get("/api/v1/admin/operations/status", async () => {
    const [counts, documents, githubSync] = await Promise.all([deps.jobs.operationalCounts(), deps.search.documentCount(), deps.jobs.githubSyncStatus()]);
    const checkedAt = new Date().toISOString(); const consistent = counts.repositories.starred === documents;
    const summary = { ...counts, githubSync, index: { documents }, consistent, checkedAt };
    await deps.jobs.recordOperationalCheck(consistent ? "passed" : "failed", summary);
    deps.metrics?.increment("platform_consistency_checks_total", { status: consistent ? "passed" : "failed" });
    return summary;
  });
  app.get("/api/v1/admin/github-sync/status", async () => deps.jobs.githubSyncStatus());
  app.post("/api/v1/admin/runs", async (req, reply) => { const body = s.parse(s.controlRunBody, req.body); return reply.status(202).send(await deps.jobs.createControlRun(body.operation)); });
  app.post("/api/v1/admin/projects/:id/analyze", async (req, reply) => { const id = s.parse(s.uuid, (req.params as { id: string }).id); return reply.status(202).send(await deps.jobs.prioritizeAnalysis(id)); });
  app.get("/api/v1/admin/projects/:id/analysis-status", async (req) => { const id = s.parse(s.uuid, (req.params as { id: string }).id); return deps.jobs.analysisStatus(id); });
  app.post("/api/v1/agent/search", async (req, reply) => {
    const body = s.parse(s.agentSearchBody, req.body); const run = await agentSearch.start(body.query);
    return reply.status(202).send({ runId: run.id, status: run.status, eventsUrl: `/api/v1/agent/search/${run.id}/events` });
  });
  app.post("/api/v1/feedback", async (req, reply) => {
    const feedback = await deps.jobs.saveFeedback(s.parse(s.feedbackBody, req.body));
    deps.metrics?.increment("platform_query_feedback_total");
    return reply.status(201).send(feedback);
  });
  app.get("/api/v1/agent/search/:runId", async (req, reply) => {
    const id = s.parse(s.uuid, (req.params as { runId: string }).runId); const run = await agentSearch.get(id);
    if (!run) return reply.status(404).send(error("AGENT_RUN_NOT_FOUND", "agent search run not found"));
    return { runId: run.id, query: run.query, status: run.status, createdAt: run.createdAt, completedAt: run.completedAt, answer: run.answer, error: run.error };
  });
  app.get("/api/v1/agent/search/:runId/events", async (req, reply) => {
    const id = s.parse(s.uuid, (req.params as { runId: string }).runId); const run = await agentSearch.get(id);
    if (!run) return reply.status(404).send(error("AGENT_RUN_NOT_FOUND", "agent search run not found"));
    const stream = new PassThrough();
    let lastEventId = 0;
    const write = (event: typeof run.events[number]) => {
      if (event.id <= lastEventId) return;
      lastEventId = event.id;
      stream.write(`id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    };
    const unsubscribe = run.status === "running" ? agentSearch.subscribe(id, (event) => {
      write(event);
      if (event.type === "answer.completed" || event.type === "run.failed") { unsubscribe?.(); stream.end(); }
    }) : undefined;
    run.events.forEach(write);
    if (run.status !== "running") { unsubscribe?.(); stream.end(); }
    stream.on("close", () => unsubscribe?.());
    reply.header("Cache-Control", "no-cache, no-transform").header("Connection", "keep-alive").type("text/event-stream; charset=utf-8");
    return reply.send(stream);
  });

  app.post("/internal/v1/github/stars/reconcile", { bodyLimit: 64 * 1024 * 1024 }, async (req) => { const body = s.parse(s.reconcileBody, req.body); return deps.repositories.reconcile(body.observedAt, body.repositories, idempotency(req)); });
  app.post("/internal/v1/github/stars/sync-runs", async (req, reply) => { const body = s.parse(s.githubSyncStartBody, req.body); await deps.jobs.startGithubSync(body.id, body.source, body.startedAt); return reply.status(201).send({ runId: body.id, status: "running" }); });
  app.post("/internal/v1/github/stars/sync-runs/:id/complete", async (req) => { const id = s.parse(s.uuid, (req.params as { id: string }).id); const body = s.parse(s.githubSyncCompleteBody, req.body); await deps.jobs.completeGithubSync(id, body.observedAt, body.result); return { runId: id, status: "succeeded" }; });
  app.post("/internal/v1/github/stars/sync-runs/:id/fail", async (req) => { const id = s.parse(s.uuid, (req.params as { id: string }).id); const body = s.parse(s.githubSyncFailBody, req.body); await deps.jobs.failGithubSync(id, body.error); return { runId: id, status: "failed" }; });
  app.get("/internal/v1/repositories/due", async (req) => { const q = s.parse(s.dueQuery, req.query); return deps.repositories.dueRepositories(q.asOf ?? new Date().toISOString(), q.limit, q.cursor); });
  app.post("/internal/v1/repositories/:githubId/refresh", async (req) => { const githubId = s.parse(s.z.string().regex(/^\d+$/), (req.params as { githubId: string }).githubId); return deps.repositories.refresh(githubId, s.parse(s.refreshBody, req.body), idempotency(req)); });
  app.post("/internal/v1/repositories/:githubId/snapshots", async (req) => { const githubId = s.parse(s.z.string().regex(/^\d+$/), (req.params as { githubId: string }).githubId); return deps.repositories.saveSnapshot(githubId, s.parse(s.snapshotBody, req.body), idempotency(req)); });
  app.post("/internal/v1/jobs/claim", async (req) => { const b = s.parse(s.claimBody, req.body); return { jobs: await deps.jobs.claim(b.types, b.workerId, b.limit, b.leaseSeconds, b.minPriority, { runId: b.runId, sandboxId: b.sandboxId }) }; });
  app.post("/internal/v1/jobs/:id/heartbeat", async (req) => { const id = s.parse(s.uuid, (req.params as { id: string }).id); const b = s.parse(s.heartbeatBody, req.body); return deps.jobs.heartbeat(id, b.workerId, b.leaseSeconds, idempotency(req), { runId: b.runId, sandboxId: b.sandboxId }); });
  app.post("/internal/v1/jobs/:id/complete", async (req) => { const id = s.parse(s.uuid, (req.params as { id: string }).id); const b = s.parse(s.completeBody, req.body); await deps.jobs.complete(id, b.workerId, idempotency(req), { runId: b.runId, sandboxId: b.sandboxId }); return { completed: true }; });
  app.post("/internal/v1/jobs/:id/fail", async (req) => { const id = s.parse(s.uuid, (req.params as { id: string }).id); const b = s.parse(s.failBody, req.body); await deps.jobs.fail(id, b.workerId, b.error, b.retryable, idempotency(req), { runId: b.runId, sandboxId: b.sandboxId }); return { failed: true }; });
  app.post("/internal/v1/jobs/reconcile-analysis", async (req) => { const body = s.parse(s.reconcileAnalysisBody, req.body); return deps.jobs.reconcileAnalysisQueue(body.limit, idempotency(req)); });
  app.post("/internal/v1/control-runs/claim", async (req) => { const b = s.parse(s.controlClaimBody, req.body); return { run: await deps.jobs.claimControlRun(b.operation, b.workerId, b.leaseSeconds) }; });
  app.post("/internal/v1/control-runs/:id/complete", async (req) => { const id = s.parse(s.uuid, (req.params as { id: string }).id); const b = s.parse(s.controlCompleteBody, req.body); await deps.jobs.completeControlRun(id, b.workerId, b.result); return { completed: true }; });
  app.post("/internal/v1/control-runs/:id/fail", async (req) => { const id = s.parse(s.uuid, (req.params as { id: string }).id); const b = s.parse(s.controlFailBody, req.body); await deps.jobs.failControlRun(id, b.workerId, b.error); return { failed: true }; });
  app.get("/internal/v1/jobs", async (req) => deps.jobs.listOperational(s.parse(s.operationalJobsQuery, req.query)));
  app.post("/internal/v1/jobs/:id/retry", async (req) => { const id = s.parse(s.uuid, (req.params as { id: string }).id); return deps.jobs.retry(id, idempotency(req)); });
  app.post("/internal/v1/projects/:id/recollect", async (req) => { const id = s.parse(s.uuid, (req.params as { id: string }).id); return deps.jobs.recollect(id, idempotency(req)); });
  app.post("/internal/v1/projects/:id/reanalyze", async (req) => { const id = s.parse(s.uuid, (req.params as { id: string }).id); const body = s.parse(s.reanalyzeBody, req.body); return deps.jobs.reanalyze(id, body.analysisVersion, idempotency(req)); });
  app.post("/internal/v1/repositories/:repositoryId/analyses", async (req) => { const id = s.parse(s.uuid, (req.params as { repositoryId: string }).repositoryId); return deps.repositories.saveAnalysis(id, s.parse(s.analysisBody, req.body), idempotency(req)); });

  app.post("/internal/v1/search/projects", async (req) => { const b = s.parse(s.toolSearchBody, req.body); return deps.search.search({ query: b.query, category: b.filters.category, language: b.filters.language, activity: b.filters.activity, sort: b.sort, page: 1, pageSize: b.limit }); });
  app.post("/internal/v1/projects/batch-get", async (req) => { const b = s.parse(s.batchBody, req.body); return { items: await deps.repositories.getMany(b.ids) }; });
  app.get("/internal/v1/projects/:id/readme", async (req, reply) => { const id = s.parse(s.uuid, (req.params as { id: string }).id); const maxChars = s.parse(s.z.coerce.number().int().min(100).max(50_000).default(20_000), (req.query as { maxChars?: unknown }).maxChars); const result = await deps.repositories.readme(id, maxChars); return result ?? reply.status(404).send(error("PROJECT_NOT_FOUND", "project or README not found")); });
  app.post("/internal/v1/projects/compare", async (req) => { const b = s.parse(s.compareBody, req.body); return { items: await deps.repositories.getMany(b.ids), dataUpdatedAt: new Date().toISOString() }; });
  return app;
}
