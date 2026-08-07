class PlatformApiError extends Error {
  constructor(message, { status, code, retryable } = {}) {
    super(message);
    this.name = "PlatformApiError";
    this.status = status;
    this.code = code;
    this.retryable = retryable ?? (status >= 500 || status === 429);
  }
}

class PlatformApiClient {
  constructor({ baseUrl, token, fetchImpl = fetch }) {
    if (!baseUrl) throw new Error("PLATFORM_API_URL is required");
    if (!token) throw new Error("PLATFORM_AGENT_TOKEN is required");
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.token = token;
    this.fetch = fetchImpl;
  }

  async request(path, { method = "GET", body, idempotencyKey } = {}) {
    const headers = { Accept: "application/json", Authorization: `Bearer ${this.token}` };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
    const response = await this.fetch(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    let payload = null;
    if (text) {
      try { payload = JSON.parse(text); } catch { payload = null; }
    }
    if (!response.ok) {
      const error = payload?.error;
      throw new PlatformApiError(error?.message || `Platform API returned ${response.status}${text ? `: ${text}` : ""}`, {
        status: response.status,
        code: error?.code,
        retryable: error?.retryable,
      });
    }
    return payload;
  }

  reconcileStars(body, key) {
    return this.request("/internal/v1/github/stars/reconcile", { method: "POST", body, idempotencyKey: key });
  }
  startGithubSync(body, key) { return this.request("/internal/v1/github/stars/sync-runs", { method: "POST", body, idempotencyKey: key }); }
  completeGithubSync(id, body, key) { return this.request(`/internal/v1/github/stars/sync-runs/${encodeURIComponent(id)}/complete`, { method: "POST", body, idempotencyKey: key }); }
  failGithubSync(id, body, key) { return this.request(`/internal/v1/github/stars/sync-runs/${encodeURIComponent(id)}/fail`, { method: "POST", body, idempotencyKey: key }); }
  dueRepositories({ asOf, limit = 100, cursor } = {}) {
    const query = new URLSearchParams({ limit: String(limit) });
    if (asOf) query.set("asOf", asOf);
    if (cursor) query.set("cursor", cursor);
    return this.request(`/internal/v1/repositories/due?${query}`);
  }
  refreshRepository(githubId, body, key) {
    return this.request(`/internal/v1/repositories/${encodeURIComponent(githubId)}/refresh`, { method: "POST", body, idempotencyKey: key });
  }
  submitSnapshot(githubId, body, key) {
    return this.request(`/internal/v1/repositories/${encodeURIComponent(githubId)}/snapshots`, { method: "POST", body, idempotencyKey: key });
  }
  claimJobs(body) {
    return this.request("/internal/v1/jobs/claim", { method: "POST", body });
  }
  heartbeatJob(jobId, body, key) {
    return this.request(`/internal/v1/jobs/${encodeURIComponent(jobId)}/heartbeat`, { method: "POST", body, idempotencyKey: key });
  }
  reconcileAnalysisJobs(body, key) {
    return this.request("/internal/v1/jobs/reconcile-analysis", { method: "POST", body, idempotencyKey: key });
  }
  submitAnalysis(repositoryId, body, key) {
    return this.request(`/internal/v1/repositories/${encodeURIComponent(repositoryId)}/analyses`, { method: "POST", body, idempotencyKey: key });
  }
  completeJob(jobId, body, key) {
    return this.request(`/internal/v1/jobs/${encodeURIComponent(jobId)}/complete`, { method: "POST", body, idempotencyKey: key });
  }
  failJob(jobId, body, key) {
    return this.request(`/internal/v1/jobs/${encodeURIComponent(jobId)}/fail`, { method: "POST", body, idempotencyKey: key });
  }
  searchProjects(body) { return this.request("/internal/v1/search/projects", { method: "POST", body }); }
  batchGetProjects(ids) { return this.request("/internal/v1/projects/batch-get", { method: "POST", body: { ids } }); }
  readme(id, maxChars = 20000) { return this.request(`/internal/v1/projects/${encodeURIComponent(id)}/readme?maxChars=${maxChars}`); }
  compareProjects(ids) { return this.request("/internal/v1/projects/compare", { method: "POST", body: { ids } }); }
  claimControlRun(body) { return this.request("/internal/v1/control-runs/claim", { method: "POST", body }); }
  completeControlRun(id, body) { return this.request(`/internal/v1/control-runs/${encodeURIComponent(id)}/complete`, { method: "POST", body }); }
  failControlRun(id, body) { return this.request(`/internal/v1/control-runs/${encodeURIComponent(id)}/fail`, { method: "POST", body }); }
}

function clientFromEnv(fetchImpl = fetch) {
  return new PlatformApiClient({
    baseUrl: process.env.PLATFORM_API_URL || "http://api:8080",
    token: process.env.PLATFORM_AGENT_TOKEN,
    fetchImpl,
  });
}

module.exports = { PlatformApiClient, PlatformApiError, clientFromEnv };
