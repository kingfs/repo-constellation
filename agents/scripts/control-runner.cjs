const { clientFromEnv } = require("./platform-api.cjs");
const { runTrackedSync } = require("./sync-stars.cjs");
const { drain } = require("./curate-stars.cjs");

async function runControlled(operation, { platform = clientFromEnv(), execute } = {}) {
  const workerId = `control-${operation}-${process.pid}`;
  const claimed = await platform.claimControlRun({ operation, workerId, leaseSeconds: operation === "curate" ? 3600 : 1800 });
  if (!claimed?.run) return { claimed: false, operation };
  try {
    const result = await (execute ? execute() : operation === "sync" ? runTrackedSync({ platform, source: "manual" }) : drain({ maxJobs: 1, maxRuntimeSeconds: 105 }));
    await platform.completeControlRun(claimed.run.id, { workerId, result });
    return { claimed: true, runId: claimed.run.id, operation, result };
  } catch (error) {
    try { await platform.failControlRun(claimed.run.id, { workerId, error: String(error.message || error).slice(0, 10_000) }); } catch (reportError) { console.error(`unable to report control failure: ${reportError.message || reportError}`); }
    throw error;
  }
}

if (require.main === module) runControlled(process.argv[2]).then((result) => process.stdout.write(`${JSON.stringify(result)}\n`)).catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });
module.exports = { runControlled };
