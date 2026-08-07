process.env.GITHUB_TOKEN ||= "offline-e2e-token";

const { collect } = require("../../agents/scripts/sync-stars.cjs");
const { run } = require("../../agents/scripts/curate-stars.cjs");

const realFetch = global.fetch;
const observedAt = new Date();
const runId = String(process.env.E2E_RUN_ID || Date.now()).replace(/\D/g, "").slice(-9) || "1";
const queryToken = `e2e${runId}`;
const fullName = `example/delta-tool-${runId}`;
const repository = {
  id: 900000000000 + Number(runId),
  full_name: fullName,
  owner: { login: "example" },
  name: `delta-tool-${runId}`,
  html_url: `https://github.com/${fullName}`,
  description: `A better git diff viewer ${queryToken}`,
  homepage: "",
  default_branch: "main",
  language: "Rust",
  topics: ["diff", "git"],
  license: { spdx_id: "MIT" },
  stargazers_count: 100,
  forks_count: 10,
  open_issues_count: 2,
  created_at: "2025-01-01T00:00:00Z",
  updated_at: "2026-07-13T00:00:00Z",
  pushed_at: "2026-07-13T00:00:00Z",
  archived: false,
  disabled: false,
  has_wiki: false,
};

function json(payload, init = {}) {
  return new Response(JSON.stringify(payload), {
    status: init.status || 200,
    headers: { "content-type": "application/json", ...(init.headers || {}) },
  });
}

global.fetch = async (input, init) => {
  const url = String(input);
  if (!url.startsWith("https://api.github.com/")) return realFetch(input, init);
  const parsed = new URL(url);
  if (parsed.pathname === "/user/starred" && parsed.searchParams.get("page") === "1") {
    return json([{ starred_at: "2026-07-01T00:00:00Z", repo: repository }], {
      headers: { link: '<https://api.github.com/user/starred?per_page=100&page=2>; rel="next"' },
    });
  }
  if (parsed.pathname === "/user/starred" && parsed.searchParams.get("page") === "2") return json([]);
  if (url.endsWith(`/repos/${fullName}/readme`)) {
    return json({ content: Buffer.from(`A terminal git diff viewer ${queryToken}`).toString("base64") }, {
      headers: { etag: '"readme-e2e-v1"' },
    });
  }
  if (url.endsWith(`/repos/${fullName}/releases/latest`)) {
    return json({ name: "Stable", tag_name: "v1.0.0", body: "Fast Rust renderer" }, {
      headers: { etag: '"release-e2e-v1"' },
    });
  }
  return json({ message: `unhandled fake GitHub URL: ${url}` }, { status: 500 });
};

const fakeAgent = async () => ({
  json: {
    nameZh: "差异查看器",
    summaryZh: "改善终端 Git diff 可读性",
    categories: ["Git 工具"],
    keywords: ["git", "diff", "差异", queryToken],
    aliases: ["diff viewer"],
    useCases: ["代码审查"],
    problemsSolved: ["原生 diff 难以阅读"],
    targetUsers: ["开发者"],
    technologies: ["Rust"],
    maturity: "stable",
    maintenanceStatus: "active",
    limitations: [],
    confidence: 0.95,
  },
});

async function main() {
  process.env.ANALYSIS_VERSION = "e2e-v1";
  process.env.AGENT_PROVIDER = "offline-e2e";
  process.env.CURATOR_BATCH_SIZE = "10";
  const collected = await collect({ now: () => observedAt });
  const curated = await run({ agent: fakeAgent });
  if (collected.reconciled !== 1 || collected.refreshed !== 1 || collected.changed !== 1) {
    throw new Error(`unexpected collector result: ${JSON.stringify(collected)}`);
  }
  if (curated.curated < 1) throw new Error(`curator claimed no jobs: ${JSON.stringify(curated)}`);
  process.stdout.write(`${JSON.stringify({ collected, curated, repositoryFullName: fullName, queryToken })}\n`, () => process.exit(0));
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
