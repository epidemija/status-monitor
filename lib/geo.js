// Geographic response-time checker.
// Uses the check-host.net HTTP API to probe each monitored site from
// multiple nodes around the world and stores results in geo_checks.
// Runs hourly (or on-demand). Disable with GEO_CHECKS_ENABLED=0 in .env.

const axios = require('axios');
const db = require('../db/database');

const LOCATIONS = [
  { key: 'us1', label: 'USA (Dallas)',       node: 'us1.node.check-host.net' },
  { key: 'us3', label: 'USA (Los Angeles)',  node: 'us3.node.check-host.net' },
  { key: 'ru1', label: 'Russia',             node: 'ru1.node.check-host.net' },
  { key: 'cn1', label: 'China',              node: 'cn1.node.check-host.net' },
  { key: 'de1', label: 'Germany',            node: 'de1.node.check-host.net' },
  { key: 'es1', label: 'Spain',              node: 'es1.node.check-host.net' },
  { key: 'fr1', label: 'France',             node: 'fr1.node.check-host.net' },
  { key: 'jp1', label: 'Japan',              node: 'jp1.node.check-host.net' },
  { key: 'br1', label: 'Brazil',             node: 'br1.node.check-host.net' },
  { key: 'au1', label: 'Australia',          node: 'au1.node.check-host.net' },
];

const insertGeo = db.prepare(`
  INSERT INTO geo_checks
    (site_id, location_key, location_label, response_time_ms, status_code, is_up, error_message)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function geoCheckSite(site) {
  const nodeQs = LOCATIONS.map((l) => `node=${encodeURIComponent(l.node)}`).join('&');
  const initUrl = `https://check-host.net/check-http?host=${encodeURIComponent(site.url)}&${nodeQs}`;

  let requestId;
  try {
    const { data } = await axios.get(initUrl, {
      headers: { Accept: 'application/json', 'User-Agent': 'StatusMonitor/1.0' },
      timeout: 15000,
    });
    requestId = data?.request_id;
    if (!requestId) throw new Error(`no request_id in response: ${JSON.stringify(data)}`);
  } catch (err) {
    console.error(`[geo] Init failed for ${site.name}: ${err.message}`);
    return;
  }

  // Nodes need ~15 seconds to complete their probes; give them 20s.
  await sleep(20000);

  let results;
  try {
    const { data } = await axios.get(`https://check-host.net/check-result/${requestId}`, {
      headers: { Accept: 'application/json', 'User-Agent': 'StatusMonitor/1.0' },
      timeout: 15000,
    });
    results = data;
  } catch (err) {
    console.error(`[geo] Result fetch failed for ${site.name}: ${err.message}`);
    return;
  }

  // check-host.net result format for HTTP checks:
  // [[status, statusText, responseTimeSec, httpCode, httpMessage]]
  // status 1 = probe connected, 0 = failed to connect
  const rows = [];
  for (const loc of LOCATIONS) {
    const raw = results[loc.node];
    if (raw == null) continue; // still processing or node unavailable — skip rather than store as DOWN
    const check = Array.isArray(raw) && Array.isArray(raw[0]) ? raw[0] : null;
    if (!check) {
      rows.push([site.id, loc.key, loc.label, null, null, 0, 'Probe returned no data']);
      continue;
    }
    const [status, statusText, rtSec, httpCode] = check;
    const isUp = status === 1 ? 1 : 0;
    const rtMs = rtSec != null ? Math.round(rtSec * 1000) : null;
    const error = status !== 1 ? (typeof statusText === 'string' ? statusText : 'Connection failed') : null;
    rows.push([site.id, loc.key, loc.label, rtMs, httpCode ?? null, isUp, error]);
  }

  db.transaction((r) => r.forEach((row) => insertGeo.run(...row)))(rows);
  console.log(`[geo] ${site.name}: recorded from ${rows.length} locations`);
}

async function runGeoSweep() {
  if (process.env.GEO_CHECKS_ENABLED === '0') {
    console.log('[geo] Geo checks disabled (GEO_CHECKS_ENABLED=0)');
    return;
  }
  const sites = db.prepare('SELECT * FROM sites WHERE enabled = 1 AND parent_id IS NULL').all();
  console.log(`[geo] Sweep starting for ${sites.length} site(s)`);
  for (let i = 0; i < sites.length; i++) {
    try {
      await geoCheckSite(sites[i]);
    } catch (err) {
      console.error(`[geo] Error on ${sites[i].url}: ${err.message}`);
    }
    // Throttle between sites to stay within check-host.net rate limits.
    if (i < sites.length - 1) await sleep(3000);
  }
  // Prune rows older than 7 days to keep the DB small.
  try {
    db.prepare("DELETE FROM geo_checks WHERE checked_at < datetime('now', '-7 days')").run();
  } catch (_) {}
  console.log('[geo] Geo sweep complete');
}

module.exports = { runGeoSweep, LOCATIONS };
