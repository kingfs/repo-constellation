const test = require("node:test");
const assert = require("node:assert/strict");
const { PlatformApiClient, PlatformApiError } = require("../scripts/platform-api.cjs");

test("API client adds authentication and idempotency headers", async () => {
  let request;
  const client = new PlatformApiClient({ baseUrl: "http://api:8080/", token: "secret", fetchImpl: async (url, init) => {
    request = { url, init };
    return new Response('{"upserted":1,"unstarred":0}', { status: 200 });
  } });
  await client.reconcileStars({ observedAt: "now", repositories: [] }, "key-1");
  assert.equal(request.url, "http://api:8080/internal/v1/github/stars/reconcile");
  assert.equal(request.init.headers.Authorization, "Bearer secret");
  assert.equal(request.init.headers["Idempotency-Key"], "key-1");
});

test("API client preserves structured retryability", async () => {
  const client = new PlatformApiClient({ baseUrl: "http://api", token: "x", fetchImpl: async () => new Response(
    '{"error":{"code":"invalid","message":"bad input","retryable":false}}', { status: 400 },
  ) });
  await assert.rejects(() => client.claimJobs({}), (error) => {
    assert.ok(error instanceof PlatformApiError);
    assert.equal(error.code, "invalid");
    assert.equal(error.retryable, false);
    return true;
  });
});

test("API client sends authenticated job heartbeats", async () => {
  let request;
  const client = new PlatformApiClient({ baseUrl: "http://api", token: "secret", fetchImpl: async (url, init) => {
    request = { url, init }; return new Response('{"leasedUntil":"2026-07-22T09:00:00Z"}', { status: 200 });
  } });
  await client.heartbeatJob("job/1", { workerId: "worker", leaseSeconds: 300 }, "heartbeat-1");
  assert.equal(request.url, "http://api/internal/v1/jobs/job%2F1/heartbeat");
  assert.equal(request.init.headers["Idempotency-Key"], "heartbeat-1");
});
