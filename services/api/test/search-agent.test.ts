import { describe, expect, it } from "vitest";
import { FakeRepository, FakeSearch } from "../src/fakes.js";
import { BoundedSearchAgent } from "../src/search-agent.js";
import type { AgentSearchRun } from "../src/domain.js";

describe("bounded search agent", () => {
  it("finishes empty searches with explicit low confidence", async () => {
    const agent = new BoundedSearchAgent(new FakeSearch(), new FakeRepository()); const run = await agent.start("我只记得一个用途不明的项目");
    await new Promise((resolve) => setImmediate(resolve));
    expect(await agent.get(run.id)).toMatchObject({ status: "completed", answer: { confidence: .2, recommendations: [] } });
    expect((await agent.get(run.id))?.events.at(-1)?.type).toBe("answer.completed");
  });
  it("expires completed runs lazily", async () => {
    let now = Date.now(); const agent = new BoundedSearchAgent(new FakeSearch(), new FakeRepository(), { completedTtlMs: 100, now: () => now });
    const run = await agent.start("过期查询"); await new Promise((resolve) => setImmediate(resolve)); expect(await agent.get(run.id)).toBeDefined();
    now += 101; expect(await agent.get(run.id)).toBeUndefined();
  });
  it("rejects unbounded growth while all retained runs are active", async () => {
    const search = new FakeSearch(); search.search = () => new Promise(() => undefined); const agent = new BoundedSearchAgent(search, new FakeRepository(), { maxRuns: 1 });
    await agent.start("第一个查询"); await expect(agent.start("第二个查询")).rejects.toThrow(/capacity/);
  });
  it("evicts the oldest completed run before rejecting new work", async () => {
    const agent = new BoundedSearchAgent(new FakeSearch(), new FakeRepository(), { maxRuns: 1 }); const first = await agent.start("第一个查询"); await new Promise((resolve) => setImmediate(resolve));
    const second = await agent.start("第二个查询"); expect(await agent.get(first.id)).toBeUndefined(); expect(await agent.get(second.id)).toBeDefined();
  });
  it("does not fetch README content that is unused by the answer", async () => {
    const repositories = new FakeRepository(); let reads = 0; repositories.readme = async () => { reads += 1; return null; };
    const agent = new BoundedSearchAgent(new FakeSearch(), repositories); await agent.start("测试查询"); await new Promise((resolve) => setImmediate(resolve)); expect(reads).toBe(0);
  });
  it("runs bounded query expansion even when the first round already has many hits", async () => {
    const search = new FakeSearch(); const calls: string[] = []; search.result = { items: Array.from({ length: 20 }, () => ({ project: { id: crypto.randomUUID() } as never, matchedFields: [], highlights: {}, dataUpdatedAt: new Date().toISOString() })), page: 1, pageSize: 20, total: 20, indexVersion: "test" };
    search.search = async (query) => { calls.push(query.query); return search.result; };
    const agent = new BoundedSearchAgent(search, new FakeRepository()); await agent.start("高性能内存数据库和缓存，支持向量搜索"); await new Promise((resolve) => setImmediate(resolve));
    expect(calls).toEqual(["高性能内存数据库和缓存，支持向量搜索", "vector database vector search Redis embedding", "in-memory database cache Redis key-value"]);
  });
  it("persists lifecycle events and can load a completed run after memory eviction", async () => {
    const saved = new Map<string, AgentSearchRun>();
    const store = {
      create: async (run: AgentSearchRun) => { saved.set(run.id, structuredClone(run)); },
      append: async (event: AgentSearchRun["events"][number]) => { saved.get(event.runId)!.events.push(structuredClone(event)); },
      finish: async (run: AgentSearchRun) => { saved.set(run.id, structuredClone(run)); },
      load: async (id: string) => saved.get(id), failInterrupted: async () => 0,
    };
    let now = Date.now(); const agent = new BoundedSearchAgent(new FakeSearch(), new FakeRepository(), { store, completedTtlMs: 10, now: () => now });
    const run = await agent.start("持久化查询"); await new Promise((resolve) => setImmediate(resolve)); now += 11;
    expect(await agent.get(run.id)).toMatchObject({ status: "completed", events: expect.arrayContaining([expect.objectContaining({ type: "answer.completed" })]) });
  });
});
