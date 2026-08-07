import { randomUUID } from "node:crypto";
import type { RepositoryAdapter, SearchAdapter } from "./adapters.js";
import type { AgentSearchAnswer, AgentSearchEvent, AgentSearchRun, SearchHit } from "./domain.js";

export interface AgentSearchRuntime {
  start(query: string): Promise<AgentSearchRun>;
  get(id: string): Promise<AgentSearchRun | undefined>;
  subscribe(id: string, listener: (event: AgentSearchEvent) => void): (() => void) | undefined;
}
export interface AgentSearchStore {
  create(run: AgentSearchRun): Promise<void>;
  append(event: AgentSearchEvent): Promise<void>;
  finish(run: AgentSearchRun): Promise<void>;
  load(id: string): Promise<AgentSearchRun | undefined>;
  failInterrupted(): Promise<number>;
}
export interface AgentSearchRuntimeOptions { maxRuns?: number; completedTtlMs?: number; now?: () => number; store?: AgentSearchStore; onEvent?: (event: AgentSearchEvent) => void }

const SYNONYMS: Array<[RegExp, string]> = [
  [/git\s*diff|差异|diff/i, "git diff"],
  [/向量(?:数据库|搜索)|vector\s*(?:database|search)/i, "vector database vector search Redis embedding"],
  [/内存数据库|缓存|in-memory|cache/i, "in-memory database cache Redis key-value"],
  [/工作流|workflow/i, "workflow orchestration"],
  [/mcp|model context protocol/i, "MCP protocol"],
  [/终端|terminal|cli/i, "terminal CLI"],
];

export class BoundedSearchAgent implements AgentSearchRuntime {
  private readonly runs = new Map<string, AgentSearchRun>();
  private readonly listeners = new Map<string, Set<(event: AgentSearchEvent) => void>>();
  private readonly maxRuns: number; private readonly completedTtlMs: number; private readonly now: () => number;
  private readonly store?: AgentSearchStore;
  private readonly onEvent?: (event: AgentSearchEvent) => void;
  constructor(private readonly search: SearchAdapter, private readonly repositories: RepositoryAdapter, options: AgentSearchRuntimeOptions = {}) {
    this.maxRuns = options.maxRuns ?? 500; this.completedTtlMs = options.completedTtlMs ?? 15 * 60_000; this.now = options.now ?? Date.now; this.store = options.store; this.onEvent = options.onEvent;
    if (this.maxRuns < 1 || this.completedTtlMs < 1) throw new Error("agent search retention limits must be positive");
  }

