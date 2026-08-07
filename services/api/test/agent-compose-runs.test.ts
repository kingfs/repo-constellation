import { describe, expect, it, vi } from "vitest";
import { AgentComposeRunBridge } from "../src/agent-compose-runs.js";
const id = "a".repeat(64), projectId = "b".repeat(64), sandboxId = "c".repeat(64);
const reply = (value: unknown) => new Response(JSON.stringify(value), { status: 200 });
const bridge = (fetcher: typeof fetch) => new AgentComposeRunBridge({ baseUrl: "http://daemon:7410", projectName: "repo-constellation", agentNames: ["star-curator"], fetch: fetcher });
describe("agent-compose run bridge", () => {
  it("merges scheduler events and plain runs", async () => {
    const fetcher = vi.fn(async (url: string | URL | Request) => String(url).endsWith("ListProjects") ? reply({ projects: [{ projectId, name: "repo-constellation" }] }) : String(url).endsWith("ListRuns") ? reply({ runs: [{ runId: id, agentName: "duplicate", source: "RUN_SOURCE_MANUAL", status: "RUN_STATUS_RUNNING" }, { runId: "d".repeat(64), agentName: "star-sync", source: "RUN_SOURCE_MANUAL", status: "RUN_STATUS_SUCCEEDED", startedAt: "2026-07-16T00:00:00Z", completedAt: "2026-07-16T00:00:01Z", durationMs: "1000" }] }) : reply({ events: [{ type: "loader.run.started", level: "info", payloadJson: '{"source":"cron:*/10 * * * *"}', runId: id, triggerId: "curate", createdAt: "2026-07-16T01:00:00Z" }, { type: "loader.sandbox.created", payloadJson: JSON.stringify({ sandboxId }), runId: id, createdAt: "2026-07-16T01:00:01Z" }, { type: "loader.run.completed", payloadJson: '{"resultJson":"{\\"claimed\\":1}"}', runId: id, createdAt: "2026-07-16T01:00:02Z" }] })) as typeof fetch;
    const result = await bridge(fetcher).list(10); expect(result).toHaveLength(2); expect(result[0]).toMatchObject({ id, agentName: "star-curator", source: "cron", status: "succeeded", durationMs: 2000, sandboxId, summary: '{"claimed":1}' });
  });
  it("bounds log selection and redacts secrets", async () => {
    const fetcher = vi.fn(async (url: string | URL | Request) => String(url).endsWith("ListProjects") ? reply({ projects: [{ projectId, name: "repo-constellation" }] }) : reply({ events: [{ runId: id, createdAt: "2026-07-16T01:00:00Z", type: "event", message: "token=supersecret" }, { runId: id, createdAt: "2026-07-16T01:00:01Z", type: "done", message: "done" }] })) as typeof fetch;
    const logs = await bridge(fetcher).logs(id, 2); expect(logs).toContain("done"); expect(logs).toContain("token=[REDACTED]"); expect(logs).not.toContain("supersecret");
  });
  it("authenticates daemon requests when a token is configured", async () => {
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer daemon-secret");
      return reply({ projects: [{ projectId, name: "repo-constellation" }], runs: [], events: [] });
    }) as typeof fetch;
    const authenticated = new AgentComposeRunBridge({ baseUrl: "http://daemon:7410", authToken: "daemon-secret", projectName: "repo-constellation", agentNames: ["star-curator"], fetch: fetcher });
    await authenticated.list(10);
    expect(fetcher).toHaveBeenCalled();
  });
  it("reports daemon unavailability", async () => { const fetcher = vi.fn(async () => { throw new Error("offline"); }) as typeof fetch; await expect(bridge(fetcher).list(10)).rejects.toMatchObject({ statusCode: 503, code: "AGENT_COMPOSE_UNAVAILABLE", retryable: true }); });
  it("rejects oversized daemon responses", async () => { const fetcher = vi.fn(async () => new Response(JSON.stringify({ padding: "x".repeat(2 * 1024 * 1024) }))) as typeof fetch; await expect(bridge(fetcher).list(10)).rejects.toMatchObject({ statusCode: 502, code: "AGENT_COMPOSE_RESPONSE_TOO_LARGE" }); });
});
