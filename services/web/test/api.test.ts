import { afterEach, describe, expect, it, vi } from "vitest";
import { api, ApiError } from "../src/api";

afterEach(() => vi.unstubAllGlobals());
describe("API client", () => {
  it("uses search and normalizes hits when q is present", async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ items: [{ project: { id: "p1" }, matchedFields: ["summaryZh"] }], page: 1, pageSize: 20, total: 1, indexVersion: "v1" }) });
    vi.stubGlobal("fetch", fetch);
    const result = await api.projects({ q: "git diff", category: "Git 工具" });
    expect(fetch.mock.calls[0][0]).toContain("/api/v1/search?");
    expect(fetch.mock.calls[0][0]).toContain("q=git+diff");
    expect(result.items).toEqual([{ id: "p1" }]);
  });
  it("surfaces the contract error message", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 503, json: async () => ({ error: { message: "search unavailable" } }) }));
    await expect(api.categories()).rejects.toEqual(expect.objectContaining({ status: 503, message: "search unavailable" }));
  });
  it("maps category facets to names for UI controls", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ items: [{ name: "Git 工具", count: 12 }, { name: "终端工具", count: 7 }] }) }));
    await expect(api.categories()).resolves.toEqual(["Git 工具", "终端工具"]);
  });
  it("submits agent result feedback for offline evaluation", async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ feedbackId: "feedback" }) }); vi.stubGlobal("fetch", fetch);
    await api.feedback({ queryId: "11111111-1111-4111-8111-111111111111", queryText: "git diff", resultRepositoryIds: [], rating: 1, action: "helpful" });
    expect(fetch).toHaveBeenCalledWith(expect.stringContaining("/api/v1/feedback"), expect.objectContaining({ method: "POST", body: expect.stringContaining('"rating":1') }));
  });
  it("loads the authenticated operations console resources", async () => {
    const fetch = vi.fn(async (input: string | URL | Request) => ({ ok: true, json: async () => String(input).endsWith("/jobs/summary") ? { summary: { counts: { pending: 3 }, oldestPendingAt: null, checkedAt: null } } : { items: [] } })); vi.stubGlobal("fetch", fetch);
    await expect(api.adminAgentRuns("secret")).resolves.toEqual([]); await expect(api.adminActiveJobs("secret")).resolves.toEqual([]); await expect(api.adminJobSummary("secret")).resolves.toEqual(expect.objectContaining({ counts: { pending: 3 } })); await expect(api.adminRecentFailures("secret")).resolves.toEqual([]);
    expect(fetch).toHaveBeenCalledWith(expect.stringContaining("/api/v1/admin/agent-runs"), expect.objectContaining({ headers: expect.objectContaining({ Authorization: "Bearer secret" }) }));
  });
});
