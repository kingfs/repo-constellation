import { randomUUID } from "node:crypto";
import { Pool, type PoolClient, type QueryResultRow } from "pg";
import type { IndexSourceAdapter, JobAdapter, RepositoryAdapter } from "./adapters.js";
import type { ActiveJob, Analysis, AnalysisInput, AnalysisQueueReconcileResult, AnalysisTaskStatus, AgentSearchEvent, AgentSearchRun, ClaimedJob, ControlOperation, ControlRun, DuePage, GithubSyncRun, GithubSyncSource, GithubSyncStatus, JobExecutionContext, JobQuery, JobQueueSummary, OperationalJob, Page, Project, ProjectQuery, QueryFeedbackInput, RecentJobFailure, RefreshInput, RepositoryIndexSource, ResourceRefresh, SnapshotInput, StarInput } from "./domain.js";
import type { AgentSearchStore } from "./search-agent.js";
import { classifyActivity, nextCheckAt, snapshotHash } from "./scheduling.js";

const iso = (v: unknown): string | null => v instanceof Date ? v.toISOString() : v == null ? null : String(v);
function operationalJob(row: QueryResultRow): OperationalJob {
  return {
    id: row.id, type: row.type, repositoryId: row.repository_id, dedupeKey: row.dedupe_key, status: row.status, priority: row.priority,
    attempts: row.attempts, maxAttempts: row.max_attempts, availableAt: iso(row.available_at)!, leasedUntil: iso(row.leased_until), leasedBy: row.leased_by,
    payload: row.payload, lastError: row.last_error, createdAt: iso(row.created_at)!, completedAt: iso(row.completed_at),
    startedAt: iso(row.started_at), lastHeartbeatAt: iso(row.last_heartbeat_at), runId: row.last_run_id, sandboxId: row.last_sandbox_id,
  };
}
function controlRun(row: QueryResultRow): ControlRun { return { id: row.id, operation: row.operation, status: row.status, requestedAt: iso(row.requested_at)!, startedAt: iso(row.started_at), completedAt: iso(row.completed_at), leasedUntil: iso(row.leased_until), workerId: row.worker_id, result: row.result, error: row.error }; }
function githubSyncRun(row: QueryResultRow | undefined): GithubSyncRun | null { return row ? { id: row.id, source: row.source, status: row.status, startedAt: iso(row.started_at)!, completedAt: iso(row.completed_at), observedAt: iso(row.observed_at), result: row.result, error: row.error } : null; }
function project(row: QueryResultRow): Project {
  return {
    id: row.id, githubId: String(row.github_id), fullName: row.full_name, owner: row.owner, name: row.name, htmlUrl: row.html_url,
    description: row.description, primaryLanguage: row.primary_language, topics: row.topics ?? [], licenseSpdx: row.license_spdx,
    starsCount: row.stars_count, forksCount: row.forks_count, openIssuesCount: row.open_issues_count, pushedAt: iso(row.pushed_at),
    githubUpdatedAt: iso(row.github_updated_at), starredAt: iso(row.starred_at), unstarredAt: iso(row.unstarred_at), archived: row.archived,
    activityClass: row.activity_class, updatedAt: iso(row.updated_at)!, analysis: row.summary_zh == null ? null : {
      nameZh: row.name_zh ?? undefined, summaryZh: row.summary_zh, categories: row.categories ?? [], keywords: row.keywords ?? [], aliases: row.aliases ?? [],
      useCases: row.use_cases ?? [], problemsSolved: row.problems_solved ?? [], targetUsers: row.target_users ?? [], technologies: row.technologies ?? [],
      maturity: row.maturity ?? undefined, maintenanceStatus: row.maintenance_status ?? undefined, limitations: row.limitations ?? [], confidence: row.confidence ?? undefined,
    },
  };
}
const select = `SELECT r.*, a.name_zh, a.summary_zh, a.categories, a.keywords, a.aliases, a.use_cases, a.problems_solved, a.target_users, a.technologies, a.maturity, a.maintenance_status, a.limitations, a.confidence
FROM repositories r LEFT JOIN LATERAL (SELECT * FROM repository_analyses ra WHERE ra.repository_id=r.id ORDER BY ra.analyzed_at DESC LIMIT 1) a ON true`;

