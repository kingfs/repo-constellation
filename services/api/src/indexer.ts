import type { IndexSourceAdapter, JobAdapter, SearchIndexAdapter } from "./adapters.js";
import type { ClaimedJob, RepositoryIndexSource, RepositorySearchDocument } from "./domain.js";

const epoch = (value: string | null): number | null => value == null ? null : Math.floor(new Date(value).getTime() / 1000);

export function toSearchDocument(source: RepositoryIndexSource, readmeMaxChars: number): RepositorySearchDocument {
  const a = source.analysis;
  return {
    id: source.id, github_id: source.githubId, full_name: source.fullName, owner: source.owner, name: source.name, html_url: source.htmlUrl, ...(a?.nameZh ? { name_zh: a.nameZh } : {}),
    description: source.description, ...(a ? { summary_zh: a.summaryZh } : {}), categories: a?.categories ?? [],
    problems_solved: a?.problemsSolved ?? [], use_cases: a?.useCases ?? [], keywords: a?.keywords ?? [],
    aliases: a?.aliases ?? [], target_users: a?.targetUsers ?? [], technologies: a?.technologies ?? [], topics: source.topics,
    ...(a?.maturity ? { maturity: a.maturity } : {}), ...(a?.maintenanceStatus ? { maintenance_status: a.maintenanceStatus } : {}),
    limitations: a?.limitations ?? [], ...(a?.confidence == null ? {} : { confidence: a.confidence }),
    readme_search_text: (source.readmeText ?? "").slice(0, readmeMaxChars), stars_count: source.starsCount, forks_count: source.forksCount, open_issues_count: source.openIssuesCount,
    pushed_at: epoch(source.pushedAt), starred_at: epoch(source.starredAt), github_updated_at: epoch(source.githubUpdatedAt),
    activity_class: source.activityClass, archived: source.archived, is_starred: source.unstarredAt == null,
    license_spdx: source.licenseSpdx, primary_language: source.primaryLanguage, updated_at: epoch(source.updatedAt)!,
  };
}

export interface IndexerOptions { workerId: string; batchSize: number; leaseSeconds: number; pollIntervalMs: number; readmeMaxChars: number }
export interface IndexerLogger { info(fields: object, message: string): void; error(fields: object, message: string): void }
const noLogger: IndexerLogger = { info() {}, error() {} };

export class RepositoryIndexer {
  private stopped = false;
  private wake: (() => void) | null = null;
  constructor(private readonly sources: IndexSourceAdapter, private readonly jobs: JobAdapter, private readonly index: SearchIndexAdapter, private readonly options: IndexerOptions, private readonly logger: IndexerLogger = noLogger) {}

  async runOnce(): Promise<number> {
    const release = await this.jobs.acquireIndexLock();
    try { return await this.processOnce(); } finally { await release(); }
  }

  private async processOnce(): Promise<number> {
    const jobs = await this.jobs.claim(["index_repository"], this.options.workerId, this.options.batchSize, this.options.leaseSeconds);
    if (jobs.length === 0) return 0;
    try {
      const prepared = await Promise.all(jobs.map(async (job) => {
        if (!job.repositoryId) throw new Error("index_repository job has no repositoryId");
        return { job, source: await this.sources.getIndexSource(job.repositoryId) };
      }));
      const documents = prepared.flatMap(({ source }) => source != null && source.unstarredAt == null ? [toSearchDocument(source, this.options.readmeMaxChars)] : []);
      const deletions = prepared.filter(({ source }) => source == null || source.unstarredAt != null);
      await Promise.all(deletions.map(({ job }) => this.index.delete(job.repositoryId!)));
      if (documents.length > 0) await this.index.upsertMany(documents);
      await Promise.all(prepared.map(async ({ job }) => {
        await this.jobs.complete(job.id, this.options.workerId, `index-complete:${job.id}`);
        this.logger.info({ jobId: job.id, repositoryId: job.repositoryId }, "repository index job completed");
      }));
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      await Promise.all(jobs.map(async (job) => {
        try { await this.jobs.fail(job.id, this.options.workerId, message, true, `index-fail:${job.id}:${job.attempts}`); }
        catch (failCause) { this.logger.error({ jobId: job.id, error: String(failCause) }, "failed to record repository index failure"); }
      }));
      this.logger.error({ jobIds: jobs.map((job) => job.id), error: message }, "repository index batch failed");
    }
    return jobs.length;
  }

  async run(): Promise<void> {
    this.stopped = false;
    while (!this.stopped) {
      try { await this.runOnce(); }
      catch (cause) { this.logger.error({ error: String(cause) }, "indexer poll failed"); }
      if (!this.stopped) await new Promise<void>((resolve) => { const timer = setTimeout(resolve, this.options.pollIntervalMs); this.wake = () => { clearTimeout(timer); resolve(); }; });
    }
  }

  stop(): void { this.stopped = true; this.wake?.(); this.wake = null; }

  async rebuild(batchSize = 500): Promise<number> {
    const release = await this.jobs.acquireIndexLock();
    try { return await this.rebuildLocked(batchSize); } finally { await release(); }
  }

  private async rebuildLocked(batchSize: number): Promise<number> {
    const rebuild = await this.index.beginAtomicRebuild();
    try {
      let after: string | null = null, total = 0;
      for (;;) {
        const ids = await this.sources.listIndexSourceIds(after, batchSize);
        if (ids.length === 0) { await rebuild.commit(); return total; }
        const documents: RepositorySearchDocument[] = [];
        for (const id of ids) {
          const source = await this.sources.getIndexSource(id);
          if (source != null && source.unstarredAt == null) { documents.push(toSearchDocument(source, this.options.readmeMaxChars)); total++; }
        }
        await rebuild.upsertMany(documents);
        after = ids.at(-1)!;
      }
    } catch (cause) {
      await rebuild.abort();
      throw cause;
    }
  }
}
