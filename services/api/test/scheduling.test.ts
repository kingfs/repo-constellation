import { describe, expect, it } from "vitest";
import { classifyActivity, nextCheckAt, snapshotHash } from "../src/scheduling.js";

describe("adaptive scheduling", () => {
  const now = "2026-07-14T00:00:00.000Z";
  it.each([
    ["2026-07-01T00:00:00Z", false, "hot"],
    ["2026-01-01T00:00:00Z", false, "active"],
    ["2024-01-01T00:00:00Z", false, "quiet"],
    ["2020-01-01T00:00:00Z", false, "stale"],
    ["2026-07-13T00:00:00Z", true, "archived"],
  ])("classifies %s archived=%s as %s", (pushedAt, archived, expected) => expect(classifyActivity(pushedAt, archived, now)).toBe(expected));

  it("uses deterministic bounded jitter for every frequency", () => {
    const days = { hot: 1, active: 7, quiet: 30, stale: 90, archived: 180 } as const;
    for (const [activity, baseDays] of Object.entries(days)) {
      const first = nextCheckAt(activity as keyof typeof days, now, "123");
      expect(nextCheckAt(activity as keyof typeof days, now, "123")).toBe(first);
      const elapsedDays = (Date.parse(first) - Date.parse(now)) / 86_400_000;
      expect(elapsedDays).toBeGreaterThanOrEqual(baseDays);
      expect(elapsedDays).toBeLessThanOrEqual(baseDays * 1.1);
    }
  });

  it("hashes the combined metadata and preserved resource bodies deterministically", () => {
    expect(snapshotHash({ b: 2, a: 1 }, "README\r\n", "v1")).toBe(snapshotHash({ a: 1, b: 2 }, "README", "v1"));
  });
});
