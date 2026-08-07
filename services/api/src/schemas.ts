import { z } from "zod";
export { z };

export const uuid = z.string().uuid();
export const rfc3339 = z.string().datetime({ offset: true });
export const pagination = z.object({ page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(20) });
export const projectQuery = pagination.extend({
  category: z.string().min(1).max(100).optional(), language: z.string().min(1).max(100).optional(),
  activity: z.enum(["hot", "active", "quiet", "stale", "archived"]).optional(),
  sort: z.enum(["relevance", "stars", "pushed", "starred", "updated"]).default("updated"),
});
export const searchQuery = projectQuery.extend({ q: z.string().trim().min(1).max(500) });
export const updatesQuery = z.object({ since: rfc3339, limit: z.coerce.number().int().min(1).max(100).default(20) });

const star = z.object({
  githubId: z.string().regex(/^\d+$/), fullName: z.string().min(3).max(300), owner: z.string().min(1).max(100),
  name: z.string().min(1).max(100), htmlUrl: z.string().url(), description: z.string().nullable().optional(), homepage: z.string().optional(),
  defaultBranch: z.string().optional(), primaryLanguage: z.string().nullable().optional(), topics: z.array(z.string()).max(100).default([]),
  licenseSpdx: z.string().nullable().optional(), starsCount: z.number().int().nonnegative().default(0), forksCount: z.number().int().nonnegative().default(0),
  openIssuesCount: z.number().int().nonnegative().default(0), githubCreatedAt: rfc3339.optional(), githubUpdatedAt: rfc3339.optional(),
  pushedAt: rfc3339.nullable().optional(), starredAt: rfc3339, archived: z.boolean().default(false), disabled: z.boolean().default(false), hasWiki: z.boolean().default(false),
});
export const reconcileBody = z.object({ observedAt: rfc3339, repositories: z.array(star).max(100_000) });
export const githubSyncStartBody = z.object({ id: uuid, source: z.enum(["daily", "manual"]), startedAt: rfc3339 });
export const githubSyncCompleteBody = z.object({ observedAt: rfc3339, result: z.record(z.unknown()) });
export const githubSyncFailBody = z.object({ error: z.string().min(1).max(10_000) });
export const dueQuery = z.object({ asOf: rfc3339.optional(), limit: z.coerce.number().int().min(1).max(100).default(100), cursor: z.string().regex(/^\d+$/).optional() });
const resourceRefresh = z.discriminatedUnion("status", [
  z.object({ status: z.literal("modified"), text: z.string().max(5_000_000), etag: z.string().max(1000).optional() }),
  z.object({ status: z.literal("not_modified") }),
  z.object({ status: z.literal("missing") }),
]);
export const refreshBody = z.object({ metadata: z.record(z.unknown()), readme: resourceRefresh, release: resourceRefresh, fetchedAt: rfc3339 });
export const snapshotBody = z.object({
  contentHash: z.string().regex(/^sha256:[a-f0-9]{64}$/), metadata: z.record(z.unknown()), readmeText: z.string().max(5_000_000).optional(),
  readmeEtag: z.string().max(1000).optional(), releaseText: z.string().max(2_000_000).optional(), releaseEtag: z.string().max(1000).optional(), fetchedAt: rfc3339,
});
const executionContext = { runId: z.string().min(1).max(200).optional(), sandboxId: z.string().min(1).max(200).optional() };
export const claimBody = z.object({ types: z.array(z.enum(["analyze_repository", "index_repository", "refresh_repository"])).min(1).max(10), workerId: z.string().min(1).max(200), limit: z.number().int().min(1).max(100), leaseSeconds: z.number().int().min(30).max(86_400), minPriority: z.number().int().min(-1000).max(1000).default(-1000), ...executionContext });
export const heartbeatBody = z.object({ workerId: z.string().min(1).max(200), leaseSeconds: z.number().int().min(30).max(86_400), ...executionContext });
export const completeBody = z.object({ workerId: z.string().min(1).max(200), result: z.record(z.unknown()).optional(), ...executionContext });
export const failBody = completeBody.extend({ error: z.string().min(1).max(20_000), retryable: z.boolean() });
export const operationalJobsQuery = pagination.extend({
  status: z.enum(["failed", "dead", "running"]),
  type: z.enum(["analyze_repository", "index_repository", "refresh_repository"]).optional(),
  repositoryId: uuid.optional(),
});
export const recentFailuresQuery = z.object({ limit: z.coerce.number().int().min(1).max(100).default(30) });
export const reconcileAnalysisBody = z.object({ limit: z.number().int().min(1).max(1000).default(500) });
export const reanalyzeBody = z.object({ analysisVersion: z.string().min(1).max(100) });
export const controlOperation = z.enum(["sync", "curate"]);
export const controlRunBody = z.object({ operation: controlOperation });
export const agentRunsQuery = z.object({ limit: z.coerce.number().int().min(1).max(100).default(30) });
export const agentRunLogsQuery = z.object({ tail: z.coerce.number().int().min(1).max(200).default(100) });
export const agentRunId = z.string().regex(/^[a-f0-9]{64}$/);
export const controlClaimBody = z.object({ operation: controlOperation, workerId: z.string().min(1).max(200), leaseSeconds: z.number().int().min(60).max(86_400) });
export const controlCompleteBody = z.object({ workerId: z.string().min(1).max(200), result: z.record(z.unknown()) });
export const controlFailBody = z.object({ workerId: z.string().min(1).max(200), error: z.string().min(1).max(10_000) });
export const analysis = z.object({
  nameZh: z.string().max(300).optional(), summaryZh: z.string().min(1).max(20_000), categories: z.array(z.string()).max(50), keywords: z.array(z.string()).max(200),
  aliases: z.array(z.string()).max(200), useCases: z.array(z.string()).max(100), problemsSolved: z.array(z.string()).max(100), targetUsers: z.array(z.string()).max(100),
  technologies: z.array(z.string()).max(100), maturity: z.string().max(100).optional(), maintenanceStatus: z.string().max(100).optional(), limitations: z.array(z.string()).max(100), confidence: z.number().min(0).max(1).optional(),
});
export const analysisBody = z.object({ snapshotId: uuid, contentHash: z.string().regex(/^sha256:[a-f0-9]{64}$/), analysisVersion: z.string().min(1).max(100), model: z.string().min(1).max(200), analysis });
export const toolSearchBody = z.object({ query: z.string().trim().min(1).max(500), filters: z.object({ category: z.string().optional(), language: z.string().optional(), activity: z.string().optional() }).default({}), sort: z.enum(["relevance", "stars", "pushed", "starred", "updated"]).default("relevance"), limit: z.number().int().min(1).max(20).default(10) });
export const batchBody = z.object({ ids: z.array(uuid).min(1).max(100), fields: z.array(z.string()).max(100).optional() });
export const compareBody = z.object({ ids: z.array(uuid).min(2).max(10) });
export const agentSearchBody = z.object({ query: z.string().trim().min(2).max(500) });
export const feedbackBody = z.object({
  queryId: uuid, queryText: z.string().trim().min(1).max(500), resultRepositoryIds: z.array(uuid).max(100),
  selectedRepositoryId: uuid.optional(), rating: z.union([z.literal(-1), z.literal(1)]).optional(),
  action: z.enum(["click", "favorite", "helpful", "unhelpful"]).optional(), metadata: z.record(z.unknown()).default({}),
}).refine((value) => value.rating != null || value.action != null, "rating or action is required");

export function parse<T extends z.ZodTypeAny>(schema: T, value: unknown): z.output<T> { return schema.parse(value); }
