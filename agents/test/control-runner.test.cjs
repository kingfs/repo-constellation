const test = require("node:test");
const assert = require("node:assert/strict");
const { runControlled } = require("../scripts/control-runner.cjs");

test("controlled execution completes the persistent run", async () => {
  const events = [];
  const platform = { async claimControlRun() { return { run: { id: "run-1" } }; }, async completeControlRun(id, body) { events.push([id, body]); } };
  const result = await runControlled("sync", { platform, execute: async () => ({ reconciled: 12 }) });
  assert.equal(result.claimed, true); assert.equal(events[0][0], "run-1"); assert.deepEqual(events[0][1].result, { reconciled: 12 });
});

test("controlled execution records failures", async () => {
  let failure;
  const platform = { async claimControlRun() { return { run: { id: "run-2" } }; }, async failControlRun(id, body) { failure = { id, body }; } };
  await assert.rejects(() => runControlled("curate", { platform, execute: async () => { throw new Error("provider down"); } }), /provider down/);
  assert.equal(failure.id, "run-2"); assert.match(failure.body.error, /provider down/);
});
