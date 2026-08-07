export interface Analysis {
  nameZh?: string;
  summaryZh: string;
  categories: string[];
  keywords: string[];
  aliases: string[];
  useCases: string[];
  problemsSolved: string[];
  targetUsers: string[];
  technologies: string[];
  maturity?: string;
  maintenanceStatus?: string;
  limitations: string[];
  confidence?: number;
}

export interface Project {
  id: string;
  githubId: string;
  fullName: string;
  owner: string;
  name: string;
  htmlUrl: string;
  description: string | null;
  primaryLanguage: string | null;
  topics: string[];
  licenseSpdx: string | null;
  starsCount: number;
  forksCount: number;
  openIssuesCount: number;
  pushedAt: string | null;
  githubUpdatedAt: string | null;
  starredAt: string | null;
  unstarredAt: string | null;
  archived: boolean;
  activityClass: string;
  updatedAt: string;
  analysis?: Analysis | null;
}

export interface LibraryStats {
  totalStars: number;
  syncedRepositories: number;
  analyzedRepositories: number;
  pendingAnalysis: number;
  updatedAt: string | null;
}
export interface ControlRun { id: string; operation: "sync" | "curate"; status: string; requestedAt: string; startedAt: string | null; completedAt: string | null; result: Record<string, unknown> | null; error: string | null; }
export interface AgentRun { id: string; agentName: string; triggerId: string | null; source: "cron" | "event" | "manual" | string; status: string; startedAt: string | null; completedAt: string | null; durationMs: number | null; sandboxId: string | null; summary: string | null; error: string | null; }
export interface ActiveJob { id: string; type: string; status: string; repositoryId: string; fullName: string; priority: number; attempts: number; maxAttempts: number; workerId: string | null; startedAt: string | null; lastHeartbeatAt: string | null; leasedUntil: string | null; runId: string | null; sandboxId: string | null; }
export interface JobSummary { counts: Record<string, number>; oldestPendingAt: string | null; checkedAt: string | null; analysisConcurrency?: { current: number; min: number; max: number; active: number; successCount: number; failureCount: number; p95Seconds: number | null; backlog: number; reason: string; lastAdjustedAt: string | null }; }
export interface FailedJob { id: string; type: string; status: string; repositoryId: string; fullName: string; attempts: number; maxAttempts: number; lastError: string | null; availableAt: string | null; completedAt: string | null; }
export interface AnalysisTaskStatus { repositoryId: string; state: "not_requested" | "queued" | "running" | "retry_wait" | "failed" | "dead" | "analyzed"; jobId: string | null; attempts: number; maxAttempts: number; availableAt: string | null; leasedUntil: string | null; lastError: string | null; }

export interface Page<T> { items: T[]; page: number; pageSize: number; total: number }
export interface SearchHit { project: Project; matchedFields: string[]; highlights: Record<string, string>; dataUpdatedAt: string }
export interface ProjectFilters {
  q?: string;
  page?: number;
  pageSize?: number;
  category?: string;
  language?: string;
  activity?: string;
  sort?: string;
}
export interface AgentRecommendation { project: Project; reasons: string[]; confidence: number; dataUpdatedAt: string }
export interface AgentAnswer { text: string; confidence: number; dataUpdatedAt: string; recommendations: AgentRecommendation[]; alternatives: AgentRecommendation[] }
export interface AgentEvent { id: number; runId: string; type: string; at: string; data: { answer?: AgentAnswer; query?: string; round?: number; returned?: number; uniqueCandidates?: number; candidateCount?: number; message?: string } }
