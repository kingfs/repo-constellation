#!/usr/bin/env node
"use strict";
const fs = require("node:fs");

async function main() {
  const apiUrl = process.env.API_URL;
  const fixturePath = process.argv[2];
  if (!apiUrl || !fixturePath) throw new Error("usage: API_URL=http://127.0.0.1:8080 evaluate-search.cjs <queries.json>");
  const cases = JSON.parse(fs.readFileSync(fixturePath, "utf8"));
  if (!Array.isArray(cases) || cases.length === 0) throw new Error("evaluation fixture must be a non-empty JSON array");

  let recall5 = 0, recall10 = 0, reciprocalRank = 0;
  for (const item of cases) {
  if (typeof item.query !== "string" || !Array.isArray(item.expectedFullNames) || item.expectedFullNames.length === 0) throw new Error("each case requires query and expectedFullNames");
  const response = await fetch(`${apiUrl}/api/v1/search?q=${encodeURIComponent(item.query)}&pageSize=10`);
  if (!response.ok) throw new Error(`search failed (${response.status}) for ${item.query}`);
  const page = await response.json();
  const names = page.items.map((hit) => hit.project.fullName);
  const rank = names.findIndex((name) => item.expectedFullNames.includes(name));
  if (rank >= 0 && rank < 5) recall5++;
  if (rank >= 0 && rank < 10) recall10++;
  if (rank >= 0) reciprocalRank += 1 / (rank + 1);
  }
  const metrics = { cases: cases.length, recallAt5: recall5 / cases.length, recallAt10: recall10 / cases.length, mrr: reciprocalRank / cases.length, evaluatedAt: new Date().toISOString() };
  process.stdout.write(`${JSON.stringify(metrics, null, 2)}\n`);
  const thresholds = { recallAt5: Number(process.env.MIN_RECALL_AT_5 ?? 0), recallAt10: Number(process.env.MIN_RECALL_AT_10 ?? 0), mrr: Number(process.env.MIN_MRR ?? 0) };
  if ([metrics.recallAt5, metrics.recallAt10, metrics.mrr, ...Object.values(thresholds)].some((value) => !Number.isFinite(value))) throw new Error("evaluation metrics and thresholds must be finite numbers");
  for (const [name, minimum] of Object.entries(thresholds)) if (metrics[name] < minimum) { console.error(`${name} ${metrics[name]} is below required ${minimum}`); process.exitCode = 1; }
}
main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });
