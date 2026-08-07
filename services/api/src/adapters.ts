import type { ActiveJob, AnalysisInput, AnalysisQueueReconcileResult, AnalysisTaskStatus, ClaimedJob, ControlOperation, ControlRun, DuePage, GithubSyncSource, GithubSyncStatus, JobExecutionContext, JobQuery, JobQueueSummary, LibraryStats, OperationalJob, OperationalSummary, Page, Project, ProjectQuery, QueryFeedbackInput, RecentJobFailure, RecollectResult, RefreshInput, RepositoryIndexSource, RepositorySearchDocument, SearchPage, SearchQuery, SnapshotInput, StarInput } from "./domain.js";
import type { MetricsRegistry } from "./metrics.js";

export interface RepositoryAdapter {
  ping(): Promise<void>;
  list(query: ProjectQuery): Promise<Page<Project>>;
  get(id: string): Promise<Project | null>;
  getMany(ids: string[]): Promise<Project[]>;
  updates(since: string, limit: number): Promise<Project[]>;
  categories(): Promise<Array<{ name: string; count: number }>>;
  stats(): Promise<LibraryStats>;
  readme(id: string, maxChars: number): Promise<{ text: string; truncated: boolean; dataUpdatedAt: string } | null>;
  reconcile(observedAt: string, repositories: StarInput[], idempotencyKey: string): Promise<{ upserted: number; unstarred: number }>;
  dueRepositories(asOf: string, limit: number, cursor?: string): Promise<DuePage>;
  refresh(githubId: string, input: RefreshInput, idempotencyKey: string): Promise<{ snapshotId: string; changed: boolean; analysisJobId: string | null; nextCheckAt: string }>;
  saveSnapshot(githubId: string, input: SnapshotInput, idempotencyKey: string): Promise<{ snapshotId: string; changed: boolean; analysisJobId: string | null }>;
  saveAnalysis(repositoryId: string, input: AnalysisInput, idempotencyKey: string): Promise<{ analysisId: string; indexJobId: string }>;
}

export interface JobAdapter {
  acquireIndexLock(): Promise<() => Promise<void>>;
  claim(types: string[], workerId: string, limit: number, leaseSeconds: number, minPriority?: number, context?: JobExecutionContext): Promise<ClaimedJob[]>;
  heartbeat(id: string, workerId: string, leaseSeconds: number, idempotencyKey: string, context?: JobExecutionContext): Promise<{ leasedUntil: string }>;
  complete(id: string, workerId: string, idempotencyKey: string, context?: JobExecutionContext): Promise<void>;
  fail(id: string, workerId: string, error: string, retryable: boolean, idempotencyKey: string, context?: JobExecutionContext): Promise<void>;
  activeJobs(): Promise<ActiveJob[]>;
  jobSummary(): Promise<JobQueueSummary>;
  recentJobFailures(limit: number): Promise<RecentJobFailure[]>;
  reconcileAnalysisQueue(limit: number, idempotencyKey: string): Promise<AnalysisQueueReconcileResult>;
  listOperational(query: JobQuery): Promise<Page<OperationalJob>>;
  retry(id: string, idempotencyKey: string): Promise<{ jobId: string; status: string; retried: boolean }>;
  recollect(repositoryId: string, idempotencyKey: string): Promise<RecollectResult>;
  reanalyze(repositoryId: string, analysisVersion: string, idempotencyKey: string): Promise<{ jobId: string }>;
  prioritizeAnalysis(repositoryId: string): Promise<{ jobId: string | null; status: "queued" | "running" | "already_analyzed" }>;
  analysisStatus(repositoryId: string): Promise<AnalysisTaskStatus>;
  createControlRun(operation: ControlOperation): Promise<ControlRun>;
  listControlRuns(limit: number): Promise<ControlRun[]>;
  claimControlRun(operation: ControlOperation, workerId: string, leaseSeconds: number): Promise<ControlRun | null>;
  completeControlRun(id: string, workerId: string, result: Record<string, unknown>): Promise<void>;
  failControlRun(id: string, workerId: string, error: string): Promise<void>;
  operationalCounts(): Promise<Omit<OperationalSummary, "githubSync" | "index" | "consistent" | "checkedAt">>;
  recordOperationalCheck(status: "passed" | "failed", details: Record<string, unknown>): Promise<void>;
  startGithubSync(id: string, source: GithubSyncSource, startedAt: string): Promise<void>;
  completeGithubSync(id: string, observedAt: string, result: Record<string, unknown>): Promise<void>;
  failGithubSync(id: string, error: string): Promise<void>;
  githubSyncStatus(): Promise<GithubSyncStatus>;
  saveFeedback(input: QueryFeedbackInput): Promise<{ feedbackId: string }>;
}

export interface IndexSourceAdapter {
  getIndexSource(repositoryId: string): Promise<RepositoryIndexSource | null>;
  listIndexSourceIds(afterId: string | null, limit: number): Promise<string[]>;
}

export interface SearchIndexAdapter {
  upsert(document: RepositorySearchDocument): Promise<void>;
  upsertMany(documents: RepositorySearchDocument[]): Promise<void>;
  delete(repositoryId: string): Promise<void>;
  clear(): Promise<void>;
  beginAtomicRebuild(): Promise<SearchIndexRebuild>;
}

export interface SearchIndexRebuild {
  upsertMany(documents: RepositorySearchDocument[]): Promise<void>;
  commit(): Promise<void>;
  abort(): Promise<void>;
}

export interface SearchAdapter {
  ping(): Promise<void>;
  ensureConfigured(): Promise<void>;
  search(query: SearchQuery): Promise<SearchPage>;
  documentCount(): Promise<number>;
}

export interface AgentRun { id: string; agentName: string; triggerId: string | null; source: "cron" | "event" | "manual" | "api" | "scheduler"; status: "pending" | "running" | "succeeded" | "failed" | "canceled"; startedAt: string | null; completedAt: string | null; durationMs: number | null; sandboxId: string | null; summary: string | null; error: string | null }
export interface AgentRunAdapter { list(limit: number): Promise<AgentRun[]>; logs(runId: string, tail: number): Promise<string> }

import type { AgentSearchRuntime } from "./search-agent.js";
export interface Dependencies { repositories: RepositoryAdapter; jobs: JobAdapter; search: SearchAdapter; agentRuns?: AgentRunAdapter; agentSearch?: AgentSearchRuntime; metrics?: MetricsRegistry; agentToken: string; adminToken?: string }
