// Periodic scheduler. Runs the monitoring sweep on a cron schedule
// (default every 5 minutes; configurable via CHECK_CRON in .env).
// Also runs hourly geo checks (configurable via GEO_CHECK_CRON; disable with GEO_CHECKS_ENABLED=0).
const cron = require('node-cron');
const { runSweep } = require('./monitor');
const { runGeoSweep } = require('./geo');

function start() {
  // --- Main availability sweep ---
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

  // --- Hourly geographic response-time sweep ---
  if (process.env.GEO_CHECKS_ENABLED !== '0') {
    const geoExpr = process.env.GEO_CHECK_CRON || '0 * * * *';
    const useGeoExpr = cron.validate(geoExpr) ? geoExpr : '0 * * * *';
    cron.schedule(useGeoExpr, () => {
      runGeoSweep().catch((err) => console.error('[scheduler] geo sweep error:', err));
    });
    console.log(`[scheduler] Running geo sweeps on cron "${useGeoExpr}"`);

    // Initial geo sweep ~60 seconds after boot (after the first main sweep completes).
    setTimeout(() => {
      runGeoSweep().catch((err) => console.error('[scheduler] initial geo sweep error:', err));
    }, 60000);
  }
}

module.exports = { start };
