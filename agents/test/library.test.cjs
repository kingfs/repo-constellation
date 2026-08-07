const test = require("node:test");
const assert = require("node:assert/strict");
const { contentHash, nextPageUrl, normalizeText, repositoryRecord, stableJson } = require("../scripts/library.cjs");

test("nextPageUrl follows GitHub's next link independent of page size", () => {
  const link = '<https://api.github.com/user/starred?per_page=100&page=2>; rel="next", <https://api.github.com/user/starred?per_page=100&page=9>; rel="last"';
  assert.equal(nextPageUrl(link), "https://api.github.com/user/starred?per_page=100&page=2");
  assert.equal(nextPageUrl(null), null);
});

test("normalization and hash are stable across object key and line-ending differences", () => {
  assert.equal(normalizeText("a  \r\nb\r\n"), "a\nb");
  assert.equal(stableJson({ b: 2, a: 1 }), stableJson({ a: 1, b: 2 }));
  assert.equal(
    contentHash({ metadata: { b: 2, a: 1 }, readmeText: "hello\r\n", releaseText: "" }),
    contentHash({ metadata: { a: 1, b: 2 }, readmeText: "hello\n", releaseText: "" }),
  );
});

test("repositoryRecord maps GitHub star representation to API v1", () => {
  const record = repositoryRecord({ starred_at: "2026-01-02T00:00:00Z", repo: {
    id: 9007199254740993n, full_name: "acme/tool", owner: { login: "acme" }, name: "tool",
    html_url: "https://github.com/acme/tool", default_branch: "main", topics: ["z", "a"],
    license: { spdx_id: "MIT" }, stargazers_count: 3, forks_count: 2, open_issues_count: 1,
    created_at: "2020-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z", pushed_at: "2026-01-01T00:00:00Z",
  } });
  assert.equal(record.githubId, "9007199254740993");
  assert.deepEqual(record.topics, ["a", "z"]);
  assert.equal(record.starredAt, "2026-01-02T00:00:00Z");
});
