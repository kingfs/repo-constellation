const crypto = require("node:crypto");

function nextPageUrl(linkHeader) {
  if (!linkHeader) return null;
  for (const part of linkHeader.split(",")) {
    const match = part.trim().match(/^<([^>]+)>;\s*rel="([^"]+)"$/);
    if (match && match[2].split(/\s+/).includes("next")) return match[1];
  }
  return null;
}

function normalizeText(value) {
  if (!value) return "";
  return String(value).replace(/\r\n?/g, "\n").replace(/[ \t]+$/gm, "").trim();
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function contentHash({ metadata, readmeText, releaseText }) {
  const content = [stableJson(metadata), normalizeText(readmeText), normalizeText(releaseText)].join("\n---\n");
  return `sha256:${crypto.createHash("sha256").update(content).digest("hex")}`;
}

function repositoryRecord(star) {
  const repo = star.repo;
  return {
    githubId: String(repo.id),
    fullName: repo.full_name,
    owner: repo.owner.login,
    name: repo.name,
    htmlUrl: repo.html_url,
    description: repo.description || "",
    homepage: repo.homepage || "",
    defaultBranch: repo.default_branch || "",
    primaryLanguage: repo.language || "",
    topics: [...(repo.topics || [])].sort(),
    licenseSpdx: repo.license?.spdx_id || "",
    starsCount: repo.stargazers_count || 0,
    forksCount: repo.forks_count || 0,
    openIssuesCount: repo.open_issues_count || 0,
    githubCreatedAt: repo.created_at,
    githubUpdatedAt: repo.updated_at,
    pushedAt: repo.pushed_at,
    starredAt: star.starred_at,
    archived: Boolean(repo.archived),
    disabled: Boolean(repo.disabled),
    hasWiki: Boolean(repo.has_wiki),
  };
}

module.exports = { contentHash, nextPageUrl, normalizeText, repositoryRecord, stableJson };
