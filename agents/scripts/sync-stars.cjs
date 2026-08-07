const { clientFromEnv } = require("./platform-api.cjs");
const { contentHash, nextPageUrl, normalizeText, repositoryRecord } = require("./library.cjs");
const { randomUUID } = require("node:crypto");

const githubToken = process.env.GITHUB_TOKEN;

function githubHeaders(accept = "application/vnd.github+json") {
  if (!githubToken) throw new Error("GITHUB_TOKEN is required");
  return {
    Accept: accept,
    Authorization: `Bearer ${githubToken}`,
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "agent-compose-star-collector",
  };
}

async function githubRequest(url, { accept, allowNotFound = false, etag, attempts = 5 } = {}) {
  const headers = githubHeaders(accept);
  if (etag) headers["If-None-Match"] = etag;
  let lastError;
  const retryBaseMs = Math.max(1, Number.parseInt(process.env.GITHUB_RETRY_BASE_MS || "500", 10));
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, { headers, signal: AbortSignal.timeout(30_000) });
      if (response.status === 304) return response;
      if (allowNotFound && response.status === 404) return null;
      if (response.ok) return response;
      const remaining = response.headers.get("x-ratelimit-remaining");
      const reset = Number(response.headers.get("x-ratelimit-reset") || 0) * 1000;
      if (response.status === 403 && remaining === "0") {
        const error = new Error(`GitHub rate limit exhausted; reset at ${new Date(reset).toISOString()}`);
        error.retryable = true; error.rateLimitReset = reset; throw error;
      }
      const retryAfter = Number(response.headers.get("retry-after") || 0) * 1000;
      const body = await response.text();
      const error = new Error(`GitHub API ${url} returned ${response.status}: ${body}`);
      error.status = response.status;
      error.fatal = response.status === 401 || response.status === 403;
      if (![429, 500, 502, 503, 504].includes(response.status) || attempt === attempts) throw error;
      await new Promise((resolve) => setTimeout(resolve, Math.min(60_000, retryAfter || retryBaseMs * (2 ** (attempt - 1)))));
    } catch (error) {
      lastError = error;
      if (error?.rateLimitReset || attempt === attempts) throw error;
      await new Promise((resolve) => setTimeout(resolve, retryBaseMs * (2 ** (attempt - 1))));
    }
  }
  throw lastError;
}

async function starredRepositories() {
  const stars = [];
  let url = "https://api.github.com/user/starred?per_page=100&page=1";
  while (url) {
    const response = await githubRequest(url, { accept: "application/vnd.github.star+json" });
    stars.push(...await response.json());
    url = nextPageUrl(response.headers.get("link"));
  }
  return stars;
}

async function repositoryReadme(fullName, etag) {
  const response = await githubRequest(`https://api.github.com/repos/${fullName}/readme`, { allowNotFound: true, etag });
  if (!response) return { status: "missing" };
  if (response.status === 304) return { status: "not_modified" };
  const payload = await response.json();
  const encoded = String(payload.content || "").replace(/\s/g, "");
  return { status: "modified", text: normalizeText(Buffer.from(encoded, "base64").toString("utf8")), etag: response.headers.get("etag") || "" };
}

async function repositoryRelease(fullName, etag) {
  const response = await githubRequest(`https://api.github.com/repos/${fullName}/releases/latest`, { allowNotFound: true, etag });
  if (!response) return { status: "missing" };
  if (response.status === 304) return { status: "not_modified" };
  const release = await response.json();
  return {
    status: "modified",
    text: normalizeText([release.name, release.tag_name, release.body].filter(Boolean).join("\n\n")),
    etag: response.headers.get("etag") || "",
  };
}

