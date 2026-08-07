const test = require("node:test");
const assert = require("node:assert/strict");

process.env.GITHUB_TOKEN = "test-token";
process.env.GITHUB_RETRY_BASE_MS = "1";
const { collect, runTrackedSync } = require("../scripts/sync-stars.cjs");

function star(id, name) {
  return { starred_at: "2026-01-02T00:00:00Z", repo: {
    id, full_name: `acme/${name}`, owner: { login: "acme" }, name,
    html_url: `https://github.com/acme/${name}`, default_branch: "main", topics: [],
    stargazers_count: 1, forks_count: 0, open_issues_count: 0,
    created_at: "2020-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z", pushed_at: "2026-01-01T00:00:00Z",
  } };
}

test("collector follows all Stars pages, then refreshes only due repositories", async (t) => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  const calls = [];
  global.fetch = async (url) => {
    calls.push(url);
    const page = new URL(url).searchParams.get("page");
    if (url.includes("user/starred") && page === "1") return new Response(JSON.stringify([star(1, "one")]), { headers: { link: '<https://api.github.com/user/starred?per_page=100&page=2>; rel="next"' } });
    if (url.includes("user/starred") && page === "2") return new Response(JSON.stringify([star(2, "two")]));
    if (url.endsWith("/readme")) return new Response(JSON.stringify({ content: Buffer.from("# Readme\r\n").toString("base64") }), { headers: { etag: '"readme"' } });
    if (url.endsWith("/releases/latest")) return new Response("not found", { status: 404 });
    throw new Error(`unexpected URL ${url}`);
  };
  const events = [];
  const platform = {
    async reconcileStars(body) { events.push(["reconcile", body.repositories.length]); return { unstarred: 1 }; },
    async dueRepositories() { return { items: [{ githubId: "2", fullName: "acme/two", readmeEtag: null, releaseEtag: null, nextCheckAt: "2026-07-14T00:00:00Z" }], nextCursor: null }; },
    async refreshRepository(id, body) { events.push(["refresh", id, body]); return { changed: true }; },
  };
  const result = await collect({ platform, now: () => new Date("2026-07-14T00:00:00Z") });
  assert.deepEqual(events.map((event) => event.slice(0, 2)), [["reconcile", 2], ["refresh", "2"]]);
  assert.deepEqual(events[1][2].readme, { status: "modified", text: "# Readme", etag: '"readme"' });
  assert.deepEqual(result, { observedAt: "2026-07-14T00:00:00.000Z", reconciled: 2, attempted: 1, refreshed: 1, changed: 1, failed: 0, failures: [], unstarred: 1 });
});

test("collector sends validators and preserves 304 as not_modified", async (t) => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  const conditional = [];
  global.fetch = async (url, options = {}) => {
    if (url.includes("user/starred")) return new Response(JSON.stringify([star(1, "one")]));
    conditional.push([url, options.headers["If-None-Match"]]);
    return new Response(null, { status: 304 });
  };
  let refresh;
  const platform = {
    async reconcileStars() { return { unstarred: 0 }; },
    async dueRepositories() { return { items: [{ githubId: "1", fullName: "acme/one", readmeEtag: '"r"', releaseEtag: '"v"', nextCheckAt: "2026-07-14T00:00:00Z" }], nextCursor: null }; },
    async refreshRepository(_id, body) { refresh = body; return { changed: false }; },
  };
  const result = await collect({ platform, now: () => new Date("2026-07-14T00:00:00Z") });
  assert.deepEqual(conditional.map((x) => x[1]), ['"r"', '"v"']);
  assert.equal(refresh.readme.status, "not_modified");
  assert.equal(refresh.release.status, "not_modified");
  assert.equal(result.changed, 0);
});

test("collector never reconciles an incomplete pagination", async (t) => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  global.fetch = async (url) => {
    if (new URL(url).searchParams.get("page") === "1") return new Response(JSON.stringify([star(1, "one")]), { headers: { link: '<https://api.github.com/user/starred?per_page=100&page=2>; rel="next"' } });
    return new Response("upstream error", { status: 502 });
  };
  let reconciled = false;
  await assert.rejects(() => collect({ platform: { reconcileStars() { reconciled = true; } } }), /returned 502/);
  assert.equal(reconciled, false);
});

