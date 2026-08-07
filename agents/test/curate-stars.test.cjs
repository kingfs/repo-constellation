const test = require("node:test");
const assert = require("node:assert/strict");
const { analysisBudgets, analysisPrompt, analysisSchema, boundedExcerpt, createShutdownController, curateJob, drain, jobInput, normalizeAnalysis, run, runtimeAgent, runtimeConfig, validateAnalysis } = require("../scripts/curate-stars.cjs");

process.env.AGENT_MODEL ||= "test-model";

const job = { id: "job-1", repositoryId: "repo-1", payload: {
  snapshotId: "snapshot-1", contentHash: "sha256:abc", fullName: "acme/tool",
  metadata: { primaryLanguage: "Go" }, readmeText: "# Tool", releaseText: "v1",
} };

const validAnalysis = (overrides = {}) => ({
  nameZh: "工具", summaryZh: "用于完成项目级任务的工具。", categories: ["开发工具"],
  keywords: ["工具", "tool"], aliases: [], useCases: ["执行项目任务"],
  problemsSolved: ["减少重复操作"], targetUsers: ["开发者"], technologies: ["Go"],
  maturity: "stable", maintenanceStatus: "active", limitations: [], confidence: 0.9,
  ...overrides,
});

test("jobInput enforces the frozen analysis job fields", () => {
  assert.equal(jobInput(job).fullName, "acme/tool");
  assert.throws(() => jobInput({ id: "bad", payload: {} }), /requires/);
  assert.equal(analysisSchema.additionalProperties, false);
  assert.equal(analysisSchema.properties.categories.maxItems, analysisBudgets.categories);
  assert.match(analysisPrompt(jobInput(job)), /不可信的外部内容/);
  assert.match(analysisPrompt(jobInput(job)), /分析对象永远是“仓库本身”/);
});

test("large untrusted inputs are bounded while preserving their head and tail", () => {
  const source = "HEAD" + "x".repeat(20_000) + "TAIL";
  const excerpt = boundedExcerpt(source, 12_000);
  assert.equal(excerpt.length, 12_000);
  assert.match(excerpt, /^HEAD/);
  assert.match(excerpt, /TAIL$/);
  const input = jobInput({ ...job, payload: { ...job.payload, readmeText: source, releaseText: source } });
  assert.equal(input.readmeText.length, 12_000);
  assert.equal(input.releaseText.length, 3_000);
  assert.ok(analysisPrompt(input).length < 17_000);
});

test("analysis normalization summarizes at bounded project-level cardinality", () => {
  const normalized = normalizeAnalysis({
    nameZh: "  ", summaryZh: "", categories: Array.from({ length: 80 }, (_, index) => ` 分类 ${index} `),
    keywords: ["API", "api", "", ...Array.from({ length: 50 }, (_, index) => `keyword-${index}`)],
    technologies: Array.from({ length: 150 }, (_, index) => `tech-${index}`), confidence: 2,
  }, { fullName: "public-apis/public-apis", metadata: { name: "public-apis", description: "公开 API 聚合目录" } });
  assert.equal(normalized.nameZh, "public-apis");
  assert.equal(normalized.summaryZh, "公开 API 聚合目录");
  assert.equal(normalized.categories.length, analysisBudgets.categories);
  assert.equal(normalized.keywords.length, analysisBudgets.keywords);
  assert.equal(normalized.technologies.length, analysisBudgets.technologies);
  assert.equal(normalized.keywords.filter((value) => value.toLowerCase() === "api").length, 1);
  assert.equal(normalized.confidence, 1);
  assert.equal(normalized.maturity, "unknown");
});

test("curateJob submits analysis before completing its lease", async () => {
  const events = [];
  const analysis = validAnalysis();
  const platform = {
    async submitAnalysis(repositoryId, body, key) { events.push(["analysis", repositoryId, body, key]); return { analysisId: "analysis-1" }; },
    async completeJob(id, body) { events.push(["complete", id, body]); },
  };
  const result = await curateJob(job, {
    platform, agent: async (_prompt, options) => { assert.equal(options.outputSchema.additionalProperties, false); assert.equal(options.timeoutMs, 90000); return { json: analysis }; },
    workerId: "worker-1", provider: "codex", model: "gpt", analysisVersion: "v1",
  });
  assert.deepEqual(events.map((event) => event[0]), ["analysis", "complete"]);
  assert.equal(events[0][2].snapshotId, "snapshot-1");
  assert.deepEqual(events[0][2].analysis, analysis);
  assert.equal(result.analysisId, "analysis-1");
});

