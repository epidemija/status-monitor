// Periodic scheduler. Runs the monitoring sweep on a cron schedule
// (default every 5 minutes; configurable via CHECK_CRON in .env).
const cron = require('node-cron');
const { runSweep } = require('./monitor');

function start() {
  const expr = process.env.CHECK_CRON || '*/5 * * * *';
  if (!cron.validate(expr)) {
    console.error(`[scheduler] Invalid CHECK_CRON expression "${expr}", falling back to */5 * * * *`);
  }
  const useExpr = cron.validate(expr) ? expr : '*/5 * * * *';
  cron.schedule(useExpr, () => {
    runSweep().catch((err) => console.error('[scheduler] sweep error:', err));
  });
  console.log(`[scheduler] Running sweeps on cron "${useExpr}"`);

  // Run an initial sweep ~10 seconds after boot so the public page is not empty.
  setTimeout(() => {
    runSweep().catch((err) => console.error('[scheduler] initial sweep error:', err));
  }, 10000);
}

module.exports = { start };
