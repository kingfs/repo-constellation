function syncStars() {
  const result = scheduler.exec({
    command: "node",
    args: ["/opt/star-agent/scripts/sync-stars.cjs", "--source=daily"],
    timeoutMs: 30 * 60 * 1000,
    maxOutputBytes: 1024 * 1024,
    sandboxPolicy: "sticky",
  });
  if (!result.success) {
    throw new Error("star sync failed: " + result.stderr);
  }
  const syncResult = JSON.parse(result.stdout.trim());
  scheduler.event.publish("workflow.github-stars.synced", syncResult);
  return syncResult;
}

scheduler.cron("sync-stars-daily", "0 23 * * *", syncStars, {
  timezone: "Asia/Shanghai",
});

function main() {
  return syncStars();
}