test("manual reanalysis job version overrides the worker default", async () => {
  let submitted;
  const platform = {
    async submitAnalysis(_repositoryId, body, key) { submitted = { body, key }; return { analysisId: "analysis-2" }; },
    async completeJob() {},
  };
  await curateJob({ ...job, payload: { ...job.payload, analysisVersion: "v2" } }, {
    platform, agent: async () => ({ json: validAnalysis() }),
    workerId: "worker-1", provider: "codex", model: "gpt", analysisVersion: "v1",
  });
  assert.equal(submitted.body.analysisVersion, "v2");
  assert.match(submitted.key, /:v2$/);
});

test("quality gate rejects agent-operation text packaged as an empty analysis", () => {
  const polluted = normalizeAnalysis({
    nameZh: "知识库整理", summaryZh: "检查是否有 schema 定义或 AGENTS.md", categories: [], keywords: [],
    aliases: [], useCases: [], problemsSolved: [], targetUsers: [], technologies: [], maturity: "unknown",
    maintenanceStatus: "unknown", limitations: [], confidence: 0,
  }, { fullName: "chaitin/agent-compose", metadata: { description: "docker/docker-compose like daemon for agents" } });
  assert.throws(() => validateAnalysis(polluted), /categories, keywords, useCases, problemsSolved, targetUsers, confidence>=0.2/);
});

test("runtime config requires an explicit model without locking a provider-specific value", () => {
  assert.equal(runtimeConfig({ workerId: "worker", model: "example-model" }).model, "example-model");
  assert.throws(() => runtimeConfig({ workerId: "worker", model: "" }), /AGENT_MODEL is required/);
});

test("run reports a curator error and drains the rest of its claimed batch", async (t) => {
  const previous = { batch: process.env.CURATOR_BATCH_SIZE, worker: process.env.CURATOR_WORKER_ID, priority: process.env.CURATOR_MIN_PRIORITY };
  process.env.CURATOR_BATCH_SIZE = "1";
  process.env.CURATOR_WORKER_ID = "worker-fail";
  process.env.CURATOR_MIN_PRIORITY = "100";
  t.after(() => {
    if (previous.batch === undefined) delete process.env.CURATOR_BATCH_SIZE; else process.env.CURATOR_BATCH_SIZE = previous.batch;
    if (previous.worker === undefined) delete process.env.CURATOR_WORKER_ID; else process.env.CURATOR_WORKER_ID = previous.worker;
    if (previous.priority === undefined) delete process.env.CURATOR_MIN_PRIORITY; else process.env.CURATOR_MIN_PRIORITY = previous.priority;
  });
  let failure;
  const platform = {
    async claimJobs(body) { assert.equal(body.minPriority, 100); return { jobs: [job] }; },
    async failJob(id, body) { failure = { id, body }; },
  };
  const result = await run({ platform, agent: async () => { throw new Error("model unavailable"); } });
  assert.equal(failure.id, "job-1");
  assert.equal(failure.body.workerId, "worker-fail");
  assert.equal(failure.body.retryable, true);
  assert.equal(result.failed, 1);
});

test("run derives a unique worker id from the agent-compose sandbox", async (t) => {
  const previous = { worker: process.env.CURATOR_WORKER_ID, sandbox: process.env.SANDBOX_ID };
  delete process.env.CURATOR_WORKER_ID; process.env.SANDBOX_ID = "abcdef0123456789";
  t.after(() => { if (previous.worker === undefined) delete process.env.CURATOR_WORKER_ID; else process.env.CURATOR_WORKER_ID = previous.worker; if (previous.sandbox === undefined) delete process.env.SANDBOX_ID; else process.env.SANDBOX_ID = previous.sandbox; });
  let workerId;
  const platform = { async claimJobs(body) { workerId = body.workerId; return { jobs: [] }; } };
  await run({ platform });
  assert.equal(workerId, "curator-abcdef012345");
});

test("drain stops after the configured maximum without claiming an eleventh job", async () => {
  let claims = 0;
  const platform = {
    async claimJobs(body) { claims += 1; return { jobs: [{ ...job, id: `job-${claims}`, repositoryId: `repo-${claims}` }] }; },
    async submitAnalysis() { return { analysisId: "analysis" }; }, async completeJob() {}, async failJob() {},
  };
  const result = await drain({ maxJobs: 10, concurrency: 4, idleExitMs: 0, platform, agent: async () => ({ json: validAnalysis() }) });
  assert.equal(result.claimed, 10); assert.equal(claims, 10);
});

