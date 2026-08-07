import { randomUUID } from "node:crypto";
import type { AgentSearchRuntime, AgentSearchStore } from "./search-agent.js";
import type { AgentSearchEvent, AgentSearchRun, AgentSearchAnswer } from "./domain.js";
import { AgentComposeRunBridge } from "./agent-compose-runs.js";

export class ComposeSearchAgent implements AgentSearchRuntime {
  private readonly runs = new Map<string, AgentSearchRun>();
  private readonly listeners = new Map<string, Set<(event: AgentSearchEvent) => void>>();
  constructor(private readonly bridge: AgentComposeRunBridge, private readonly agentName: string, private readonly store?: AgentSearchStore) {}
  async recover() { return this.store?.failInterrupted() ?? 0; }
  async start(query: string): Promise<AgentSearchRun> {
    const run: AgentSearchRun = { id: randomUUID(), query, status: "running", createdAt: new Date().toISOString(), events: [] };
    this.runs.set(run.id, run); await this.store?.create(run); await this.event(run, "run.started", { query });
    void this.execute(run); return run;
  }
  async get(id: string) { return this.runs.get(id) ?? this.store?.load(id); }
  subscribe(id: string, listener: (event: AgentSearchEvent) => void) { if (!this.runs.has(id)) return undefined; const set = this.listeners.get(id) ?? new Set(); set.add(listener); this.listeners.set(id, set); return () => { set.delete(listener); if (!set.size) this.listeners.delete(id); }; }
  private async event(run: AgentSearchRun, type: AgentSearchEvent["type"], data: Record<string, unknown>) { const e = { id: run.events.length + 1, runId: run.id, type, at: new Date().toISOString(), data }; run.events.push(e); await this.store?.append(e); for (const listener of this.listeners.get(run.id) ?? []) listener(e); }
  private async execute(run: AgentSearchRun) {
    try {
      const started = await this.bridge.startAgent(this.agentName, run.query, run.id); const remote = (started.run as Record<string, unknown> | undefined)?.runId as string;
      if (!remote) throw new Error("agent-compose did not return run id");
      for (;;) { await new Promise((resolve) => setTimeout(resolve, 1000)); const detail = await this.bridge.getRun(remote); const r = detail.run as Record<string, unknown> | undefined; const summary = r?.summary as Record<string, unknown> | undefined; const status = String(summary?.status ?? ""); if (!status.includes("SUCCEEDED") && !status.includes("FAILED") && !status.includes("CANCELED")) continue;
        if (!status.includes("SUCCEEDED")) throw new Error(String(summary?.error ?? "search agent failed"));
        const raw = String(r?.resultJson ?? r?.output ?? "{}"); let answer: AgentSearchAnswer; try { answer = JSON.parse(raw) as AgentSearchAnswer; } catch { answer = { text: raw, confidence: 0.5, dataUpdatedAt: new Date().toISOString(), recommendations: [], alternatives: [] }; }
        run.answer = answer; run.status = "completed"; run.completedAt = new Date().toISOString(); await this.event(run, "answer.completed", { answer }); await this.store?.finish(run); return;
      }
    } catch (error) { run.status = "failed"; run.completedAt = new Date().toISOString(); run.error = error instanceof Error ? error.message : String(error); await this.event(run, "run.failed", { message: run.error }); await this.store?.finish(run); }
  }
}
