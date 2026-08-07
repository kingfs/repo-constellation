import { MeiliSearch } from "meilisearch";
import type { SearchAdapter, SearchIndexAdapter, SearchIndexRebuild } from "./adapters.js";
import type { Project, RepositorySearchDocument, SearchPage, SearchQuery } from "./domain.js";

const isoEpoch = (value: number | null): string | null => value == null ? null : new Date(value * 1000).toISOString();
const taskWaitOptions = { timeOutMs: 60_000, intervalMs: 100 } as const;
export function searchDocumentToProject(document: RepositorySearchDocument): Project {
  const analysis = document.summary_zh == null ? null : {
    ...(document.name_zh ? { nameZh: document.name_zh } : {}), summaryZh: document.summary_zh,
    categories: document.categories, keywords: document.keywords, aliases: document.aliases, useCases: document.use_cases,
    problemsSolved: document.problems_solved, targetUsers: document.target_users, technologies: document.technologies,
    ...(document.maturity ? { maturity: document.maturity } : {}), ...(document.maintenance_status ? { maintenanceStatus: document.maintenance_status } : {}),
    limitations: document.limitations, ...(document.confidence == null ? {} : { confidence: document.confidence }),
  };
  return {
    id: document.id, githubId: document.github_id, fullName: document.full_name, owner: document.owner, name: document.name,
    htmlUrl: document.html_url, description: document.description, primaryLanguage: document.primary_language, topics: document.topics,
    licenseSpdx: document.license_spdx, starsCount: document.stars_count, forksCount: document.forks_count,
    openIssuesCount: document.open_issues_count, pushedAt: isoEpoch(document.pushed_at), githubUpdatedAt: isoEpoch(document.github_updated_at),
    starredAt: isoEpoch(document.starred_at), unstarredAt: document.is_starred ? null : isoEpoch(document.updated_at), archived: document.archived,
    activityClass: document.activity_class, updatedAt: isoEpoch(document.updated_at)!, analysis,
  };
}

export class MeiliSearchAdapter implements SearchAdapter, SearchIndexAdapter {
  private readonly client: MeiliSearch;
  constructor(host: string, apiKey: string, private readonly indexName: string, client?: MeiliSearch) { this.client = client ?? new MeiliSearch({ host, apiKey }); }
  async ping() { await this.client.health(); }
  async documentCount() { return (await this.client.index(this.indexName).getStats()).numberOfDocuments; }
  async ensureConfigured() {
    try { const created = await this.client.createIndex(this.indexName, { primaryKey: "id" }); await this.client.waitForTask(created.taskUid, taskWaitOptions); }
    catch (cause) { if ((cause as { code?: string }).code !== "index_already_exists") throw cause; }
    const task = await this.client.index(this.indexName).updateSettings({
      searchableAttributes: ["name", "full_name", "aliases", "problems_solved", "use_cases", "keywords", "summary_zh", "categories", "topics", "description", "technologies", "readme_search_text"],
      filterableAttributes: ["categories", "technologies", "topics", "activity_class", "archived", "is_starred", "license_spdx", "primary_language"],
      sortableAttributes: ["stars_count", "pushed_at", "starred_at", "github_updated_at"],
    });
    await this.client.waitForTask(task.taskUid, taskWaitOptions);
  }
  async search(q: SearchQuery): Promise<SearchPage> {
    const filters: string[] = ["is_starred = true"];
    if (q.category) filters.push(`categories = ${JSON.stringify(q.category)}`);
    if (q.language) filters.push(`primary_language = ${JSON.stringify(q.language)}`);
    if (q.activity) filters.push(`activity_class = ${JSON.stringify(q.activity)}`);
    const sortMap: Record<string, string[]> = { stars: ["stars_count:desc"], pushed: ["pushed_at:desc"], starred: ["starred_at:desc"], updated: ["github_updated_at:desc"] };
    const result = await this.client.index(this.indexName).search<RepositorySearchDocument>(q.query, { filter: filters, sort: sortMap[q.sort ?? "relevance"], offset: (q.page - 1) * q.pageSize, limit: q.pageSize, attributesToHighlight: ["*"] });
    const updated = new Date().toISOString();
    return { items: result.hits.map((hit) => {
      const formatted = (hit._formatted ?? {}) as Record<string, unknown>;
      return { project: searchDocumentToProject(hit), matchedFields: Object.keys(formatted).filter((k) => JSON.stringify(formatted[k]).includes("<em>")), highlights: formatted as Record<string, string>, dataUpdatedAt: updated };
    }), page: q.page, pageSize: q.pageSize, total: result.estimatedTotalHits ?? 0, indexVersion: this.indexName };
  }
  async upsert(document: RepositorySearchDocument): Promise<void> {
    await this.upsertMany([document]);
  }
  async upsertMany(documents: RepositorySearchDocument[]): Promise<void> {
    if (documents.length === 0) return;
    const task = await this.client.index(this.indexName).addDocuments(documents, { primaryKey: "id" });
    await this.client.waitForTask(task.taskUid, taskWaitOptions);
  }
  async delete(repositoryId: string): Promise<void> {
    const task = await this.client.index(this.indexName).deleteDocument(repositoryId);
    await this.client.waitForTask(task.taskUid, taskWaitOptions);
  }
  async clear(): Promise<void> {
    const task = await this.client.index(this.indexName).deleteAllDocuments();
    await this.client.waitForTask(task.taskUid, taskWaitOptions);
  }
  async beginAtomicRebuild(): Promise<SearchIndexRebuild> {
    const temporaryName = `${this.indexName}_rebuild_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const created = await this.client.createIndex(temporaryName, { primaryKey: "id" });
    await this.client.waitForTask(created.taskUid, taskWaitOptions);
    const temporary = this.client.index(temporaryName);
    const settings = await this.client.index(this.indexName).getSettings();
    const configured = await temporary.updateSettings(settings);
    await this.client.waitForTask(configured.taskUid, taskWaitOptions);
    let finished = false;
    return {
      upsertMany: async (documents) => {
        if (finished || documents.length === 0) return;
        const task = await temporary.addDocuments(documents, { primaryKey: "id" });
        await this.client.waitForTask(task.taskUid, taskWaitOptions);
      },
      commit: async () => {
        if (finished) return;
        const swapped = await this.client.swapIndexes([{ indexes: [this.indexName, temporaryName] }]);
        await this.client.waitForTask(swapped.taskUid, taskWaitOptions);
        finished = true;
        const removed = await this.client.deleteIndex(temporaryName);
        await this.client.waitForTask(removed.taskUid, taskWaitOptions);
      },
      abort: async () => {
        if (finished) return;
        finished = true;
        try { const removed = await this.client.deleteIndex(temporaryName); await this.client.waitForTask(removed.taskUid, taskWaitOptions); }
        catch (cause) { if ((cause as { code?: string }).code !== "index_not_found") throw cause; }
      },
    };
  }
}