export class PostgresAdapter implements RepositoryAdapter, JobAdapter, IndexSourceAdapter, AgentSearchStore {
  private concurrency: { analysisMinConcurrency: number; analysisMaxConcurrency: number; analysisInitialConcurrency: number };
  constructor(readonly pool: Pool, concurrency: Partial<{ analysisMinConcurrency: number; analysisMaxConcurrency: number; analysisInitialConcurrency: number }> = {}) {
    this.concurrency = { analysisMinConcurrency: concurrency.analysisMinConcurrency ?? 1, analysisMaxConcurrency: concurrency.analysisMaxConcurrency ?? 4, analysisInitialConcurrency: concurrency.analysisInitialConcurrency ?? 2 };
  }
  async acquireIndexLock(): Promise<() => Promise<void>> {
    const client = await this.pool.connect();
    await client.query("SELECT pg_advisory_lock(hashtextextended('meilisearch:index:repositories',0))");
    return async () => { try { await client.query("SELECT pg_advisory_unlock(hashtextextended('meilisearch:index:repositories',0))"); } finally { client.release(); } };
  }
  async ping() { await this.pool.query("SELECT 1"); }
  async startGithubSync(id: string, source: GithubSyncSource, startedAt: string) {
    await this.pool.query(`INSERT INTO github_star_sync_runs(id,source,status,started_at) VALUES($1,$2,'running',$3)
ON CONFLICT(id) DO UPDATE SET source=excluded.source,status='running',started_at=excluded.started_at,completed_at=NULL,observed_at=NULL,result=NULL,error=NULL`, [id, source, startedAt]);
  }
  async completeGithubSync(id: string, observedAt: string, result: Record<string, unknown>) {
    const updated = await this.pool.query("UPDATE github_star_sync_runs SET status='succeeded',completed_at=now(),observed_at=$2,result=$3,error=NULL WHERE id=$1", [id, observedAt, result]);
    if (!updated.rowCount) throw Object.assign(new Error("GitHub sync run not found"), { statusCode: 404, code: "GITHUB_SYNC_RUN_NOT_FOUND" });
  }
  async failGithubSync(id: string, error: string) {
    const updated = await this.pool.query("UPDATE github_star_sync_runs SET status='failed',completed_at=now(),error=$2 WHERE id=$1", [id, error]);
    if (!updated.rowCount) throw Object.assign(new Error("GitHub sync run not found"), { statusCode: 404, code: "GITHUB_SYNC_RUN_NOT_FOUND" });
  }
  async githubSyncStatus(): Promise<GithubSyncStatus> {
    const result = await this.pool.query(`SELECT
  (SELECT row_to_json(r) FROM (SELECT * FROM github_star_sync_runs WHERE source='daily' ORDER BY started_at DESC LIMIT 1) r) latest,
  (SELECT row_to_json(r) FROM (SELECT * FROM github_star_sync_runs WHERE source='daily' AND status='succeeded' ORDER BY started_at DESC LIMIT 1) r) successful`);
    const checkedAt = new Date(); const latest = githubSyncRun(result.rows[0]?.latest); const successful = githubSyncRun(result.rows[0]?.successful);
    const fresh = successful != null && checkedAt.getTime() - new Date(successful.completedAt!).getTime() <= 26 * 60 * 60 * 1000;
    return { latestDaily: latest, lastSuccessfulDaily: successful, healthy: fresh && latest?.status !== "failed", staleAfterHours: 26, checkedAt: checkedAt.toISOString() };
  }
  async list(q: ProjectQuery): Promise<Page<Project>> {
    const where = ["r.unstarred_at IS NULL"], values: unknown[] = [];
    if (q.category) { values.push(q.category); where.push(`$${values.length}=ANY(a.categories)`); }
    if (q.language) { values.push(q.language); where.push(`r.primary_language=$${values.length}`); }
    if (q.activity) { values.push(q.activity); where.push(`r.activity_class=$${values.length}`); }
    const order: Record<string, string> = { stars: "r.stars_count DESC", pushed: "r.pushed_at DESC NULLS LAST", starred: "r.starred_at DESC NULLS LAST", updated: "r.updated_at DESC" };
    const count = await this.pool.query(`SELECT count(*)::int total FROM repositories r LEFT JOIN LATERAL (SELECT categories FROM repository_analyses ra WHERE ra.repository_id=r.id ORDER BY analyzed_at DESC LIMIT 1) a ON true WHERE ${where.join(" AND ")}`, values);
    values.push(q.pageSize, (q.page - 1) * q.pageSize);
    const rows = await this.pool.query(`${select} WHERE ${where.join(" AND ")} ORDER BY ${order[q.sort ?? "updated"] ?? order.updated} LIMIT $${values.length - 1} OFFSET $${values.length}`, values);
    return { items: rows.rows.map(project), page: q.page, pageSize: q.pageSize, total: count.rows[0].total };
  }
  async get(id: string) { const r = await this.pool.query(`${select} WHERE r.id=$1`, [id]); return r.rowCount ? project(r.rows[0]) : null; }
  async getMany(ids: string[]) { if (!ids.length) return []; const r = await this.pool.query(`${select} WHERE r.id=ANY($1::uuid[])`, [ids]); const byId = new Map(r.rows.map((x) => [x.id, project(x)])); return ids.flatMap((id) => byId.has(id) ? [byId.get(id)!] : []); }
  async updates(since: string, limit: number) { const r = await this.pool.query(`${select} WHERE r.unstarred_at IS NULL AND greatest(r.github_updated_at,r.updated_at)>=$1 ORDER BY greatest(r.github_updated_at,r.updated_at) DESC LIMIT $2`, [since, limit]); return r.rows.map(project); }
  async categories() { const r = await this.pool.query(`SELECT category name,count(DISTINCT repository_id)::int count FROM repository_analyses,unnest(categories) category GROUP BY category ORDER BY count DESC,name`); return r.rows; }
  async stats() {
    const result = await this.pool.query(`SELECT
  count(*)::int AS total_stars,
  count(*) FILTER (WHERE r.current_snapshot_id IS NOT NULL)::int AS synced_repositories,
  count(*) FILTER (WHERE EXISTS (
    SELECT 1 FROM repository_analyses ra
    WHERE ra.repository_id=r.id AND ra.snapshot_id=r.current_snapshot_id
  ))::int AS analyzed_repositories,
  max(r.updated_at) AS updated_at
FROM repositories r WHERE r.unstarred_at IS NULL`);
    const row = result.rows[0];
    const totalStars = row.total_stars ?? 0;
    const analyzedRepositories = row.analyzed_repositories ?? 0;
    return { totalStars, syncedRepositories: row.synced_repositories ?? 0, analyzedRepositories, pendingAnalysis: Math.max(0, totalStars - analyzedRepositories), updatedAt: iso(row.updated_at) };
  }
  async readme(id: string, maxChars: number) { const r = await this.pool.query(`SELECT s.readme_text,s.fetched_at FROM repositories r JOIN repository_snapshots s ON s.id=r.current_snapshot_id WHERE r.id=$1`, [id]); if (!r.rowCount || r.rows[0].readme_text == null) return null; const raw: string = r.rows[0].readme_text; return { text: raw.slice(0, maxChars), truncated: raw.length > maxChars, dataUpdatedAt: iso(r.rows[0].fetched_at)! }; }
  async getIndexSource(repositoryId: string): Promise<RepositoryIndexSource | null> {
    const r = await this.pool.query(`SELECT r.id,r.github_id,r.full_name,r.owner,r.name,r.html_url,r.description,r.primary_language,r.topics,r.license_spdx,r.stars_count,r.forks_count,r.open_issues_count,r.pushed_at,r.starred_at,r.github_updated_at,r.activity_class,r.archived,r.unstarred_at,r.updated_at,s.readme_text,
a.name_zh,a.summary_zh,a.categories,a.keywords,a.aliases,a.use_cases,a.problems_solved,a.target_users,a.technologies,a.maturity,a.maintenance_status,a.limitations,a.confidence
FROM repositories r LEFT JOIN repository_snapshots s ON s.id=r.current_snapshot_id
LEFT JOIN LATERAL (SELECT * FROM repository_analyses ra WHERE ra.repository_id=r.id ORDER BY ra.analyzed_at DESC LIMIT 1) a ON true WHERE r.id=$1`, [repositoryId]);
    if (!r.rowCount) return null;
    const x = r.rows[0];
    const analysis: Analysis | null = x.summary_zh == null ? null : { nameZh: x.name_zh ?? undefined, summaryZh: x.summary_zh, categories: x.categories ?? [], keywords: x.keywords ?? [], aliases: x.aliases ?? [], useCases: x.use_cases ?? [], problemsSolved: x.problems_solved ?? [], targetUsers: x.target_users ?? [], technologies: x.technologies ?? [], maturity: x.maturity ?? undefined, maintenanceStatus: x.maintenance_status ?? undefined, limitations: x.limitations ?? [], confidence: x.confidence ?? undefined };
    return { id: x.id, githubId: String(x.github_id), fullName: x.full_name, owner: x.owner, name: x.name, htmlUrl: x.html_url, description: x.description, primaryLanguage: x.primary_language, topics: x.topics ?? [], licenseSpdx: x.license_spdx, starsCount: x.stars_count, forksCount: x.forks_count, openIssuesCount: x.open_issues_count, pushedAt: iso(x.pushed_at), starredAt: iso(x.starred_at), githubUpdatedAt: iso(x.github_updated_at), activityClass: x.activity_class, archived: x.archived, unstarredAt: iso(x.unstarred_at), updatedAt: iso(x.updated_at)!, readmeText: x.readme_text, analysis };
  }
  async listIndexSourceIds(afterId: string | null, limit: number): Promise<string[]> {
    const r = await this.pool.query("SELECT id FROM repositories WHERE ($1::uuid IS NULL OR id>$1::uuid) ORDER BY id LIMIT $2", [afterId, limit]);
    return r.rows.map((x) => String(x.id));
  }
  async dueRepositories(asOf: string, limit: number, cursor?: string): Promise<DuePage> {
    const r = await this.pool.query(`SELECT r.github_id::text github_id,r.full_name,s.readme_etag,s.release_etag,r.next_check_at
FROM repositories r LEFT JOIN repository_snapshots s ON s.id=r.current_snapshot_id
WHERE r.unstarred_at IS NULL AND r.next_check_at<=$1 AND ($2::bigint IS NULL OR r.github_id>$2::bigint)
ORDER BY r.github_id LIMIT $3`, [asOf, cursor ?? null, limit]);
    const items = r.rows.map((x) => ({ githubId: x.github_id, fullName: x.full_name, readmeEtag: x.readme_etag ?? null, releaseEtag: x.release_etag ?? null, nextCheckAt: iso(x.next_check_at)! }));
    return { items, nextCursor: items.length === limit ? items.at(-1)!.githubId : null };
  }
  async tx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> { const c = await this.pool.connect(); try { await c.query("BEGIN"); const v = await fn(c); await c.query("COMMIT"); return v; } catch (e) { await c.query("ROLLBACK"); throw e; } finally { c.release(); } }
  async reconcile(observedAt: string, repos: StarInput[], key: string) {
    return this.tx(async (c) => {
      await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`reconcile:${key}`]);
      for (const x of repos) {
        const activity = classifyActivity(typeof x.pushedAt === "string" ? x.pushedAt : null, x.archived === true, observedAt);
        const saved = await c.query(`INSERT INTO repositories (id,github_id,full_name,owner,name,html_url,description,homepage,default_branch,primary_language,topics,license_spdx,stars_count,forks_count,open_issues_count,github_created_at,github_updated_at,pushed_at,starred_at,archived,disabled,has_wiki,activity_class,next_check_at,created_at,updated_at)
VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,now(),now()) ON CONFLICT (github_id) DO UPDATE SET full_name=excluded.full_name,owner=excluded.owner,name=excluded.name,html_url=excluded.html_url,description=excluded.description,homepage=excluded.homepage,default_branch=excluded.default_branch,primary_language=excluded.primary_language,topics=excluded.topics,license_spdx=excluded.license_spdx,stars_count=excluded.stars_count,forks_count=excluded.forks_count,open_issues_count=excluded.open_issues_count,github_updated_at=excluded.github_updated_at,pushed_at=excluded.pushed_at,starred_at=excluded.starred_at,archived=excluded.archived,disabled=excluded.disabled,has_wiki=excluded.has_wiki,activity_class=excluded.activity_class,next_check_at=CASE WHEN repositories.pushed_at IS DISTINCT FROM excluded.pushed_at THEN excluded.next_check_at ELSE coalesce(repositories.next_check_at,excluded.next_check_at) END,unstarred_at=NULL,updated_at=now() RETURNING id`, [randomUUID(), x.githubId, x.fullName, x.owner, x.name, x.htmlUrl, x.description ?? null, x.homepage ?? null, x.defaultBranch ?? null, x.primaryLanguage ?? null, x.topics ?? [], x.licenseSpdx ?? null, x.starsCount ?? 0, x.forksCount ?? 0, x.openIssuesCount ?? 0, x.githubCreatedAt ?? null, x.githubUpdatedAt ?? null, x.pushedAt ?? null, x.starredAt ?? null, x.archived ?? false, x.disabled ?? false, x.hasWiki ?? false, activity, observedAt]);
        if (saved.rowCount) await this.insertJob(c, "index_repository", saved.rows[0].id, `index:base:${saved.rows[0].id}:${snapshotHash(x, "", "")}`, { source: "stars_reconcile" });
      }
      const ids = repos.map((r) => r.githubId); const u = await c.query(`UPDATE repositories SET unstarred_at=$1,updated_at=now() WHERE unstarred_at IS NULL AND NOT (github_id::text=ANY($2::text[])) RETURNING id`, [observedAt, ids]);
      for (const row of u.rows) await this.insertJob(c, "index_repository", row.id, `index:unstarred:${row.id}:${observedAt}`, { unstarredAt: observedAt });
      return { upserted: repos.length, unstarred: u.rows.length };
    });
  }
  async saveSnapshot(githubId: string, input: SnapshotInput, key: string) {
    return this.tx(async (c) => {
      await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`snapshot:${key}`]);
      const repo = await c.query("SELECT id,current_snapshot_id,full_name,activity_class FROM repositories WHERE github_id=$1 FOR UPDATE", [githubId]); if (!repo.rowCount) throw Object.assign(new Error("repository not found"), { statusCode: 404, code: "PROJECT_NOT_FOUND" });
      const scheduled = nextCheckAt(repo.rows[0].activity_class, input.fetchedAt, githubId);
      const existing = await c.query("SELECT id FROM repository_snapshots WHERE repository_id=$1 AND content_hash=$2", [repo.rows[0].id, input.contentHash]);
      if (existing.rowCount) { await c.query("UPDATE repositories SET current_snapshot_id=$1,last_checked_at=$2,next_check_at=$3,updated_at=now() WHERE id=$4", [existing.rows[0].id, input.fetchedAt, scheduled, repo.rows[0].id]); return { snapshotId: existing.rows[0].id, changed: false, analysisJobId: null }; }
      const snapshotId = randomUUID(); await c.query(`INSERT INTO repository_snapshots(id,repository_id,content_hash,metadata,readme_text,readme_etag,release_text,release_etag,fetched_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [snapshotId, repo.rows[0].id, input.contentHash, input.metadata, input.readmeText ?? null, input.readmeEtag ?? null, input.releaseText ?? null, input.releaseEtag ?? null, input.fetchedAt]);
      await c.query("UPDATE repositories SET current_snapshot_id=$1,last_checked_at=$2,next_check_at=$3,updated_at=now() WHERE id=$4", [snapshotId, input.fetchedAt, scheduled, repo.rows[0].id]);
      const job = await this.insertJob(c, "analyze_repository", repo.rows[0].id, `analyze:${repo.rows[0].id}:${input.contentHash}`, { snapshotId, contentHash: input.contentHash, fullName: repo.rows[0].full_name, metadata: input.metadata, readmeText: input.readmeText ?? null, releaseText: input.releaseText ?? null });
      return { snapshotId, changed: true, analysisJobId: job };
    });
  }
  async refresh(githubId: string, input: RefreshInput, key: string) {
    return this.tx(async (c) => {
      await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`refresh:${key}`]);
      const repo = await c.query(`SELECT r.id,r.full_name,r.activity_class,r.current_snapshot_id,s.readme_text,s.readme_etag,s.release_text,s.release_etag
FROM repositories r LEFT JOIN repository_snapshots s ON s.id=r.current_snapshot_id WHERE r.github_id=$1 AND r.unstarred_at IS NULL FOR UPDATE OF r`, [githubId]);
      if (!repo.rowCount) throw Object.assign(new Error("repository not found"), { statusCode: 404, code: "PROJECT_NOT_FOUND" });
      const row = repo.rows[0];
      const resolve = (part: ResourceRefresh, oldText: string | null, oldEtag: string | null, name: string) => {
        if (part.status === "not_modified") {
          if (!row.current_snapshot_id) throw Object.assign(new Error(`${name} cannot be not_modified without a current snapshot`), { statusCode: 409, code: "SNAPSHOT_PRECONDITION_FAILED" });
          return { text: oldText ?? "", etag: oldEtag ?? "" };
        }
        if (part.status === "missing") return { text: "", etag: "" };
        return { text: part.text, etag: part.etag ?? "" };
      };
      const readme = resolve(input.readme, row.readme_text, row.readme_etag, "README");
      const release = resolve(input.release, row.release_text, row.release_etag, "release");
      const hash = snapshotHash(input.metadata, readme.text, release.text);
      const scheduled = nextCheckAt(row.activity_class, input.fetchedAt, githubId);
      const existing = await c.query("SELECT id FROM repository_snapshots WHERE repository_id=$1 AND content_hash=$2", [row.id, hash]);
      if (existing.rowCount) {
        await c.query("UPDATE repositories SET current_snapshot_id=$1,last_checked_at=$2,next_check_at=$3,updated_at=now() WHERE id=$4", [existing.rows[0].id, input.fetchedAt, scheduled, row.id]);
        return { snapshotId: existing.rows[0].id, changed: false, analysisJobId: null, nextCheckAt: scheduled };
      }
      const snapshotId = randomUUID();
      await c.query(`INSERT INTO repository_snapshots(id,repository_id,content_hash,metadata,readme_text,readme_etag,release_text,release_etag,fetched_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [snapshotId, row.id, hash, input.metadata, readme.text, readme.etag, release.text, release.etag, input.fetchedAt]);
      await c.query("UPDATE repositories SET current_snapshot_id=$1,last_checked_at=$2,next_check_at=$3,updated_at=now() WHERE id=$4", [snapshotId, input.fetchedAt, scheduled, row.id]);
      const job = await this.insertJob(c, "analyze_repository", row.id, `analyze:${row.id}:${hash}`, { snapshotId, contentHash: hash, fullName: row.full_name, metadata: input.metadata, readmeText: readme.text, releaseText: release.text });
      return { snapshotId, changed: true, analysisJobId: job, nextCheckAt: scheduled };
    });
  }
  async saveAnalysis(repositoryId: string, input: AnalysisInput, key: string) {
    return this.tx(async (c) => {
      await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`analysis:${key}`]); const a = input.analysis;
      const inserted = await c.query(`INSERT INTO repository_analyses(id,repository_id,snapshot_id,content_hash,analysis_version,model,name_zh,summary_zh,categories,keywords,aliases,use_cases,problems_solved,target_users,technologies,maturity,maintenance_status,limitations,confidence,analysis_json,analyzed_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,now()) ON CONFLICT(repository_id,content_hash,analysis_version) DO UPDATE SET model=excluded.model,analysis_json=excluded.analysis_json RETURNING id`, [randomUUID(), repositoryId, input.snapshotId, input.contentHash, input.analysisVersion, input.model, a.nameZh ?? null, a.summaryZh, a.categories, a.keywords, a.aliases, a.useCases, a.problemsSolved, a.targetUsers, a.technologies, a.maturity ?? null, a.maintenanceStatus ?? null, a.limitations, a.confidence ?? null, a]);
      const indexJobId = await this.insertJob(c, "index_repository", repositoryId, `index:${repositoryId}:${input.contentHash}:${input.analysisVersion}`, { analysisId: inserted.rows[0].id }); return { analysisId: inserted.rows[0].id, indexJobId };
    });
  }
  private async insertJob(c: PoolClient, type: string, repositoryId: string, dedupeKey: string, payload: object) { const id = randomUUID(); const r = await c.query(`INSERT INTO jobs(id,type,repository_id,dedupe_key,status,priority,attempts,max_attempts,available_at,payload,created_at) VALUES($1,$2,$3,$4,'pending',0,0,5,now(),$5,now()) ON CONFLICT(dedupe_key) DO UPDATE SET dedupe_key=excluded.dedupe_key RETURNING id`, [id, type, repositoryId, dedupeKey, payload]); return r.rows[0].id as string; }
  async claim(types: string[], workerId: string, limit: number, leaseSeconds: number, minPriority = -1000, context: JobExecutionContext = {}): Promise<ClaimedJob[]> { return this.tx(async (c) => {
    if (types.includes("analyze_repository")) await c.query(`UPDATE jobs SET status=CASE WHEN attempts>=max_attempts THEN 'dead' ELSE 'pending' END,available_at=now(),completed_at=CASE WHEN attempts>=max_attempts THEN now() ELSE NULL END,leased_until=NULL,leased_by=NULL,last_error=CASE WHEN attempts>=max_attempts THEN 'worker heartbeat lost after maximum attempts' ELSE 'worker heartbeat lost; lease reclaimed' END,last_run_id=NULL,last_sandbox_id=NULL
WHERE type='analyze_repository' AND status='running' AND last_heartbeat_at<now()-interval '2 minutes'`);
    if (types.includes("analyze_repository")) await c.query(`UPDATE jobs j SET status='succeeded',completed_at=now(),leased_until=NULL,leased_by=NULL,last_error='skipped: analysis already exists or snapshot is no longer current'
FROM repositories r WHERE j.repository_id=r.id AND j.type='analyze_repository' AND coalesce((j.payload->>'force')::boolean,false)=false
  AND (j.status='pending' OR (j.status='running' AND j.leased_until<now()))
  AND (r.unstarred_at IS NOT NULL OR r.current_snapshot_id::text IS DISTINCT FROM j.payload->>'snapshotId'
    OR EXISTS (SELECT 1 FROM repository_analyses ra WHERE ra.repository_id=j.repository_id AND ra.content_hash=j.payload->>'contentHash'))`);
    await c.query(`UPDATE jobs SET status='dead',completed_at=now(),leased_until=NULL,leased_by=NULL,last_error=coalesce(last_error,'lease expired after maximum attempts') WHERE type=ANY($1) AND status='running' AND leased_until<now() AND attempts>=max_attempts`, [types]);
    let effectiveLimit = limit;
    if (types.includes("analyze_repository")) {
      await c.query("SELECT pg_advisory_xact_lock(hashtextextended('analysis-concurrency',0))");
      const capacity = await this.adjustAnalysisConcurrency(c);
      const active = await c.query("SELECT count(*)::int count FROM jobs WHERE type='analyze_repository' AND status='running' AND leased_until>=now()");
      const remaining = Math.max(0, capacity - (active.rows[0]?.count ?? 0));
      effectiveLimit = Math.min(limit, remaining);
      if (effectiveLimit === 0) return [];
    }
    const r = await c.query(`WITH picked AS (SELECT id FROM jobs WHERE type=ANY($1) AND priority >= $5 AND attempts<max_attempts AND ((status='pending' AND available_at<=now()) OR (status='running' AND leased_until<now())) ORDER BY priority DESC,available_at,created_at FOR UPDATE SKIP LOCKED LIMIT $2) UPDATE jobs j SET status='running',completed_at=NULL,leased_by=$3,leased_until=now()+($4::text||' seconds')::interval,attempts=attempts+1,started_at=now(),last_heartbeat_at=now(),last_run_id=$6,last_sandbox_id=$7 FROM picked WHERE j.id=picked.id RETURNING j.*`, [types, effectiveLimit, workerId, leaseSeconds, minPriority, context.runId ?? null, context.sandboxId ?? null]);
    return r.rows.map((x) => ({ id: x.id, type: x.type, repositoryId: x.repository_id, payload: x.payload, attempts: x.attempts, leasedUntil: iso(x.leased_until)! }));
  }); }
  async heartbeat(id: string, workerId: string, leaseSeconds: number, key: string, context: JobExecutionContext = {}) {
    const result = await this.pool.query(`UPDATE jobs SET last_heartbeat_at=now(),leased_until=now()+($3::text||' seconds')::interval,last_run_id=coalesce($4,last_run_id),last_sandbox_id=coalesce($5,last_sandbox_id)
WHERE id=$1 AND status='running' AND leased_by=$2 AND leased_until>=now() RETURNING leased_until`, [id, workerId, leaseSeconds, context.runId ?? null, context.sandboxId ?? null]);
    if (!result.rowCount) throw Object.assign(new Error("job lease not found"), { statusCode: 409, code: "JOB_LEASE_CONFLICT" });
    return { leasedUntil: iso(result.rows[0].leased_until)! };
  }
  private async adjustAnalysisConcurrency(c: PoolClient): Promise<number> {
    const { analysisMinConcurrency: min, analysisMaxConcurrency: max, analysisInitialConcurrency: initial } = this.concurrency;
    await c.query(`INSERT INTO analysis_concurrency_state(current_limit,reason) VALUES($1,'initialized') ON CONFLICT(singleton) DO NOTHING`, [initial]);
    const state = await c.query("SELECT * FROM analysis_concurrency_state WHERE singleton=true FOR UPDATE");
    const stats = await c.query(`SELECT
  count(*) FILTER (WHERE status='succeeded' AND last_error IS NULL AND completed_at>=now()-interval '5 minutes')::int successes,
  count(*) FILTER (WHERE attempts>0 AND last_heartbeat_at>=now()-interval '5 minutes' AND (status IN ('failed','dead') OR (status='pending' AND last_error IS NOT NULL)))::int failures,
  percentile_cont(0.95) WITHIN GROUP (ORDER BY extract(epoch FROM (completed_at-started_at))) FILTER (WHERE status='succeeded' AND last_error IS NULL AND started_at IS NOT NULL AND completed_at>=now()-interval '5 minutes') p95,
  count(*) FILTER (WHERE status='pending')::int backlog,
  bool_or(last_error ~* '(429|rate.?limit|out of memory|oom|timeout|unavailable)') FILTER (WHERE last_heartbeat_at>=now()-interval '1 minute') severe
FROM jobs WHERE type='analyze_repository'`);
    const row = state.rows[0] ?? { current_limit: initial, last_adjusted_at: new Date(), reason: "initialized" };
    const metric = stats.rows[0] ?? { successes: 0, failures: 0, p95: null, backlog: 0, severe: false };
    let current = Math.min(max, Math.max(min, row.current_limit));
    const successes = metric.successes ?? 0, failures = metric.failures ?? 0, samples = successes + failures, p95 = metric.p95 == null ? null : Number(metric.p95);
    const adjustedAgo = Date.now() - new Date(row.last_adjusted_at).getTime(); let reason = row.reason, adjusted = false;
    const pressure = metric.severe || (samples >= 5 && failures / samples >= 0.1) || (p95 != null && p95 > 120);
    const pressureCooldown = metric.severe ? 60_000 : 2 * 60_000;
    const healthy = metric.backlog >= current && successes >= current && failures / samples < 0.05 && p95 != null && p95 < 90;
    if (current > min && adjustedAgo >= pressureCooldown && pressure) { current -= 1; reason = metric.severe ? "provider pressure in 1m window" : p95 != null && p95 > 120 ? "p95 latency above 120s in 5m window" : "failure rate above 10% in 5m window"; adjusted = true; }
    else if (current < max && adjustedAgo >= 3 * 60_000 && healthy) { current += 1; reason = "healthy 5m window with relative backlog"; adjusted = true; }
    await c.query(`UPDATE analysis_concurrency_state SET current_limit=$1,reason=$2,success_count=$3,failure_count=$4,p95_seconds=$5,backlog=$6,updated_at=now(),last_adjusted_at=CASE WHEN $7 THEN now() ELSE last_adjusted_at END WHERE singleton=true`, [current, reason, successes, failures, p95, metric.backlog ?? 0, adjusted]);
    return current;
  }
  async complete(id: string, workerId: string, key: string, context: JobExecutionContext = {}) { const r = await this.pool.query(`UPDATE jobs SET status='succeeded',completed_at=now(),leased_until=NULL,leased_by=NULL,last_error=NULL,last_heartbeat_at=now(),last_run_id=coalesce($3,last_run_id),last_sandbox_id=coalesce($4,last_sandbox_id) WHERE id=$1 AND status='running' AND leased_by=$2`, [id, workerId, context.runId ?? null, context.sandboxId ?? null]); if (!r.rowCount) { const prior = await this.pool.query("SELECT 1 FROM jobs WHERE id=$1 AND status='succeeded'", [id]); if (!prior.rowCount) throw Object.assign(new Error("job lease not found"), { statusCode: 409, code: "JOB_LEASE_CONFLICT" }); } }
  async fail(id: string, workerId: string, error: string, retryable: boolean, key: string, context: JobExecutionContext = {}) { const r = await this.pool.query(`UPDATE jobs SET status=CASE WHEN $3 AND attempts<max_attempts THEN 'pending' WHEN attempts>=max_attempts THEN 'dead' ELSE 'failed' END,last_error=$4,available_at=CASE WHEN $3 AND attempts<max_attempts THEN now()+(power(2,least(greatest(attempts-1,0),8))::text||' minutes')::interval ELSE available_at END,completed_at=CASE WHEN attempts>=max_attempts OR NOT $3 THEN now() ELSE NULL END,leased_until=NULL,leased_by=NULL,last_heartbeat_at=now(),last_run_id=coalesce($5,last_run_id),last_sandbox_id=coalesce($6,last_sandbox_id) WHERE id=$1 AND status='running' AND leased_by=$2`, [id, workerId, retryable, error, context.runId ?? null, context.sandboxId ?? null]); if (!r.rowCount) { const prior = await this.pool.query("SELECT 1 FROM jobs WHERE id=$1 AND last_error=$2 AND status IN ('pending','failed','dead')", [id, error]); if (!prior.rowCount) throw Object.assign(new Error("job lease not found"), { statusCode: 409, code: "JOB_LEASE_CONFLICT" }); } }
  async reconcileAnalysisQueue(limit: number, key: string): Promise<AnalysisQueueReconcileResult> { return this.tx(async (c) => {
    await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", ["analysis-queue-reconcile"]);
    const candidates = await c.query(`SELECT r.id repository_id,r.full_name,s.id snapshot_id,s.content_hash,s.metadata,s.readme_text,s.release_text,j.id job_id
FROM repositories r JOIN repository_snapshots s ON s.id=r.current_snapshot_id
LEFT JOIN jobs j ON j.dedupe_key='analyze:'||r.id::text||':'||s.content_hash
WHERE r.unstarred_at IS NULL
  AND NOT EXISTS (SELECT 1 FROM repository_analyses a WHERE a.repository_id=r.id AND a.content_hash=s.content_hash)
  AND (j.id IS NULL OR (j.status='succeeded' AND j.last_error LIKE 'skipped:%'))
ORDER BY r.id FOR UPDATE OF r SKIP LOCKED LIMIT $1`, [limit]);
    let created = 0, revived = 0;
    for (const row of candidates.rows) {
      const payload = { snapshotId: row.snapshot_id, contentHash: row.content_hash, fullName: row.full_name, metadata: row.metadata, readmeText: row.readme_text, releaseText: row.release_text };
      if (row.job_id) {
        const result = await c.query(`UPDATE jobs SET status='pending',priority=0,attempts=0,available_at=now(),completed_at=NULL,leased_until=NULL,leased_by=NULL,last_error=NULL,started_at=NULL,last_heartbeat_at=NULL,last_run_id=NULL,last_sandbox_id=NULL,payload=$2
WHERE id=$1 AND status='succeeded' AND last_error LIKE 'skipped:%'`, [row.job_id, payload]);
        revived += result.rowCount ?? 0;
      } else {
        await this.insertJob(c, "analyze_repository", row.repository_id, `analyze:${row.repository_id}:${row.content_hash}`, payload);
        created += 1;
      }
    }
    const remaining = await c.query(`SELECT count(*)::int count FROM repositories r JOIN repository_snapshots s ON s.id=r.current_snapshot_id
LEFT JOIN jobs j ON j.dedupe_key='analyze:'||r.id::text||':'||s.content_hash
WHERE r.unstarred_at IS NULL
  AND NOT EXISTS (SELECT 1 FROM repository_analyses a WHERE a.repository_id=r.id AND a.content_hash=s.content_hash)
  AND (j.id IS NULL OR (j.status='succeeded' AND j.last_error LIKE 'skipped:%'))`);
    return { created, revived, remaining: remaining.rows[0]?.count ?? 0 };
  }); }
  async activeJobs(): Promise<ActiveJob[]> {
    const result = await this.pool.query(`SELECT j.*,r.full_name FROM jobs j LEFT JOIN repositories r ON r.id=j.repository_id WHERE j.status='running' ORDER BY j.started_at,j.id`);
    return result.rows.map((row) => ({ id: row.id, type: row.type, status: row.status, repositoryId: row.repository_id, fullName: row.full_name, priority: row.priority, attempts: row.attempts, maxAttempts: row.max_attempts, workerId: row.leased_by, startedAt: iso(row.started_at), lastHeartbeatAt: iso(row.last_heartbeat_at), leasedUntil: iso(row.leased_until), runId: row.last_run_id, sandboxId: row.last_sandbox_id }));
  }
  async jobSummary(): Promise<JobQueueSummary> {
    const result = await this.pool.query(`SELECT CASE WHEN status='pending' AND available_at>now() THEN 'retry_wait' ELSE status END status,count(*)::int count FROM jobs GROUP BY 1`);
    const oldest = await this.pool.query(`SELECT min(created_at) oldest FROM jobs WHERE status='pending' AND available_at<=now()`);
    const concurrency = await this.pool.query(`SELECT s.*,(SELECT count(*)::int FROM jobs WHERE type='analyze_repository' AND status='running' AND leased_until>=now()) active FROM analysis_concurrency_state s WHERE singleton=true`);
    const state = concurrency.rows[0];
    return { counts: Object.fromEntries(result.rows.map((row) => [row.status, row.count])), oldestPendingAt: iso(oldest.rows[0]?.oldest), checkedAt: new Date().toISOString(), ...(state ? { analysisConcurrency: { current: state.current_limit, min: this.concurrency.analysisMinConcurrency, max: this.concurrency.analysisMaxConcurrency, active: state.active, successCount: state.success_count, failureCount: state.failure_count, p95Seconds: state.p95_seconds == null ? null : Number(state.p95_seconds), backlog: state.backlog, reason: state.reason, lastAdjustedAt: iso(state.last_adjusted_at) } } : {}) };
  }
  async recentJobFailures(limit: number): Promise<RecentJobFailure[]> {
    const result = await this.pool.query(`SELECT j.*,r.full_name FROM jobs j LEFT JOIN repositories r ON r.id=j.repository_id WHERE j.status IN ('failed','dead') ORDER BY coalesce(j.completed_at,j.available_at) DESC,j.id LIMIT $1`, [limit]);
    return result.rows.map((row) => ({ id: row.id, type: row.type, status: row.status, repositoryId: row.repository_id, fullName: row.full_name, attempts: row.attempts, maxAttempts: row.max_attempts, lastError: row.last_error, availableAt: iso(row.available_at)!, completedAt: iso(row.completed_at) }));
  }
  async listOperational(q: JobQuery): Promise<Page<OperationalJob>> {
    const where = ["status=$1"], values: unknown[] = [q.status];
    if (q.type) { values.push(q.type); where.push(`type=$${values.length}`); }
    if (q.repositoryId) { values.push(q.repositoryId); where.push(`repository_id=$${values.length}`); }
    const count = await this.pool.query(`SELECT count(*)::int total FROM jobs WHERE ${where.join(" AND ")}`, values);
    values.push(q.pageSize, (q.page - 1) * q.pageSize);
    const rows = await this.pool.query(`SELECT * FROM jobs WHERE ${where.join(" AND ")} ORDER BY created_at DESC,id LIMIT $${values.length - 1} OFFSET $${values.length}`, values);
    return { items: rows.rows.map(operationalJob), page: q.page, pageSize: q.pageSize, total: count.rows[0].total };
  }
  async retry(id: string, key: string) { return this.tx(async (c) => {
    await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`job-retry:${key}`]);
    const r = await c.query(`UPDATE jobs SET status='pending',attempts=0,available_at=now(),completed_at=NULL,leased_until=NULL,leased_by=NULL WHERE id=$1 AND status IN ('failed','dead') RETURNING id,status`, [id]);
    if (r.rowCount) return { jobId: r.rows[0].id as string, status: r.rows[0].status as string, retried: true };
    const prior = await c.query("SELECT id,status FROM jobs WHERE id=$1", [id]);
    if (!prior.rowCount) throw Object.assign(new Error("job not found"), { statusCode: 404, code: "JOB_NOT_FOUND" });
    if (prior.rows[0].status === "pending") return { jobId: prior.rows[0].id as string, status: "pending", retried: false };
    throw Object.assign(new Error(`job in ${prior.rows[0].status} state cannot be retried`), { statusCode: 409, code: "JOB_NOT_RETRYABLE" });
  }); }
  async recollect(repositoryId: string, key: string) { return this.tx(async (c) => {
    await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`recollect:${key}`]);
    const repo = await c.query("UPDATE repositories SET next_check_at=now(),updated_at=now() WHERE id=$1 AND unstarred_at IS NULL RETURNING id,next_check_at", [repositoryId]);
    if (!repo.rowCount) throw Object.assign(new Error("active project not found"), { statusCode: 404, code: "PROJECT_NOT_FOUND" });
    return { repositoryId: repo.rows[0].id as string, scheduled: true as const, nextCheckAt: iso(repo.rows[0].next_check_at)! };
  }); }
  async reanalyze(repositoryId: string, analysisVersion: string, key: string) { return this.tx(async (c) => {
    await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`reanalyze:${key}`]);
    const repo = await c.query(`SELECT r.id,r.full_name,s.id snapshot_id,s.content_hash,s.metadata,s.readme_text,s.release_text FROM repositories r LEFT JOIN repository_snapshots s ON s.id=r.current_snapshot_id WHERE r.id=$1 AND r.unstarred_at IS NULL FOR UPDATE OF r`, [repositoryId]);
    if (!repo.rowCount) throw Object.assign(new Error("active project not found"), { statusCode: 404, code: "PROJECT_NOT_FOUND" });
    const row = repo.rows[0];
    if (!row.snapshot_id) throw Object.assign(new Error("project has no snapshot to analyze"), { statusCode: 409, code: "SNAPSHOT_REQUIRED" });
    const jobId = await this.insertJob(c, "analyze_repository", row.id, `analyze:${row.id}:${row.content_hash}:${analysisVersion}`, { snapshotId: row.snapshot_id, contentHash: row.content_hash, fullName: row.full_name, metadata: row.metadata, readmeText: row.readme_text, releaseText: row.release_text, analysisVersion, requestedBy: "manual", force: true });
    return { jobId };
  }); }
  async prioritizeAnalysis(repositoryId: string) { return this.tx(async (c) => {
    const repository = await c.query(`SELECT r.id,r.full_name,s.id snapshot_id,s.content_hash,s.metadata,s.readme_text,s.release_text,
EXISTS(SELECT 1 FROM repository_analyses a WHERE a.repository_id=r.id AND a.snapshot_id=s.id) analyzed
FROM repositories r LEFT JOIN repository_snapshots s ON s.id=r.current_snapshot_id WHERE r.id=$1 AND r.unstarred_at IS NULL FOR UPDATE OF r`, [repositoryId]);
    if (!repository.rowCount) throw Object.assign(new Error("active project not found"), { statusCode: 404, code: "PROJECT_NOT_FOUND" });
    const row = repository.rows[0];
    if (!row.snapshot_id) throw Object.assign(new Error("project has no snapshot to analyze"), { statusCode: 409, code: "SNAPSHOT_REQUIRED" });
    if (row.analyzed) return { jobId: null, status: "already_analyzed" as const };
    const existing = await c.query(`UPDATE jobs SET status='pending',priority=100,attempts=0,available_at=now(),completed_at=NULL,leased_until=NULL,leased_by=NULL,last_error=NULL
WHERE repository_id=$1 AND type='analyze_repository' AND payload->>'snapshotId'=$2 AND status IN ('pending','failed','dead') RETURNING id`, [row.id, row.snapshot_id]);
    if (existing.rowCount) return { jobId: existing.rows[0].id as string, status: "queued" as const };
    const running = await c.query("SELECT id FROM jobs WHERE repository_id=$1 AND type='analyze_repository' AND payload->>'snapshotId'=$2 AND status='running'", [row.id, row.snapshot_id]);
    if (running.rowCount) return { jobId: running.rows[0].id as string, status: "running" as const };
    const jobId = await this.insertJob(c, "analyze_repository", row.id, `analyze:${row.id}:${row.content_hash}`, { snapshotId: row.snapshot_id, contentHash: row.content_hash, fullName: row.full_name, metadata: row.metadata, readmeText: row.readme_text, releaseText: row.release_text });
    await c.query("UPDATE jobs SET priority=100 WHERE id=$1", [jobId]);
    return { jobId, status: "queued" as const };
  }); }
  async analysisStatus(repositoryId: string): Promise<AnalysisTaskStatus> {
    const result = await this.pool.query(`SELECT r.id,r.current_snapshot_id,
EXISTS(SELECT 1 FROM repository_analyses a WHERE a.repository_id=r.id AND a.snapshot_id=r.current_snapshot_id) analyzed,
j.id job_id,j.status,j.attempts,j.max_attempts,j.available_at,j.leased_until,j.last_error
FROM repositories r LEFT JOIN LATERAL (
  SELECT * FROM jobs WHERE repository_id=r.id AND type='analyze_repository' AND payload->>'snapshotId'=r.current_snapshot_id::text
  ORDER BY priority DESC,created_at DESC LIMIT 1
) j ON true WHERE r.id=$1`, [repositoryId]);
    if (!result.rowCount) throw Object.assign(new Error("project not found"), { statusCode: 404, code: "PROJECT_NOT_FOUND" });
    const row = result.rows[0];
    let state: AnalysisTaskStatus["state"] = "not_requested";
    if (row.analyzed) state = "analyzed";
    else if (row.status === "running") state = "running";
    else if (row.status === "pending") state = row.attempts > 0 && new Date(row.available_at).getTime() > Date.now() ? "retry_wait" : "queued";
    else if (row.status === "dead") state = "dead";
    else if (row.status === "failed" || (row.status === "succeeded" && !String(row.last_error ?? "").startsWith("skipped:"))) state = "failed";
    const lastError = row.status === "succeeded" && String(row.last_error ?? "").startsWith("skipped:") ? null : row.last_error ?? null;
    return { repositoryId, state, jobId: row.job_id ?? null, attempts: row.attempts ?? 0, maxAttempts: row.max_attempts ?? 0, availableAt: iso(row.available_at), leasedUntil: iso(row.leased_until), lastError };
  }
  async createControlRun(operation: ControlOperation) {
    const result = await this.pool.query(`INSERT INTO control_runs(operation) VALUES($1)
ON CONFLICT (operation) WHERE status IN ('pending','running') DO UPDATE SET operation=excluded.operation RETURNING *`, [operation]);
    return controlRun(result.rows[0]);
  }
  async listControlRuns(limit: number) { const result = await this.pool.query("SELECT * FROM control_runs ORDER BY requested_at DESC LIMIT $1", [limit]); return result.rows.map(controlRun); }
  async claimControlRun(operation: ControlOperation, workerId: string, leaseSeconds: number) { return this.tx(async (c) => {
    await c.query("UPDATE control_runs SET status='pending',worker_id=NULL,leased_until=NULL WHERE operation=$1 AND status='running' AND leased_until<now()", [operation]);
    const result = await c.query(`WITH picked AS (SELECT id FROM control_runs WHERE operation=$1 AND status='pending' ORDER BY requested_at FOR UPDATE SKIP LOCKED LIMIT 1)
UPDATE control_runs r SET status='running',started_at=coalesce(started_at,now()),worker_id=$2,leased_until=now()+($3::text||' seconds')::interval FROM picked WHERE r.id=picked.id RETURNING r.*`, [operation, workerId, leaseSeconds]);
    return result.rowCount ? controlRun(result.rows[0]) : null;
  }); }
  async completeControlRun(id: string, workerId: string, result: Record<string, unknown>) { await this.pool.query("UPDATE control_runs SET status='succeeded',result=$3,error=NULL,completed_at=now(),worker_id=NULL,leased_until=NULL WHERE id=$1 AND status='running' AND worker_id=$2", [id, workerId, result]); }
  async failControlRun(id: string, workerId: string, error: string) { await this.pool.query("UPDATE control_runs SET status='failed',error=$3,completed_at=now(),worker_id=NULL,leased_until=NULL WHERE id=$1 AND status='running' AND worker_id=$2", [id, workerId, error]); }
  async create(run: AgentSearchRun) {
    await this.pool.query("INSERT INTO agent_search_runs(id,query,status,created_at) VALUES($1,$2,$3,$4)", [run.id, run.query, run.status, run.createdAt]);
  }
  async append(event: AgentSearchEvent) {
    await this.pool.query(`INSERT INTO agent_search_events(run_id,sequence,type,occurred_at,data) VALUES($1,$2,$3,$4,$5)
ON CONFLICT(run_id,sequence) DO NOTHING`, [event.runId, event.id, event.type, event.at, event.data]);
  }
  async finish(run: AgentSearchRun) {
    await this.pool.query("UPDATE agent_search_runs SET status=$2,answer=$3,error=$4,completed_at=$5,updated_at=now() WHERE id=$1", [run.id, run.status, run.answer ?? null, run.error ?? null, run.completedAt ?? null]);
  }
  async load(id: string): Promise<AgentSearchRun | undefined> {
    const result = await this.pool.query(`SELECT r.*,coalesce(jsonb_agg(jsonb_build_object('id',e.sequence,'runId',e.run_id,'type',e.type,'at',e.occurred_at,'data',e.data) ORDER BY e.sequence) FILTER (WHERE e.sequence IS NOT NULL),'[]') events
FROM agent_search_runs r LEFT JOIN agent_search_events e ON e.run_id=r.id WHERE r.id=$1 GROUP BY r.id`, [id]);
    if (!result.rowCount) return undefined;
    const row = result.rows[0];
    return { id: row.id, query: row.query, status: row.status, createdAt: iso(row.created_at)!, ...(row.completed_at ? { completedAt: iso(row.completed_at)! } : {}), ...(row.answer ? { answer: row.answer } : {}), ...(row.error ? { error: row.error } : {}), events: row.events.map((event: Record<string, unknown>) => ({ ...event, at: iso(event.at)! })) } as AgentSearchRun;
  }
  async failInterrupted(): Promise<number> {
    const result = await this.pool.query("UPDATE agent_search_runs SET status='failed',error='API process restarted before completion',completed_at=now(),updated_at=now() WHERE status='running'");
    return result.rowCount ?? 0;
  }
  async operationalCounts() {
    const result = await this.pool.query(`SELECT
      (SELECT count(*)::int FROM repositories WHERE unstarred_at IS NULL) starred,
      (SELECT count(*)::int FROM repositories WHERE unstarred_at IS NULL AND next_check_at<=now()) due,
      (SELECT coalesce(jsonb_object_agg(status,total),'{}') FROM (SELECT status,count(*)::int total FROM jobs GROUP BY status) j) jobs,
      (SELECT coalesce(jsonb_object_agg(status,total),'{}') FROM (SELECT status,count(*)::int total FROM agent_search_runs GROUP BY status) a) agent_runs`);
    const row = result.rows[0];
    return { repositories: { starred: row.starred, due: row.due }, jobs: row.jobs, agentRuns: row.agent_runs };
  }
  async recordOperationalCheck(status: "passed" | "failed", details: Record<string, unknown>) {
    await this.pool.query("INSERT INTO operational_checks(check_type,status,details) VALUES('index_consistency',$1,$2)", [status, details]);
  }
  async saveFeedback(input: QueryFeedbackInput) {
    const id = randomUUID();
    await this.pool.query(`INSERT INTO query_feedback(id,query_id,query_text,result_repository_ids,selected_repository_id,rating,action,metadata)
VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, [id, input.queryId, input.queryText, input.resultRepositoryIds, input.selectedRepositoryId ?? null, input.rating ?? null, input.action ?? null, input.metadata]);
    return { feedbackId: id };
  }
}
