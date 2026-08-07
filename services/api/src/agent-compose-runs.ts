import type { AgentRun, AgentRunAdapter } from "./adapters.js";

const paths = { projects: "/agentcompose.v2.ProjectService/ListProjects", runs: "/agentcompose.v2.RunService/ListRuns", start: "/agentcompose.v2.RunService/StartRun", get: "/agentcompose.v2.RunService/GetRun", runEvents: "/agentcompose.v2.RunService/ListRunEvents", events: "/agentcompose.v2.ProjectService/ListSchedulerEvents" };
const responseLimit = 2 * 1024 * 1024, logLimit = 64 * 1024;
type Json = Record<string, unknown>;
type Event = { type?: string; level?: string; message?: string; payloadJson?: string; runId?: string; triggerId?: string; createdAt?: string };
export interface AgentComposeRunOptions { baseUrl: string; authToken?: string; projectName: string; agentNames: string[]; timeoutMs?: number; fetch?: typeof globalThis.fetch }

export class AgentComposeRunBridge implements AgentRunAdapter {
  private fetcher: typeof globalThis.fetch; private baseUrl: string; private timeoutMs: number;
  constructor(private options: AgentComposeRunOptions) { this.fetcher = options.fetch ?? globalThis.fetch; this.baseUrl = options.baseUrl.replace(/\/$/, ""); this.timeoutMs = options.timeoutMs ?? 5000; }
  async list(limit: number): Promise<AgentRun[]> {
    const projectId = await this.projectId();
    const [plain, ...sets] = await Promise.all([this.rpc(paths.runs, { projectId, limit }), ...this.options.agentNames.map((agentName) => this.rpc(paths.events, { project: { projectId }, agentName, limit: Math.min(500, limit * 8) }))]);
    const runs = ((plain.runs as Json[] | undefined) ?? []).map(mapPlainRun);
    sets.forEach((set, i) => runs.push(...mapSchedulerRuns(this.options.agentNames[i]!, (set.events as Event[] | undefined) ?? [])));
    return [...new Map(runs.map((run) => [run.id, run])).values()].sort((a, b) => Date.parse(b.startedAt ?? "") - Date.parse(a.startedAt ?? "")).slice(0, limit);
  }
  async logs(runId: string, tail: number): Promise<string> {
    const projectId = await this.projectId();
    const sets = await Promise.all(this.options.agentNames.map((agentName) => this.rpc(paths.events, { project: { projectId }, agentName, limit: 500 })));
    const events = sets.flatMap((set) => (set.events as Event[] | undefined) ?? []).filter((event) => event.runId === runId).sort((a, b) => Date.parse(a.createdAt ?? "") - Date.parse(b.createdAt ?? ""));
    if (!events.length) {
      const plain = await this.rpc(paths.runs, { projectId, limit: 200 });
      if (!((plain.runs as Json[] | undefined) ?? []).some((run) => run.runId === runId)) throw apiError(404, "AGENT_RUN_NOT_FOUND", "agent run not found");
      const result = await this.rpc(paths.runEvents, { runId, limit: tail });
      const lines = ((result.events as Json[] | undefined) ?? []).map((event) => `${str(event.createdAt) ?? ""} ${str(event.kind) ?? "event"} ${redact(str(event.text) ?? str(event.name) ?? "")}`.trim());
      return bound(lines.slice(-tail).join("\n") || "No bounded run events are available for this run.", logLimit);
    }
    return bound(events.slice(-tail).map((event) => `${event.createdAt ?? ""} ${event.level ?? "info"} ${event.type ?? "event"} ${redact(event.message ?? "")}`.trim()).join("\n"), logLimit);
  }
  async startAgent(agentName: string, prompt: string, clientRequestId: string): Promise<Json> {
    const projectId = await this.projectId();
    return this.rpc(paths.start, { run: { projectId, agentName, prompt, source: "RUN_SOURCE_API", clientRequestId } });
  }
  async getRun(runId: string): Promise<Json> { return this.rpc(paths.get, { runId }); }
  private async projectId() { const data = await this.rpc(paths.projects, { query: this.options.projectName, limit: 100 }); const item = ((data.projects as Json[] | undefined) ?? []).find((project) => project.name === this.options.projectName); if (typeof item?.projectId !== "string") throw apiError(503, "AGENT_COMPOSE_PROJECT_UNAVAILABLE", "configured agent-compose project is unavailable", true); return item.projectId; }
  private async rpc(path: string, body: Json): Promise<Json> {
    let response: Response;
    const headers: Record<string, string> = { "Content-Type": "application/json", "Connect-Protocol-Version": "1" };
    if (this.options.authToken) headers.Authorization = `Bearer ${this.options.authToken}`;
    try { response = await this.fetcher(this.baseUrl + path, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(this.timeoutMs) }); }
    catch { throw apiError(503, "AGENT_COMPOSE_UNAVAILABLE", "agent-compose daemon is unavailable", true); }
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength > responseLimit) throw apiError(502, "AGENT_COMPOSE_RESPONSE_TOO_LARGE", "agent-compose response exceeded the safety limit");
    if (!response.ok) throw apiError(response.status >= 500 ? 503 : 502, "AGENT_COMPOSE_ERROR", "agent-compose daemon rejected the read-only request", response.status >= 500);
    try { return JSON.parse(buffer.toString("utf8")) as Json; } catch { throw apiError(502, "AGENT_COMPOSE_INVALID_RESPONSE", "agent-compose daemon returned invalid JSON"); }
  }
}

