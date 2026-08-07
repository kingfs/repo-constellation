function runAdaptiveCurator() {
  const result = scheduler.exec({
    command: "node",
    args: ["/opt/star-agent/scripts/curate-stars.cjs", "--drain", "--reconcile-analysis", "--max-runtime-seconds", "510"],
    timeoutMs: 9 * 60 * 1000,
    maxOutputBytes: 1024 * 1024,
    sandboxPolicy: "new",
  });
  if (!result.success) {
    throw new Error("star curation failed: " + result.stderr);
  }
  return JSON.parse(result.stdout.trim());
}

function runRequestedCuration() {
  const result = scheduler.exec({
    command: "node",
    args: ["/opt/star-agent/scripts/control-runner.cjs", "curate"],
    timeoutMs: 2 * 60 * 1000,
    maxOutputBytes: 1024 * 1024,
    sandboxPolicy: "new",
  });
  if (!result.success) throw new Error("requested curation failed: " + result.stderr);
  return JSON.parse(result.stdout.trim());
}

function runCuratorTick() {
  // Manual polling and backlog draining must share one loader invocation. Two
  // cron triggers on the same minute race for the loader lock, which can make
  // the short control poll repeatedly suppress the actual backlog worker.
  const control = runRequestedCuration();
  const curation = runAdaptiveCurator();
  return { control, curation };
}

// Each worker run is bounded to 8.5 minutes for lease-safe recovery. A
// once-per-minute watchdog restarts draining on the first tick after teardown,
// so a large backlog is processed continuously across bounded runs.
scheduler.cron("curator-watchdog", "* * * * *", runCuratorTick, {
  timezone: "Asia/Shanghai",
});

scheduler.on("workflow.github-stars.synced", "curate-after-sync", function curateAfterSync() {
  return runAdaptiveCurator();
});

function main() {
  return runCuratorTick();
}
