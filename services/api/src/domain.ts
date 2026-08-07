export interface Page<T> { items: T[]; page: number; pageSize: number; total: number }
export interface ProjectQuery { page: number; pageSize: number; category?: string; language?: string; activity?: string; sort?: string }
export interface Project {
  id: string; githubId: string; fullName: string; owner: string; name: string; htmlUrl: string;
  description: string | null; primaryLanguage: string | null; topics: string[]; licenseSpdx: string | null;
  starsCount: number; forksCount: number; openIssuesCount: number; pushedAt: string | null;
  githubUpdatedAt: string | null; starredAt: string | null; unstarredAt: string | null;
  archived: boolean; activityClass: string; updatedAt: string;
  analysis?: Analysis | null;
}
export interface Analysis {
  nameZh?: string; summaryZh: string; categories: string[]; keywords: string[]; aliases: string[];
  useCases: string[]; problemsSolved: string[]; targetUsers: string[]; technologies: string[];
  maturity?: string; maintenanceStatus?: string; limitations: string[]; confidence?: number;
}
export interface SearchQuery { query: string; category?: string; language?: string; activity?: string; sort?: string; page: number; pageSize: number }
export interface SearchHit { project: Project; matchedFields: string[]; highlights: Record<string, string>; dataUpdatedAt: string }
export interface SearchPage extends Page<SearchHit> { indexVersion: string }
export type AgentSearchStatus = "running" | "completed" | "failed";
export type AgentSearchEventType = "run.started" | "search.started" | "search.completed" | "candidates.compared" | "answer.completed" | "run.failed";
export interface AgentSearchRecommendation { project: Project; reasons: string[]; confidence: number; dataUpdatedAt: string }
export interface AgentSearchAnswer { text: string; confidence: number; dataUpdatedAt: string; recommendations: AgentSearchRecommendation[]; alternatives: AgentSearchRecommendation[] }
export interface AgentSearchEvent { id: number; runId: string; type: AgentSearchEventType; at: string; data: Record<string, unknown> }
export interface AgentSearchRun { id: string; query: string; status: AgentSearchStatus; createdAt: string; completedAt?: string; answer?: AgentSearchAnswer; error?: string; events: AgentSearchEvent[] }
export interface StarInput { [key: string]: unknown; githubId: string; fullName: string; owner: string; name: string; htmlUrl: string }
export interface SnapshotInput { contentHash: string; metadata: Record<string, unknown>; readmeText?: string; readmeEtag?: string; releaseText?: string; releaseEtag?: string; fetchedAt: string }
export type ResourceRefresh =
  | { status: "modified"; text: string; etag?: string }
  | { status: "not_modified" }
  | { status: "missing" };
export interface RefreshInput { metadata: Record<string, unknown>; readme: ResourceRefresh; release: ResourceRefresh; fetchedAt: string }
export interface DueRepository { githubId: string; fullName: string; readmeEtag: string | null; releaseEtag: string | null; nextCheckAt: string }
export interface DuePage { items: DueRepository[]; nextCursor: string | null }
export interface ClaimedJob { id: string; type: string; repositoryId: string | null; payload: Record<string, unknown>; attempts: number; leasedUntil: string }
export interface JobExecutionContext { runId?: string; sandboxId?: string }
export interface ActiveJob {
  id: string; type: string; status: string; repositoryId: string | null; fullName: string | null; priority: number;
  attempts: number; maxAttempts: number; workerId: string | null; startedAt: string | null; lastHeartbeatAt: string | null;
  leasedUntil: string | null; runId: string | null; sandboxId: string | null;
}
export interface AnalysisConcurrencyStatus { current: number; min: number; max: number; active: number; successCount: number; failureCount: number; p95Seconds: number | null; backlog: number; reason: string; lastAdjustedAt: string | null }
export interface JobQueueSummary { counts: Record<string, number>; oldestPendingAt: string | null; checkedAt: string; analysisConcurrency?: AnalysisConcurrencyStatus }
export interface AnalysisQueueReconcileResult { created: number; revived: number; remaining: number }
export interface RecentJobFailure {
  id: string; type: string; status: string; repositoryId: string | null; fullName: string | null; attempts: number;
  maxAttempts: number; lastError: string | null; availableAt: string; completedAt: string | null;
}
export type OperationalJobStatus = "failed" | "dead" | "running";
export interface OperationalJob {
  id: string; type: string; repositoryId: string | null; dedupeKey: string; status: string; priority: number;
  attempts: number; maxAttempts: number; availableAt: string; leasedUntil: string | null; leasedBy: string | null;
  payload: Record<string, unknown>; lastError: string | null; createdAt: string; completedAt: string | null;
  startedAt: string | null; lastHeartbeatAt: string | null; runId: string | null; sandboxId: string | null;
}
export interface JobQuery { status: OperationalJobStatus; type?: string; repositoryId?: string; page: number; pageSize: number }
export interface RecollectResult { repositoryId: string; scheduled: true; nextCheckAt: string }
export type AnalysisTaskState = "not_requested" | "queued" | "running" | "retry_wait" | "failed" | "dead" | "analyzed";
export interface AnalysisTaskStatus {
  repositoryId: string; state: AnalysisTaskState; jobId: string | null; attempts: number; maxAttempts: number;
  availableAt: string | null; leasedUntil: string | null; lastError: string | null;
}
export interface AnalysisInput { snapshotId: string; contentHash: string; analysisVersion: string; model: string; analysis: Analysis & Record<string, unknown> }
export interface LibraryStats {
  totalStars: number;
  syncedRepositories: number;
  analyzedRepositories: number;
  pendingAnalysis: number;
  updatedAt: string | null;
}
export interface OperationalSummary {
  repositories: { starred: number; due: number };
  jobs: Record<string, number>;
  agentRuns: Record<string, number>;
  githubSync: GithubSyncStatus;
  index: { documents: number };
  consistent: boolean;
  checkedAt: string;
}
export type GithubSyncSource = "daily" | "manual";
export type GithubSyncRunStatus = "running" | "succeeded" | "failed";
export interface GithubSyncRun {
  id: string; source: GithubSyncSource; status: GithubSyncRunStatus; startedAt: string; completedAt: string | null;
  observedAt: string | null; result: Record<string, unknown> | null; error: string | null;
}
export interface GithubSyncStatus {
  latestDaily: GithubSyncRun | null; lastSuccessfulDaily: GithubSyncRun | null;
  healthy: boolean; staleAfterHours: number; checkedAt: string;
}
export interface QueryFeedbackInput {
  queryId: string; queryText: string; resultRepositoryIds: string[]; selectedRepositoryId?: string;
  rating?: -1 | 1; action?: "click" | "favorite" | "helpful" | "unhelpful"; metadata: Record<string, unknown>;
}
export type ControlOperation = "sync" | "curate";
export interface ControlRun {
  id: string; operation: ControlOperation; status: string; requestedAt: string; startedAt: string | null;
  completedAt: string | null; leasedUntil: string | null; workerId: string | null; result: Record<string, unknown> | null; error: string | null;
}

export interface RepositoryIndexSource {
  id: string; githubId: string; fullName: string; owner: string; name: string; htmlUrl: string; description: string | null; primaryLanguage: string | null;
  topics: string[]; licenseSpdx: string | null; starsCount: number; forksCount: number; openIssuesCount: number; pushedAt: string | null;
  starredAt: string | null; githubUpdatedAt: string | null; activityClass: string; archived: boolean;
  unstarredAt: string | null; updatedAt: string; readmeText: string | null; analysis: Analysis | null;
}

export interface RepositorySearchDocument {
  id: string; github_id: string; full_name: string; owner: string; name: string; html_url: string; name_zh?: string; description: string | null;
  summary_zh?: string; categories: string[]; problems_solved: string[]; use_cases: string[];
  keywords: string[]; aliases: string[]; target_users: string[]; technologies: string[]; topics: string[];
  maturity?: string; maintenance_status?: string; limitations: string[]; confidence?: number;
  readme_search_text: string; stars_count: number; forks_count: number; open_issues_count: number; pushed_at: number | null; starred_at: number | null;
  github_updated_at: number | null; activity_class: string; archived: boolean; is_starred: boolean;
  license_spdx: string | null; primary_language: string | null; updated_at: number;
}