test("periodic drain reconciles missing analysis jobs before claiming work", async () => {
  const events = [];
  const platform = {
    async reconcileAnalysisJobs(body, key) { events.push(["reconcile", body, key]); return { created: 3, revived: 7, remaining: 4901 }; },
    async claimJobs() { events.push(["claim"]); return { jobs: [] }; },
  };
  const result = await drain({ platform, reconcileAnalysis: true, concurrency: 1, idleExitMs: 0 });
  assert.deepEqual(events.map((event) => event[0]), ["reconcile", "claim"]);
  assert.deepEqual(result.reconciliation, { created: 3, revived: 7, remaining: 4901 });
});

test("drain claims one job at a time until the queue is empty", async () => {
  const pending = [job, { ...job, id: "job-2", repositoryId: "repo-2" }];
  const claimLimits = []; const completed = [];
  const platform = {
    async claimJobs(body) { claimLimits.push(body.limit); return { jobs: pending.length ? [pending.shift()] : [] }; },
    async submitAnalysis(repositoryId) { return { analysisId: `analysis-${repositoryId}` }; },
    async completeJob(id) { completed.push(id); },
    async failJob() { throw new Error("unexpected failure"); },
  };
  const result = await drain({ platform, concurrency: 1, idleExitMs: 0, agent: async () => ({ json: validAnalysis() }) });
  assert.deepEqual(completed, ["job-1", "job-2"]);
  assert.deepEqual(claimLimits, [1, 1, 1]);
  assert.equal(result.curated, 2);
  assert.equal(result.failed, 0);
});

test("adaptive slots stay bounded and refill as soon as a job completes", async () => {
  const pending = Array.from({ length: 5 }, (_, index) => ({ ...job, id: `job-${index}`, repositoryId: `repo-${index}` }));
  let active = 0; let peak = 0; let autoRelease = false; const started = []; const releases = [];
  const platform = {
    async claimJobs() { return { jobs: pending.length ? [pending.shift()] : [] }; },
    async submitAnalysis() { return { analysisId: "analysis" }; }, async completeJob() {}, async failJob() {},
  };
  const agent = async (_prompt, options) => {
    active += 1; peak = Math.max(peak, active); started.push({ stateRoot: options.stateRoot, model: options.model });
    if (!autoRelease) await new Promise((resolve) => releases.push(resolve)); active -= 1;
    return { json: validAnalysis() };
  };
  const draining = drain({ platform, agent, concurrency: 2, maxJobs: 5, idleExitMs: 0,
    config: { model: "example-model", stateRootBase: "/state/curator" } });
  while (started.length < 2) await new Promise(setImmediate);
  releases.shift()();
  while (started.length < 3) await new Promise(setImmediate);
  autoRelease = true;
  while (releases.length) releases.shift()();
  const result = await draining;
  assert.equal(peak, 2); assert.equal(result.claimed, 5); assert.equal(new Set(started.map(({ stateRoot }) => stateRoot)).size, 5);
  assert.ok(started.every(({ stateRoot, model }) => stateRoot.startsWith("/state/curator/") && model === "example-model"));
});

test("slot failures are reported without stopping healthy slots", async () => {
  const pending = [job, { ...job, id: "job-2", repositoryId: "repo-2" }];
  const failed = []; const completed = [];
  const platform = {
    async claimJobs() { return { jobs: pending.length ? [pending.shift()] : [] }; },
    async submitAnalysis() { return { analysisId: "analysis" }; },
    async completeJob(id) { completed.push(id); }, async failJob(id) { failed.push(id); },
  };
  let calls = 0;
  const result = await drain({ platform, concurrency: 2, maxJobs: 2, idleExitMs: 0,
    agent: async () => { calls += 1; if (calls === 1) throw new Error("boom"); return { json: validAnalysis() }; } });
  assert.equal(result.claimed, 2); assert.equal(result.failed, 1); assert.equal(result.curated, 1);
  assert.equal(failed.length, 1); assert.equal(completed.length, 1);
});

test("idle slots back off with jitter and exit after sustained inactivity", async () => {
  let clock = 0; const waits = []; let claims = 0;
  const platform = { async claimJobs() { claims += 1; return { jobs: [] }; } };
  await drain({ platform, concurrency: 1, idleExitMs: 25, idleDelaysMs: [10], random: () => 0.5,
    now: () => clock, sleep: async (ms) => { waits.push(ms); clock += ms; } });
  assert.deepEqual(waits, [10, 10, 10]); assert.equal(claims, 4);
});