  async recover(): Promise<number> { return this.store?.failInterrupted() ?? 0; }
  async start(query: string): Promise<AgentSearchRun> {
    this.cleanup(true);
    if (this.runs.size >= this.maxRuns) throw Object.assign(new Error("agent search capacity reached; retry after an active run completes"), { statusCode: 429, code: "AGENT_RUN_CAPACITY", retryable: true });
    const now = new Date().toISOString();
    const run: AgentSearchRun = { id: randomUUID(), query, status: "running", createdAt: now, events: [] };
    this.runs.set(run.id, run);
    await this.store?.create(run);
    await this.emit(run, "run.started", { query });
    queueMicrotask(() => void this.execute(run));
    return run;
  }
  async get(id: string) { this.cleanup(); return this.runs.get(id) ?? this.store?.load(id); }
  subscribe(id: string, listener: (event: AgentSearchEvent) => void) {
    this.cleanup();
    if (!this.runs.has(id)) return undefined;
    const set = this.listeners.get(id) ?? new Set(); set.add(listener); this.listeners.set(id, set);
    return () => { set.delete(listener); if (!set.size) this.listeners.delete(id); };
  }
  private cleanup(forCapacity = false) {
    for (const [id, run] of this.runs) {
      if (run.status !== "running" && run.completedAt && this.now() - Date.parse(run.completedAt) >= this.completedTtlMs) {
        this.runs.delete(id); this.listeners.delete(id);
      }
    }
    if (forCapacity && this.runs.size >= this.maxRuns) {
      const completed = [...this.runs.values()].filter((run) => run.status !== "running").sort((a, b) => Date.parse(a.completedAt!) - Date.parse(b.completedAt!));
      for (const run of completed) { if (this.runs.size < this.maxRuns) break; this.runs.delete(run.id); this.listeners.delete(run.id); }
    }
  }
  private async emit(run: AgentSearchRun, type: AgentSearchEvent["type"], data: Record<string, unknown>) {
    const event = { id: run.events.length + 1, runId: run.id, type, at: new Date().toISOString(), data };
    run.events.push(event); await this.store?.append(event); this.onEvent?.(event); for (const listener of this.listeners.get(run.id) ?? []) listener(event);
  }
  private expansions(query: string): string[] {
    const expanded = SYNONYMS.filter(([pattern]) => pattern.test(query)).map(([, words]) => words);
    const english = query.match(/[a-z][a-z0-9+.#-]{1,}/gi)?.join(" ");
    return [...new Set([query, ...expanded, english].filter((x): x is string => Boolean(x)))].slice(0, 3);
  }
  private async execute(run: AgentSearchRun) {
    try {
      const hits = new Map<string, { hit: SearchHit; score: number }>(); let indexVersion = "unknown";
      for (const [round, query] of this.expansions(run.query).entries()) {
        await this.emit(run, "search.started", { round: round + 1, query });
        const page = await this.search.search({ query, page: 1, pageSize: 20, sort: "relevance" }); indexVersion = page.indexVersion;
        page.items.forEach((hit, rank) => {
          const score = 20 - rank + (hit.project.analysis ? 25 : 0); const prior = hits.get(hit.project.id);
          if (prior) prior.score += score; else hits.set(hit.project.id, { hit, score });
        });
        await this.emit(run, "search.completed", { round: round + 1, query, returned: page.items.length, uniqueCandidates: hits.size, indexVersion });
      }
      const candidates = [...hits.values()].sort((a, b) => b.score - a.score).map(({ hit }) => hit).slice(0, 10);
      const detailed = await this.repositories.getMany(candidates.map((hit) => hit.project.id));
      const detailsById = new Map(detailed.map((project) => [project.id, project]));
      for (const hit of candidates) hit.project = detailsById.get(hit.project.id) ?? hit.project;
      const recommendations = candidates.slice(0, 5).map((hit, rank) => {
        const analysis = hit.project.analysis; const reasons = [analysis?.summaryZh ?? hit.project.description ?? "名称与查询匹配"];
        if (hit.matchedFields.length) reasons.push(`命中字段：${hit.matchedFields.join("、")}`);
        if (analysis?.limitations.length) reasons.push(`限制：${analysis.limitations.slice(0, 2).join("；")}`);
        const base = analysis?.confidence ?? 0.65; const confidence = Math.max(0.35, Math.min(0.95, base - rank * 0.05));
        return { project: hit.project, reasons, confidence, dataUpdatedAt: hit.dataUpdatedAt };
      });
      const alternatives = recommendations.length > 1 ? recommendations.slice(1) : [];
      const dataUpdatedAt = recommendations.map((x) => x.dataUpdatedAt).sort().at(-1) ?? new Date().toISOString();
      const confidence = recommendations.length ? recommendations.reduce((sum, x) => sum + x.confidence, 0) / recommendations.length : 0.2;
      const text = recommendations.length
        ? `找到 ${candidates.length} 个候选。首选 ${recommendations[0]!.project.fullName}：${recommendations[0]!.reasons[0]}${confidence < 0.55 ? "。结果置信度较低，请同时查看备选。" : "。"}`
        : "没有找到可靠候选。请补充项目用途、语言或大致活跃时间后重试。";
      const answer: AgentSearchAnswer = { text, confidence, dataUpdatedAt, recommendations, alternatives };
      await this.emit(run, "candidates.compared", { candidateCount: candidates.length, comparedIds: candidates.map((x) => x.project.id) });
      run.answer = answer; run.status = "completed"; run.completedAt = new Date().toISOString();
      await this.emit(run, "answer.completed", { answer }); await this.store?.finish(run);
    } catch (cause) {
      run.status = "failed"; run.completedAt = new Date().toISOString(); run.error = cause instanceof Error ? cause.message : "agent search failed";
      await this.emit(run, "run.failed", { message: run.error }); await this.store?.finish(run);
    }
  }
}
