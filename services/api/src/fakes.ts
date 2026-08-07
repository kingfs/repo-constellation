import type { JobAdapter, RepositoryAdapter, SearchAdapter } from "./adapters.js";
import type { ActiveJob, AnalysisInput, ClaimedJob, ControlOperation, ControlRun, DueRepository, OperationalJob, Page, Project, ProjectQuery, RecentJobFailure, RefreshInput, SearchPage, SearchQuery, SnapshotInput, StarInput } from "./domain.js";
export class FakeRepository implements RepositoryAdapter {
  projects: Project[] = []; reconciliations: unknown[] = []; due: DueRepository[] = [];
  async ping() {} async list(q: ProjectQuery): Promise<Page<Project>> { return { items: this.projects, page: q.page, pageSize: q.pageSize, total: this.projects.length }; }
  async get(id: string) { return this.projects.find((p) => p.id === id) ?? null; } async getMany(ids: string[]) { return ids.flatMap((id) => this.projects.filter((p) => p.id === id)); }
  async updates(_since: string, limit: number) { return this.projects.slice(0, limit); } async categories() { return [{ name: "Git 工具", count: 1 }]; }
  async readme(id: string, max: number) { return this.projects.some((p) => p.id === id) ? { text: "readme".slice(0, max), truncated: false, dataUpdatedAt: new Date(0).toISOString() } : null; }
  async stats() { const analyzed = this.projects.filter((project) => project.analysis != null).length; return { totalStars: this.projects.length, syncedRepositories: this.projects.length, analyzedRepositories: analyzed, pendingAnalysis: this.projects.length - analyzed, updatedAt: this.projects[0]?.updatedAt ?? null }; }
  async reconcile(observedAt: string, repositories: StarInput[], key: string) { this.reconciliations.push({ observedAt, repositories, key }); return { upserted: repositories.length, unstarred: 0 }; }
  async dueRepositories(_asOf: string, limit: number, cursor?: string) { const items = this.due.filter((x) => !cursor || BigInt(x.githubId) > BigInt(cursor)).slice(0, limit); return { items, nextCursor: items.length === limit ? items.at(-1)!.githubId : null }; }
  async refresh(_id: string, _input: RefreshInput, _key: string) { return { snapshotId: "11111111-1111-4111-8111-111111111111", changed: true, analysisJobId: "22222222-2222-4222-8222-222222222222", nextCheckAt: new Date(0).toISOString() }; }
  async saveSnapshot(_id: string, _input: SnapshotInput, _key: string) { return { snapshotId: "11111111-1111-4111-8111-111111111111", changed: true, analysisJobId: "22222222-2222-4222-8222-222222222222" }; }
  async saveAnalysis(_id: string, _input: AnalysisInput, _key: string) { return { analysisId: "33333333-3333-4333-8333-333333333333", indexJobId: "44444444-4444-4444-8444-444444444444" }; }
}
export class FakeJobs implements JobAdapter {
  jobs: ClaimedJob[] = []; operationalJobs: OperationalJob[] = []; operations: unknown[] = []; controlRuns: ControlRun[] = [];
  active: ActiveJob[] = []; failures: RecentJobFailure[] = [];
  async acquireIndexLock() { return async () => {}; }
  async claim() { return this.jobs; } async heartbeat(id: string, workerId: string, leaseSeconds: number, key: string) { this.operations.push({ operation: "heartbeat", id, workerId, leaseSeconds, key }); return { leasedUntil: new Date(Date.now() + leaseSeconds * 1000).toISOString() }; } async complete() {} async fail() {}
  async activeJobs() { return this.active; }
  async jobSummary() { return { counts: {}, oldestPendingAt: null, checkedAt: new Date(0).toISOString() }; }
  async recentJobFailures(limit: number) { return this.failures.slice(0, limit); }
  async reconcileAnalysisQueue(limit: number, key: string) { this.operations.push({ operation: "reconcile-analysis", limit, key }); return { created: 0, revived: 0, remaining: 0 }; }
  async listOperational(q: { page: number; pageSize: number; status: string }) { const items = this.operationalJobs.filter((job) => job.status === q.status); return { items, page: q.page, pageSize: q.pageSize, total: items.length }; }
  async retry(id: string, key: string) { this.operations.push({ operation: "retry", id, key }); return { jobId: id, status: "pending", retried: true }; }
  async recollect(repositoryId: string, key: string) { this.operations.push({ operation: "recollect", repositoryId, key }); return { repositoryId, scheduled: true as const, nextCheckAt: "2026-07-15T00:00:00.000Z" }; }
  async reanalyze(repositoryId: string, analysisVersion: string, key: string) { this.operations.push({ operation: "reanalyze", repositoryId, analysisVersion, key }); return { jobId: "66666666-6666-4666-8666-666666666666" }; }
  async prioritizeAnalysis(repositoryId: string) { this.operations.push({ operation: "prioritize-analysis", repositoryId }); return { jobId: "88888888-8888-4888-8888-888888888888", status: "queued" as const }; }
  async analysisStatus(repositoryId: string) { return { repositoryId, state: "queued" as const, jobId: "88888888-8888-4888-8888-888888888888", attempts: 0, maxAttempts: 5, availableAt: new Date(0).toISOString(), leasedUntil: null, lastError: null }; }
  async createControlRun(operation: ControlOperation) { const existing = this.controlRuns.find((run) => run.operation === operation && ["pending", "running"].includes(run.status)); if (existing) return existing; const run: ControlRun = { id: "77777777-7777-4777-8777-777777777777", operation, status: "pending", requestedAt: new Date(0).toISOString(), startedAt: null, completedAt: null, leasedUntil: null, workerId: null, result: null, error: null }; this.controlRuns.unshift(run); return run; }
  async listControlRuns(limit: number) { return this.controlRuns.slice(0, limit); }
  async claimControlRun(operation: ControlOperation, workerId: string) { const run = this.controlRuns.find((item) => item.operation === operation && item.status === "pending"); if (!run) return null; run.status = "running"; run.workerId = workerId; return run; }
  async completeControlRun(id: string, _workerId: string, result: Record<string, unknown>) { const run = this.controlRuns.find((item) => item.id === id); if (run) { run.status = "succeeded"; run.result = result; } }
  async failControlRun(id: string, _workerId: string, error: string) { const run = this.controlRuns.find((item) => item.id === id); if (run) { run.status = "failed"; run.error = error; } }
  async operationalCounts() { return { repositories: { starred: 0, due: 0 }, jobs: {}, agentRuns: {} }; }
  async recordOperationalCheck() {}
  githubSync = { latestDaily: null, lastSuccessfulDaily: null, healthy: false, staleAfterHours: 26, checkedAt: new Date(0).toISOString() };
  async startGithubSync(id: string, source: import("./domain.js").GithubSyncSource, startedAt: string) { this.operations.push({ operation: "github-sync-start", id, source, startedAt }); }
  async completeGithubSync(id: string, observedAt: string, result: Record<string, unknown>) { this.operations.push({ operation: "github-sync-complete", id, observedAt, result }); }
  async failGithubSync(id: string, error: string) { this.operations.push({ operation: "github-sync-fail", id, error }); }
  async githubSyncStatus() { return this.githubSync; }
  async saveFeedback(input: import("./domain.js").QueryFeedbackInput) { this.operations.push({ operation: "feedback", input }); return { feedbackId: "99999999-9999-4999-8999-999999999999" }; }
}
export class FakeSearch implements SearchAdapter { result: SearchPage = { items: [], page: 1, pageSize: 20, total: 0, indexVersion: "test" }; async ping() {} async ensureConfigured() {} async documentCount() { return this.result.total; } async search(q: SearchQuery) { return { ...this.result, page: q.page, pageSize: q.pageSize }; } }