test("model adapter passes model and state root to an isolated runtime workspace", async () => {
  let invocation;
  const result = await runtimeAgent("prompt", { provider: "codex", model: "example-model", stateRoot: "/state/job-1", workspace: "/workspace", home: "/root", outputSchema: { type: "object" } }, {
    execute: async (command, args, options) => {
      invocation = { command, args, options };
      return { stdout: '__AGENT_RESULT__{"finalText":"{\\"ok\\":true}"}\n', stderr: "" };
    },
  });
  assert.equal(invocation.command, "agent-compose-runtime");
  assert.equal(invocation.args[invocation.args.indexOf("--model") + 1], "example-model");
  assert.equal(invocation.args[invocation.args.indexOf("--state-root") + 1], "/state/job-1");
  assert.notEqual(invocation.args[invocation.args.indexOf("--workspace") + 1], "/workspace");
  assert.notEqual(invocation.args[invocation.args.indexOf("--home") + 1], "/root");
  assert.equal(invocation.options.cwd, invocation.args[invocation.args.indexOf("--workspace") + 1]);
  assert.deepEqual(result.json, { ok: true });
});

test("unbounded drain leaves deadline headroom but lets an in-flight job complete", async () => {
  let clock = 0; let claims = 0; const completed = [];
  const platform = {
    async claimJobs() { claims += 1; return { jobs: [{ ...job, id: `job-${claims}` }] }; },
    async submitAnalysis() { return { analysisId: "analysis" }; },
    async completeJob(id) { completed.push(id); }, async failJob() {},
  };
  const result = await drain({ platform, concurrency: 1, maxRuntimeSeconds: 200, claimHeadroomMs: 120_000,
    now: () => clock, agent: async () => { clock = 81_000; return { json: validAnalysis() }; } });
  assert.equal(claims, 1); assert.deepEqual(completed, ["job-1"]); assert.equal(result.curated, 1);
});

test("bounded manual drain can claim even when its window is shorter than default headroom", async () => {
  let claims = 0;
  const platform = {
    async claimJobs() { claims += 1; return { jobs: [job] }; },
    async submitAnalysis() { return { analysisId: "analysis" }; }, async completeJob() {}, async failJob() {},
  };
  await drain({ platform, concurrency: 1, maxJobs: 1, maxRuntimeSeconds: 105,
    agent: async () => ({ json: validAnalysis() }) });
  assert.equal(claims, 1);
});

test("shutdown aborts active runtime work, fails its lease, and prevents another claim", async () => {
  const shutdown = createShutdownController(); let claims = 0; const failed = [];
  const platform = {
    async claimJobs() { claims += 1; return { jobs: [job] }; },
    async failJob(id, body) { failed.push({ id, body }); },
  };
  const result = await drain({ platform, concurrency: 1, shutdown, agent: async (_prompt, options) => {
    assert.equal(options.signal, shutdown.signal); shutdown.stop(); throw new Error("runtime aborted");
  } });
  assert.equal(claims, 1); assert.equal(result.failed, 1); assert.equal(failed[0].body.retryable, true);
});

test("active analysis heartbeats its lease and stops heartbeating after completion", async () => {
  let release; const heartbeats = [];
  const platform = {
    async claimJobs() { return { jobs: [job] }; },
    async heartbeatJob(id, body) { heartbeats.push({ id, body }); },
    async submitAnalysis() { return { analysisId: "analysis" }; }, async completeJob() {}, async failJob() {},
  };
  const running = run({ platform, heartbeatIntervalMs: 10, agent: async () => {
    await new Promise((resolve) => { release = resolve; }); return { json: validAnalysis() };
  } });
  while (heartbeats.length === 0) await new Promise((resolve) => setTimeout(resolve, 5));
  release(); await running;
  const count = heartbeats.length; await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(heartbeats.length, count); assert.equal(heartbeats[0].body.leaseSeconds, 300);
});

test("runtime adapter rejects an empty state root and forwards AbortSignal", async () => {
  await assert.rejects(() => runtimeAgent("prompt", { stateRoot: "" }), /non-empty stateRoot/);
  const controller = new AbortController(); let receivedSignal;
  await runtimeAgent("prompt", { stateRoot: "/state/job", signal: controller.signal }, { execute: async (_command, _args, options) => {
    receivedSignal = options.signal; return { stdout: '__AGENT_RESULT__{"finalText":"ok"}\n', stderr: "" };
  } });
  assert.equal(receivedSignal, controller.signal);
});