test("collector caps detail refreshes without truncating full reconciliation", async (t) => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  global.fetch = async (url) => {
    if (url.includes("user/starred")) return new Response(JSON.stringify([star(1, "one"), star(2, "two")]));
    if (url.endsWith("/readme")) return new Response(JSON.stringify({ content: "" }));
    if (url.endsWith("/releases/latest")) return new Response("not found", { status: 404 });
    throw new Error(`unexpected URL ${url}`);
  };
  let reconciled = 0; const refreshed = [];
  const due = [{ githubId: "1", fullName: "acme/one" }, { githubId: "2", fullName: "acme/two" }];
  const platform = {
    async reconcileStars(body) { reconciled = body.repositories.length; return { unstarred: 0 }; },
    async dueRepositories() { return { items: due, nextCursor: null }; },
    async refreshRepository(id) { refreshed.push(id); return { changed: true }; },
  };
  const result = await collect({ platform, refreshLimit: 1 });
  assert.equal(reconciled, 2);
  assert.deepEqual(refreshed, ["1"]);
  assert.equal(result.refreshed, 1);
});

test("collector isolates a repository detail failure and continues the batch", async (t) => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  global.fetch = async (url) => {
    if (url.includes("user/starred")) return new Response(JSON.stringify([star(1, "one"), star(2, "two")]));
    if (url.includes("acme/one")) throw new Error("connection reset");
    if (url.endsWith("/readme")) return new Response(JSON.stringify({ content: Buffer.from("# Two").toString("base64") }));
    if (url.endsWith("/releases/latest")) return new Response("not found", { status: 404 });
    throw new Error(`unexpected URL ${url}`);
  };
  const refreshed = [];
  const platform = {
    async reconcileStars() { return { unstarred: 0 }; },
    async dueRepositories() { return { items: [{ githubId: "1", fullName: "acme/one" }, { githubId: "2", fullName: "acme/two" }], nextCursor: null }; },
    async refreshRepository(id) { refreshed.push(id); return { changed: true }; },
  };
  const result = await collect({ platform, refreshConcurrency: 2 });
  assert.deepEqual(refreshed, ["2"]);
  assert.equal(result.attempted, 2);
  assert.equal(result.refreshed, 1);
  assert.equal(result.failed, 1);
  assert.equal(result.failures[0].fullName, "acme/one");
});

test("tracked sync persists a successful manual run", async (t) => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  global.fetch = async (url) => url.includes("user/starred") ? new Response(JSON.stringify([])) : Promise.reject(new Error(`unexpected URL ${url}`));
  const events = [];
  const platform = {
    async startGithubSync(body) { events.push(["start", body]); },
    async reconcileStars() { return { unstarred: 0 }; },
    async dueRepositories() { return { items: [], nextCursor: null }; },
    async completeGithubSync(id, body) { events.push(["complete", id, body]); },
  };
  const result = await runTrackedSync({ platform, source: "manual", now: () => new Date("2026-07-23T00:00:00Z") });
  assert.equal(result.reconciled, 0);
  assert.deepEqual(events.map(([event]) => event), ["start", "complete"]);
  assert.equal(events[0][1].source, "manual");
  assert.equal(events[1][2].observedAt, "2026-07-23T00:00:00.000Z");
});

test("tracked sync persists failure without masking the collector error", async (t) => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  global.fetch = async () => { throw new Error("github unavailable"); };
  const events = [];
  const platform = {
    async startGithubSync(body) { events.push(["start", body]); },
    async failGithubSync(id, body) { events.push(["fail", id, body]); },
  };
  await assert.rejects(() => runTrackedSync({ platform, source: "daily" }), /github unavailable/);
  assert.deepEqual(events.map(([event]) => event), ["start", "fail"]);
  assert.equal(events[0][1].source, "daily");
  assert.match(events[1][2].error, /github unavailable/);
});