function mapPlainRun(run: Json): AgentRun { const startedAt = str(run.startedAt), completedAt = str(run.completedAt); return { id: str(run.runId)!, agentName: str(run.agentName) ?? "unknown", triggerId: str(run.triggerId), source: run.source === "RUN_SOURCE_API" ? "api" : run.source === "RUN_SOURCE_SCHEDULER" ? "scheduler" : "manual", status: status(str(run.status)), startedAt, completedAt, durationMs: num(run.durationMs), sandboxId: str(run.sandboxId), summary: null, error: redact(str(run.error) ?? "") || null }; }
function mapSchedulerRuns(agentName: string, events: Event[]): AgentRun[] {
  const groups = new Map<string, Event[]>(); for (const event of events) if (event.runId) groups.set(event.runId, [...(groups.get(event.runId) ?? []), event]);
  return [...groups].map(([id, values]) => { const ordered = values.sort((a, b) => Date.parse(a.createdAt ?? "") - Date.parse(b.createdAt ?? "")); const start = ordered.find((e) => e.type === "loader.run.started"); const completion = [...ordered].reverse().find((e) => e.type === "loader.run.completed" || e.type === "loader.run.failed"); const failure = [...ordered].reverse().find((e) => e.level === "error" || e.type?.includes("failed")); const source = str(payload(start?.payloadJson).source) ?? "scheduler"; const startedAt = start?.createdAt ?? ordered[0]?.createdAt ?? null, completedAt = completion?.createdAt ?? null; const sandboxId = ordered.map((e) => payload(e.payloadJson).sandboxId).find((v) => typeof v === "string") as string | undefined; const result = payload(completion?.payloadJson).resultJson; return { id, agentName, triggerId: start?.triggerId ?? ordered[0]?.triggerId ?? null, source: source.startsWith("cron:") ? "cron" : source.startsWith("event:") ? "event" : "scheduler", status: completion ? (failure ? "failed" : "succeeded") : "running", startedAt, completedAt, durationMs: startedAt && completedAt ? Math.max(0, Date.parse(completedAt) - Date.parse(startedAt)) : null, sandboxId: sandboxId ?? null, summary: typeof result === "string" ? bound(redact(result), 2000) : null, error: failure ? bound(redact(failure.message ?? "scheduler run failed"), 2000) : null }; });
}
const str = (v: unknown): string | null => typeof v === "string" && v ? v : null;
const num = (v: unknown): number | null => typeof v === "number" ? v : typeof v === "string" && /^\d+$/.test(v) ? Number(v) : null;
const payload = (v?: string): Json => { try { return v ? JSON.parse(v) as Json : {}; } catch { return {}; } };
const status = (v: string | null): AgentRun["status"] => ({ RUN_STATUS_PENDING: "pending", RUN_STATUS_RUNNING: "running", RUN_STATUS_SUCCEEDED: "succeeded", RUN_STATUS_FAILED: "failed", RUN_STATUS_CANCELED: "canceled" } as const)[v ?? ""] ?? "failed";
const bound = (v: string, max: number) => Buffer.byteLength(v) <= max ? v : Buffer.from(v).subarray(0, max).toString("utf8");
const redact = (v: string) => v.replace(/(authorization|token|secret|password)(["'=:\s]+)([^\s",}]+)/gi, "$1$2[REDACTED]");
const apiError = (statusCode: number, code: string, message: string, retryable = false) => Object.assign(new Error(message), { statusCode, code, retryable });
