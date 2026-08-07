const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function loadScheduler(file) {
  const registrations = { cron: [], events: [] };
  const scheduler = {
    cron(name, expression, handler, options) { registrations.cron.push({ name, expression, handler, options }); },
    on(event, name, handler) { registrations.events.push({ event, name, handler }); },
    exec() { throw new Error("scheduler command must not run while loading configuration"); },
    event: { publish() {} },
  };
  const source = fs.readFileSync(path.join(__dirname, "..", "schedulers", file), "utf8");
  vm.runInNewContext(source, { scheduler, JSON, Error }, { filename: file });
  return registrations;
}

test("daily Stars collection is isolated from manual request polling", () => {
  const collector = loadScheduler("sync-stars.js");
  assert.deepEqual(collector.cron.map(({ name, expression, options }) => [name, expression, options.timezone]), [
    ["sync-stars-daily", "0 23 * * *", "Asia/Shanghai"],
  ]);

  const control = loadScheduler("sync-control.js");
  assert.deepEqual(control.cron.map(({ name, expression }) => [name, expression]), [
    ["sync-control-requests", "* * * * *"],
  ]);
});

test("the single Curator scheduler owns watchdog, sync event, and manual control", () => {
  const curator = loadScheduler("curate-stars.js");

  assert.deepEqual(curator.cron.map(({ name, expression }) => [name, expression]), [
    ["curator-watchdog", "* * * * *"],
  ]);
  assert.deepEqual(curator.events.map(({ event, name }) => [event, name]), [
    ["workflow.github-stars.synced", "curate-after-sync"],
  ]);
  const source = fs.readFileSync(path.join(__dirname, "..", "schedulers", "curate-stars.js"), "utf8");
  assert.match(source, /--drain.*--reconcile-analysis.*--max-runtime-seconds.*510/);
  assert.match(source, /control-runner\.cjs.*curate/);
  assert.match(source, /const control = runRequestedCuration\(\);[\s\S]*const curation = runAdaptiveCurator\(\);/);
  assert.doesNotMatch(source, /--max-jobs/);
});

test("obsolete Curator scheduler replicas are removed", () => {
  for (const file of ["curate-worker.js", "curate-priority.js", "curate-control.js"]) {
    assert.equal(fs.existsSync(path.join(__dirname, "..", "schedulers", file)), false);
  }
});

test("agent-compose declares Curator capability exactly once", () => {
  const compose = fs.readFileSync(path.join(__dirname, "..", "..", "agent-compose.yml"), "utf8");
  assert.deepEqual(compose.match(/^  star-curator[^:]*:/gm), ["  star-curator:"]);
  assert.match(compose, /provider: file\s+path: \.\/agents\/schedulers\/curate-stars\.js/);
  assert.doesNotMatch(compose, /star-curator-(?:lane|priority|control)/);
});
