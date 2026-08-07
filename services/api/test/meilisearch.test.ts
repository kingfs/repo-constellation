import { expect, it, vi } from "vitest";
import type { MeiliSearch } from "meilisearch";
import { MeiliSearchAdapter, searchDocumentToProject } from "../src/meilisearch.js";

it("creates and configures the versioned repository index", async () => {
  const updateSettings = vi.fn().mockResolvedValue({ taskUid: 2 });
  const client = { createIndex: vi.fn().mockResolvedValue({ taskUid: 1 }), waitForTask: vi.fn().mockResolvedValue({}), index: vi.fn().mockReturnValue({ updateSettings }) } as unknown as MeiliSearch;
  const adapter = new MeiliSearchAdapter("http://unused", "key", "repositories_v1", client);
  await adapter.ensureConfigured();
  expect(client.createIndex).toHaveBeenCalledWith("repositories_v1", { primaryKey: "id" });
  expect(updateSettings).toHaveBeenCalledWith(expect.objectContaining({
    searchableAttributes: expect.arrayContaining(["name", "problems_solved", "summary_zh", "readme_search_text"]),
    filterableAttributes: expect.arrayContaining(["categories", "activity_class", "is_starred", "primary_language"]),
    sortableAttributes: ["stars_count", "pushed_at", "starred_at", "github_updated_at"],
  }));
  expect(client.waitForTask).toHaveBeenCalledTimes(2);
  expect(client.waitForTask).toHaveBeenNthCalledWith(1, 1, { timeOutMs: 60_000, intervalMs: 100 });
  expect(client.waitForTask).toHaveBeenNthCalledWith(2, 2, { timeOutMs: 60_000, intervalMs: 100 });
});

it("waits for document mutations before reporting success", async () => {
  const index = { addDocuments: vi.fn().mockResolvedValue({ taskUid: 3 }), deleteDocument: vi.fn().mockResolvedValue({ taskUid: 4 }), deleteAllDocuments: vi.fn().mockResolvedValue({ taskUid: 5 }) };
  const client = { waitForTask: vi.fn().mockResolvedValue({}), index: vi.fn().mockReturnValue(index) } as unknown as MeiliSearch;
  const adapter = new MeiliSearchAdapter("http://unused", "key", "repositories_v1", client);
  await adapter.upsert({ id: "id" } as never); await adapter.delete("id"); await adapter.clear();
  expect(index.addDocuments).toHaveBeenCalledWith([{ id: "id" }], { primaryKey: "id" });
  expect(client.waitForTask).toHaveBeenNthCalledWith(1, 3, { timeOutMs: 60_000, intervalMs: 100 });
  expect(client.waitForTask).toHaveBeenNthCalledWith(2, 4, { timeOutMs: 60_000, intervalMs: 100 });
  expect(client.waitForTask).toHaveBeenNthCalledWith(3, 5, { timeOutMs: 60_000, intervalMs: 100 });
});

it("rebuilds into a configured temporary index before an atomic swap", async () => {
  const live = { getSettings: vi.fn().mockResolvedValue({ searchableAttributes: ["name"] }) };
  const temporary = { updateSettings: vi.fn().mockResolvedValue({ taskUid: 2 }), addDocuments: vi.fn().mockResolvedValue({ taskUid: 3 }) };
  const client = {
    createIndex: vi.fn().mockResolvedValue({ taskUid: 1 }), waitForTask: vi.fn().mockResolvedValue({}),
    index: vi.fn((name: string) => name === "repositories_v1" ? live : temporary),
    swapIndexes: vi.fn().mockResolvedValue({ taskUid: 4 }), deleteIndex: vi.fn().mockResolvedValue({ taskUid: 5 }),
  } as unknown as MeiliSearch;
  const adapter = new MeiliSearchAdapter("http://unused", "key", "repositories_v1", client);
  const rebuild = await adapter.beginAtomicRebuild();
  await rebuild.upsertMany([{ id: "id" } as never]);
  await rebuild.commit();
  expect(temporary.updateSettings).toHaveBeenCalledWith({ searchableAttributes: ["name"] });
  expect(temporary.addDocuments).toHaveBeenCalledWith([{ id: "id" }], { primaryKey: "id" });
  expect(client.swapIndexes).toHaveBeenCalledWith([expect.objectContaining({ indexes: expect.arrayContaining(["repositories_v1"]) })]);
  expect(client.deleteIndex).toHaveBeenCalledWith(expect.stringMatching(/^repositories_v1_rebuild_/));
});

it("maps snake_case search documents to the public project and analysis shape", () => {
  const project = searchDocumentToProject({
    id: "repo", github_id: "123", full_name: "dandavison/delta", owner: "dandavison", name: "delta", html_url: "https://github.com/dandavison/delta",
    name_zh: "Delta", description: "pager", summary_zh: "增强 diff 可读性", categories: ["Git 工具"], problems_solved: ["难读"], use_cases: ["代码审查"],
    keywords: ["diff"], aliases: ["diff viewer"], target_users: ["开发者"], technologies: ["Rust"], topics: ["git"], maturity: "stable", maintenance_status: "active", limitations: ["terminal only"], confidence: 0.9, readme_search_text: "readme", stars_count: 12,
    forks_count: 3, open_issues_count: 2, pushed_at: 1767312000, starred_at: 1735689600, github_updated_at: 1767398400, updated_at: 1767484800,
    activity_class: "hot", archived: false, is_starred: true, license_spdx: "MIT", primary_language: "Rust",
  });
  expect(project).toEqual(expect.objectContaining({ githubId: "123", fullName: "dandavison/delta", htmlUrl: "https://github.com/dandavison/delta", starsCount: 12, forksCount: 3, openIssuesCount: 2, pushedAt: "2026-01-02T00:00:00.000Z", updatedAt: "2026-01-04T00:00:00.000Z" }));
  expect(project).not.toHaveProperty("full_name");
  expect(project.analysis).toEqual(expect.objectContaining({ nameZh: "Delta", summaryZh: "增强 diff 可读性", categories: ["Git 工具"], useCases: ["代码审查"], targetUsers: ["开发者"], maturity: "stable", limitations: ["terminal only"], confidence: 0.9 }));
});
