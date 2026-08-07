import type { ActiveJob, AgentEvent, AgentRun, AnalysisTaskStatus, ControlRun, FailedJob, JobSummary, LibraryStats, Page, Project, ProjectFilters, SearchHit } from "./types";

export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

function baseUrl(): string {
  const configured = import.meta.env.VITE_API_BASE_URL?.trim();
  return configured ? configured.replace(/\/$/, "") : "";
}

function queryString(values: Record<string, string | number | undefined>): string {
  const query = new URLSearchParams();
  Object.entries(values).forEach(([key, value]) => {
    if (value !== undefined && value !== "") query.set(key, String(value));
  });
  return query.toString();
}

async function get<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`${baseUrl()}${path}`, { signal, headers: { Accept: "application/json" } });
  if (!response.ok) {
    let message = `请求失败（${response.status}）`;
    try { message = (await response.json()).error?.message ?? message; } catch { /* non-JSON error */ }
    throw new ApiError(response.status, message);
  }
  return response.json() as Promise<T>;
}
async function post<T>(path: string, body: object, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`${baseUrl()}${path}`, { method: "POST", signal, headers: { Accept: "application/json", "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!response.ok) { let message = `请求失败（${response.status}）`; try { message = (await response.json()).error?.message ?? message; } catch {} throw new ApiError(response.status, message); }
  return response.json() as Promise<T>;
}
async function adminRequest<T>(path: string, token: string, method = "GET", body?: object): Promise<T> {
  const response = await fetch(`${baseUrl()}${path}`, { method, headers: { Accept: "application/json", Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  if (!response.ok) { let message = `请求失败（${response.status}）`; try { message = (await response.json()).error?.message ?? message; } catch {} throw new ApiError(response.status, message); }
  return response.json() as Promise<T>;
}

export const api = {
  async projects(filters: ProjectFilters, signal?: AbortSignal): Promise<Page<Project>> {
    const params = { page: filters.page ?? 1, pageSize: filters.pageSize ?? 20, category: filters.category, language: filters.language, activity: filters.activity, sort: filters.sort };
    if (!filters.q?.trim()) return get(`/api/v1/projects?${queryString(params)}`, signal);
    const result = await get<Page<SearchHit> & { indexVersion: string }>(`/api/v1/search?${queryString({ ...params, q: filters.q.trim() })}`, signal);
    return { ...result, items: result.items.map((hit) => hit.project) };
  },
  project(id: string, signal?: AbortSignal): Promise<Project> {
    return get(`/api/v1/projects/${encodeURIComponent(id)}`, signal);
  },
  updates(since: string, limit = 12, signal?: AbortSignal): Promise<Page<Project>> {
    return get(`/api/v1/updates?${queryString({ since, limit })}`, signal);
  },
  async categories(signal?: AbortSignal): Promise<string[]> {
    const result = await get<{ items: Array<{ name: string; count: number }> }>("/api/v1/categories", signal);
    return result.items.map((category) => category.name);
  },
  stats(signal?: AbortSignal): Promise<LibraryStats> {
    return get("/api/v1/stats", signal);
  },
  feedback(input: { queryId: string; queryText: string; resultRepositoryIds: string[]; rating: -1 | 1; action: "helpful" | "unhelpful" }): Promise<{ feedbackId: string }> { return post("/api/v1/feedback", { ...input, metadata: { source: "agent-search-web" } }); },
  async adminRuns(token: string): Promise<ControlRun[]> { return (await adminRequest<{ items: ControlRun[] }>("/api/v1/admin/runs", token)).items; },
  async adminAgentRuns(token: string): Promise<AgentRun[]> { return (await adminRequest<{ items: AgentRun[] }>("/api/v1/admin/agent-runs", token)).items; },
  async adminActiveJobs(token: string): Promise<ActiveJob[]> { const result = await adminRequest<{ items?: ActiveJob[] } | ActiveJob[]>("/api/v1/admin/jobs/active", token); return Array.isArray(result) ? result : result.items ?? []; },
  async adminJobSummary(token: string): Promise<JobSummary> { const result = await adminRequest<JobSummary | { summary: JobSummary }>("/api/v1/admin/jobs/summary", token); return "summary" in result ? result.summary : result; },
  async adminRecentFailures(token: string): Promise<FailedJob[]> { const result = await adminRequest<{ items?: FailedJob[] } | FailedJob[]>("/api/v1/admin/jobs/recent-failures", token); return Array.isArray(result) ? result : result.items ?? []; },
  triggerAdminRun(token: string, operation: "sync" | "curate"): Promise<ControlRun> { return adminRequest("/api/v1/admin/runs", token, "POST", { operation }); },
  prioritizeAnalysis(token: string, projectId: string): Promise<{ jobId: string | null; status: string }> { return adminRequest(`/api/v1/admin/projects/${encodeURIComponent(projectId)}/analyze`, token, "POST", {}); },
  analysisStatus(token: string, projectId: string): Promise<AnalysisTaskStatus> { return adminRequest(`/api/v1/admin/projects/${encodeURIComponent(projectId)}/analysis-status`, token); },
  agentSearch(query: string, onEvent: (event: AgentEvent) => void, onError: (message: string) => void): () => void {
    let source: EventSource | undefined; let cancelled = false;
    void post<{ runId: string; eventsUrl: string }>("/api/v1/agent/search", { query }).then((run) => {
      if (cancelled) return; source = new EventSource(`${baseUrl()}${run.eventsUrl}`);
      ["run.started", "search.started", "search.completed", "candidates.compared", "answer.completed", "run.failed"].forEach((type) => source!.addEventListener(type, (raw) => {
        const event = JSON.parse((raw as MessageEvent).data) as AgentEvent; onEvent(event);
        if (type === "answer.completed" || type === "run.failed") source?.close();
      }));
      source.onerror = () => { source?.close(); onError("Agent 事件流连接中断，请重试。"); };
    }).catch((cause: Error) => { if (!cancelled) onError(cause.message); });
    return () => { cancelled = true; source?.close(); };
  },
};
