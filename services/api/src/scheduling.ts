import { createHash } from "node:crypto";

export type ActivityClass = "hot" | "active" | "quiet" | "stale" | "archived";
const DAY_MS = 86_400_000;
const intervals: Record<ActivityClass, number> = { hot: 1, active: 7, quiet: 30, stale: 90, archived: 180 };

export function classifyActivity(pushedAt: string | null | undefined, archived: boolean, asOf: string): ActivityClass {
  if (archived) return "archived";
  if (!pushedAt) return "stale";
  const ageDays = Math.max(0, (Date.parse(asOf) - Date.parse(pushedAt)) / DAY_MS);
  if (ageDays <= 30) return "hot";
  if (ageDays <= 365) return "active";
  if (ageDays <= 365 * 3) return "quiet";
  return "stale";
}

export function nextCheckAt(activity: ActivityClass, fetchedAt: string, githubId: string): string {
  const digest = createHash("sha256").update(githubId).digest();
  const fraction = digest.readUInt32BE(0) / 0xffff_ffff;
  const jitter = intervals[activity] * DAY_MS * 0.1 * fraction;
  return new Date(Date.parse(fetchedAt) + intervals[activity] * DAY_MS + jitter).toISOString();
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value as object).sort().map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
const normalize = (value: string | null | undefined) => String(value ?? "").replace(/\r\n?/g, "\n").replace(/[ \t]+$/gm, "").trim();
export function snapshotHash(metadata: Record<string, unknown>, readme: string, release: string): string {
  const content = [stableJson(metadata), normalize(readme), normalize(release)].join("\n---\n");
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}
