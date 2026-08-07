import { describe, expect, it, vi } from "vitest";
import type { IndexSourceAdapter, JobAdapter, SearchIndexAdapter } from "../src/adapters.js";
import type { ClaimedJob, RepositoryIndexSource, RepositorySearchDocument } from "../src/domain.js";
import { RepositoryIndexer, toSearchDocument } from "../src/indexer.js";

const source = (overrides: Partial<RepositoryIndexSource> = {}): RepositoryIndexSource => ({
  id: "11111111-1111-4111-8111-111111111111", githubId: "123", fullName: "dandavison/delta", owner: "dandavison", name: "delta", htmlUrl: "https://github.com/dandavison/delta", description: "syntax-highlighting pager",
  primaryLanguage: "Rust", topics: ["git", "diff"], licenseSpdx: "MIT", starsCount: 25000, forksCount: 400, openIssuesCount: 12,
  pushedAt: "2026-01-02T00:00:00.000Z", starredAt: "2025-01-01T00:00:00.000Z", githubUpdatedAt: "2026-01-03T00:00:00.000Z",
  activityClass: "hot", archived: false, unstarredAt: null, updatedAt: "2026-01-04T00:00:00.000Z", readmeText: "long readme",
  analysis: { nameZh: "Delta", summaryZh: "增强 Git diff 可读性", categories: ["Git 工具"], keywords: ["git", "diff"], aliases: ["diff viewer"], useCases: ["代码审查"], problemsSolved: ["改善 diff 可读性"], targetUsers: ["开发者"], technologies: ["Rust"], limitations: [] },
  ...overrides,
});
const job: ClaimedJob = { id: "job-1", type: "index_repository", repositoryId: source().id, payload: {}, attempts: 1, leasedUntil: new Date(Date.now() + 60_000).toISOString() };
const options = { workerId: "worker", batchSize: 10, leaseSeconds: 300, pollIntervalMs: 100, readmeMaxChars: 4 };

function harness(jobsToClaim: ClaimedJob[] = [job], value: RepositoryIndexSource | null = source()) {
  const sources: IndexSourceAdapter = { getIndexSource: vi.fn().mockResolvedValue(value), listIndexSourceIds: vi.fn().mockResolvedValue([]) };
  const jobs: JobAdapter = { acquireIndexLock: vi.fn().mockResolvedValue(async () => {}), claim: vi.fn().mockResolvedValue(jobsToClaim), complete: vi.fn().mockResolvedValue(undefined), fail: vi.fn().mockResolvedValue(undefined) };
  const rebuild = { upsertMany: vi.fn().mockResolvedValue(undefined), commit: vi.fn().mockResolvedValue(undefined), abort: vi.fn().mockResolvedValue(undefined) };
  const index: SearchIndexAdapter = { upsert: vi.fn().mockResolvedValue(undefined), upsertMany: vi.fn().mockResolvedValue(undefined), delete: vi.fn().mockResolvedValue(undefined), clear: vi.fn().mockResolvedValue(undefined), beginAtomicRebuild: vi.fn().mockResolvedValue(rebuild) };
  return { sources, jobs, index, rebuild, indexer: new RepositoryIndexer(sources, jobs, index, options) };
}

it("maps the current snapshot and latest analysis to the documented search shape", () => {
  expect(toSearchDocument(source(), 4)).toEqual(expect.objectContaining({
    id: source().id, full_name: "dandavison/delta", summary_zh: "增强 Git diff 可读性", categories: ["Git 工具"],
    readme_search_text: "long", pushed_at: 1767312000, is_starred: true, primary_language: "Rust",
  }));
});

it("leases, indexes and completes a job only after the index write succeeds", async () => {
  const h = harness();
  await expect(h.indexer.runOnce()).resolves.toBe(1);
  expect(h.jobs.claim).toHaveBeenCalledWith(["index_repository"], "worker", 10, 300);
  expect(h.index.upsertMany).toHaveBeenCalledWith([expect.objectContaining({ id: source().id })]);
  expect(h.jobs.complete).toHaveBeenCalledWith("job-1", "worker", "index-complete:job-1");
  expect(h.jobs.fail).not.toHaveBeenCalled();
});

it("records a retryable failure and does not complete when indexing fails", async () => {
  const h = harness();
  vi.mocked(h.index.upsertMany).mockRejectedValue(new Error("Meilisearch unavailable"));
  await expect(h.indexer.runOnce()).resolves.toBe(1);
  expect(h.jobs.fail).toHaveBeenCalledWith("job-1", "worker", "Meilisearch unavailable", true, "index-fail:job-1:1");
  expect(h.jobs.complete).not.toHaveBeenCalled();
});

it("does nothing when no index job is available", async () => {
  const h = harness([]);
  await expect(h.indexer.runOnce()).resolves.toBe(0);
  expect(h.sources.getIndexSource).not.toHaveBeenCalled();
  expect(h.index.upsertMany).not.toHaveBeenCalled();
});

it("wakes a sleeping background poller for graceful shutdown", async () => {
  const h = harness([]);
  const running = h.indexer.run();
  await vi.waitFor(() => expect(h.jobs.claim).toHaveBeenCalledOnce());
  h.indexer.stop();
  await expect(running).resolves.toBeUndefined();
});

it("deletes stale search documents for repositories that are no longer starred", async () => {
  const h = harness([job], source({ unstarredAt: "2026-02-01T00:00:00.000Z" }));
  await h.indexer.runOnce();
  expect(h.index.delete).toHaveBeenCalledWith(source().id);
  expect(h.index.upsertMany).not.toHaveBeenCalled();
});

describe("full rebuild", () => {
  it("builds a temporary projection and atomically commits all currently starred repositories", async () => {
    const h = harness([]);
    vi.mocked(h.sources.listIndexSourceIds).mockResolvedValueOnce(["a", "b"]).mockResolvedValueOnce(["c"]).mockResolvedValueOnce([]);
    vi.mocked(h.sources.getIndexSource).mockImplementation(async (id) => source({ id, unstarredAt: id === "b" ? "2025-01-01T00:00:00.000Z" : null }));
    await expect(h.indexer.rebuild(2)).resolves.toBe(2);
    expect(h.index.clear).not.toHaveBeenCalled();
    expect(h.sources.listIndexSourceIds).toHaveBeenNthCalledWith(1, null, 2);
    expect(h.sources.listIndexSourceIds).toHaveBeenNthCalledWith(2, "b", 2);
    expect(h.sources.listIndexSourceIds).toHaveBeenNthCalledWith(3, "c", 2);
    expect(h.rebuild.upsertMany).toHaveBeenCalledTimes(2);
    expect(h.rebuild.commit).toHaveBeenCalledOnce();
    expect(h.rebuild.abort).not.toHaveBeenCalled();
  });
  it("aborts the temporary projection without touching the live index on failure", async () => {
    const h = harness([]);
    vi.mocked(h.sources.listIndexSourceIds).mockResolvedValueOnce(["a"]);
    vi.mocked(h.sources.getIndexSource).mockResolvedValue(source({ id: "a" }));
    h.rebuild.upsertMany.mockRejectedValueOnce(new Error("write failed"));
    await expect(h.indexer.rebuild()).rejects.toThrow("write failed");
    expect(h.rebuild.abort).toHaveBeenCalledOnce();
    expect(h.rebuild.commit).not.toHaveBeenCalled();
  });
});