async function collect({ platform = clientFromEnv(), now = () => new Date(), refreshLimit = Number.parseInt(process.env.COLLECTOR_REFRESH_LIMIT || "500", 10), refreshConcurrency = Number.parseInt(process.env.COLLECTOR_REFRESH_CONCURRENCY || "5", 10) } = {}) {
  if (!Number.isInteger(refreshLimit) || refreshLimit < 0) throw new Error("COLLECTOR_REFRESH_LIMIT must be a non-negative integer");
  if (!Number.isInteger(refreshConcurrency) || refreshConcurrency < 1 || refreshConcurrency > 20) throw new Error("COLLECTOR_REFRESH_CONCURRENCY must be an integer between 1 and 20");
  // Reconciliation is deliberately delayed until every Stars page succeeds. A
  // partial GitHub response must never mark unseen repositories as unstarred.
  const stars = await starredRepositories();
  const observedAt = now().toISOString();
  const repositories = stars.map(repositoryRecord);
  const reconcileKey = `stars-reconcile:${contentHash({ metadata: repositories, readmeText: "", releaseText: "" })}`;
  const reconciliation = await platform.reconcileStars({ observedAt, repositories }, reconcileKey);

  const byId = new Map(repositories.map((repository) => [repository.githubId, repository]));
  let attempted = 0, changed = 0, refreshed = 0, cursor;
  const failures = [];
  const refreshOne = async (due) => {
    const repository = byId.get(due.githubId);
    if (!repository) return;
    attempted += 1;
    const [readme, release] = await Promise.all([
      repositoryReadme(repository.fullName, due.readmeEtag),
      repositoryRelease(repository.fullName, due.releaseEtag),
    ]);
    const refreshKey = `refresh:${repository.githubId}:${observedAt}`;
    const result = await platform.refreshRepository(repository.githubId, {
      metadata: { ...repository }, readme, release, fetchedAt: now().toISOString(),
    }, refreshKey);
    refreshed += 1;
    if (result?.changed) changed += 1;
  };
  do {
    const page = await platform.dueRepositories({ asOf: observedAt, limit: 100, cursor });
    const batch = page.items.slice(0, Math.max(0, refreshLimit - attempted));
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(refreshConcurrency, batch.length) }, async () => {
      while (next < batch.length) {
        const due = batch[next]; next += 1;
        try { await refreshOne(due); }
        catch (error) {
          if (error?.fatal || error?.rateLimitReset) throw error;
          failures.push({ githubId: due.githubId, fullName: due.fullName, error: String(error?.message || error).slice(0, 1000) });
        }
      }
    }));
    cursor = attempted >= refreshLimit ? undefined : page.nextCursor || undefined;
  } while (cursor && attempted < refreshLimit);
  return { observedAt, reconciled: repositories.length, attempted, refreshed, changed, failed: failures.length, failures, unstarred: reconciliation?.unstarred || 0 };
}

async function main() {
  const sourceArg = process.argv.find((value) => value.startsWith("--source="));
  const source = sourceArg?.slice("--source=".length) || process.env.COLLECTOR_SYNC_SOURCE || "daily";
  const result = await runTrackedSync({ source });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

async function runTrackedSync({ platform = clientFromEnv(), source = "manual", now = () => new Date() } = {}) {
  if (!["daily", "manual"].includes(source)) throw new Error("sync source must be daily or manual");
  const id = randomUUID(); const startedAt = now().toISOString();
  await platform.startGithubSync({ id, source, startedAt }, `github-sync-start:${id}`);
  try {
    const result = await collect({ platform, now });
    await platform.completeGithubSync(id, { observedAt: result.observedAt, result }, `github-sync-complete:${id}`);
    return result;
  } catch (error) {
    try { await platform.failGithubSync(id, { error: String(error?.message || error).slice(0, 10_000) }, `github-sync-fail:${id}`); }
    catch (reportError) { console.error(`unable to report GitHub sync failure: ${reportError?.message || reportError}`); }
    throw error;
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}

module.exports = { collect, githubHeaders, repositoryReadme, repositoryRelease, runTrackedSync, starredRepositories };
