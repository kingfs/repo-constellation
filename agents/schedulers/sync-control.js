function runRequestedSync() {
  const result = scheduler.exec({
    command: "node",
    args: ["/opt/star-agent/scripts/control-runner.cjs", "sync"],
    timeoutMs: 30 * 60 * 1000,
    maxOutputBytes: 1024 * 1024,
    sandboxPolicy: "sticky",
  });
  if (!result.success) throw new Error("requested sync failed: " + result.stderr);
  return JSON.parse(result.stdout.trim());
}

scheduler.cron("sync-control-requests", "* * * * *", runRequestedSync, {
  timezone: "Asia/Shanghai",
});

function main() { return runRequestedSync(); }
