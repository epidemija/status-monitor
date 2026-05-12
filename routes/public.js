const os = require('os');
const express = require('express');
const db = require('../db/database');
const monitor = require('../lib/monitor');
const notifier = require('../lib/notifier');
const { trackVisit, updateBrowser } = require('../middleware/visitor-tracker');

const router = express.Router();

const MEASUREMENT_REGION = process.env.MEASUREMENT_REGION || '';
const MEASUREMENT_HOST = os.hostname();

// Prepared queries (compiled once, used per request).
const lastCheckStmt = db.prepare(
  'SELECT * FROM checks WHERE site_id = ? ORDER BY id DESC LIMIT 1'
);
const uptimeStmt = db.prepare(`
  SELECT
    SUM(CASE WHEN is_up = 1 THEN 1 ELSE 0 END) AS up_count,
    COUNT(*) AS total
  FROM checks
  WHERE site_id = ? AND checked_at >= datetime('now', ?)
`);
const responseTimeStatsStmt = db.prepare(`
  SELECT
    AVG(response_time_ms) AS avg_ms,
    MIN(response_time_ms) AS min_ms,
    MAX(response_time_ms) AS max_ms,
    COUNT(*)              AS samples
  FROM checks
  WHERE site_id = ? AND checked_at >= datetime('now', '-1 day') AND response_time_ms IS NOT NULL
`);
// One prepared statement per window. `units_ago` is hours / days / weeks back from now.
const timelineStmts = {
  '24h': db.prepare(`
    SELECT CAST((julianday('now') - julianday(checked_at)) * 24 AS INTEGER) AS units_ago,
           SUM(CASE WHEN is_up = 1 THEN 1 ELSE 0 END) AS up_count,
           COUNT(*) AS total
    FROM checks
    WHERE site_id = ? AND checked_at >= datetime('now', '-24 hours')
    GROUP BY units_ago
  `),
  '30d': db.prepare(`
    SELECT CAST(julianday('now') - julianday(checked_at) AS INTEGER) AS units_ago,
           SUM(CASE WHEN is_up = 1 THEN 1 ELSE 0 END) AS up_count,
           COUNT(*) AS total
    FROM checks
    WHERE site_id = ? AND checked_at >= datetime('now', '-30 days')
    GROUP BY units_ago
  `),
  '1y': db.prepare(`
    SELECT CAST((julianday('now') - julianday(checked_at)) / 7 AS INTEGER) AS units_ago,
           SUM(CASE WHEN is_up = 1 THEN 1 ELSE 0 END) AS up_count,
           COUNT(*) AS total
    FROM checks
    WHERE site_id = ? AND checked_at >= datetime('now', '-365 days')
    GROUP BY units_ago
  `),
};
const TIMELINE_CONFIG = {
  '24h': { count: 24, unitMs: 3600 * 1000,        unit: 'hour' },
  '30d': { count: 30, unitMs: 86400 * 1000,       unit: 'day'  },
  '1y':  { count: 52, unitMs: 7 * 86400 * 1000,   unit: 'week' },
};
const recentChecksStmt = db.prepare(`
  SELECT * FROM checks WHERE site_id = ?
  ORDER BY id DESC LIMIT 20
`);
const recentIncidentsStmt = db.prepare(`
  SELECT * FROM incidents WHERE site_id = ?
  ORDER BY id DESC LIMIT 5
`);
// Distribution of HTTP status codes for a site over a window.
// Returns rows like { status_code: 200, count: 285 }.
const statusCodeDistStmt = db.prepare(`
  SELECT status_code, COUNT(*) AS count
  FROM checks
  WHERE site_id = ? AND checked_at >= datetime('now', ?) AND status_code IS NOT NULL
  GROUP BY status_code
  ORDER BY status_code
`);
// Most recent occurrence of each problematic (4xx / 5xx) status code for a site.
const recentProblemCodesStmt = db.prepare(`
  SELECT status_code, MAX(checked_at) AS last_seen, COUNT(*) AS count
  FROM checks
  WHERE site_id = ?
    AND checked_at >= datetime('now', '-30 days')
    AND status_code >= 400
  GROUP BY status_code
  ORDER BY last_seen DESC
`);

/** Format a status code with a friendly label. */
function statusCodeLabel(code) {
  const labels = {
    301: 'Moved Permanently', 302: 'Found',
    400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found',
    408: 'Request Timeout', 410: 'Gone', 412: 'Precondition Failed',
    418: "I'm a teapot", 429: 'Too Many Requests',
    500: 'Internal Server Error', 502: 'Bad Gateway', 503: 'Service Unavailable',
    504: 'Gateway Timeout',
  };
  return labels[code] || '';
}
/** Tier a code as ok / redirect / client / server / unknown. */
function statusCodeTier(code) {
  if (code == null) return 'unknown';
  if (code >= 200 && code < 300) return 'ok';
  if (code >= 300 && code < 400) return 'redirect';
  if (code >= 400 && code < 500) return 'client';
  if (code >= 500 && code < 600) return 'server';
  return 'unknown';
}

/** Build a timeline for the chosen window. Returns N items oldest-first. */
function buildTimeline(siteId, windowKey) {
  const cfg = TIMELINE_CONFIG[windowKey] || TIMELINE_CONFIG['24h'];
  const stmt = timelineStmts[windowKey] || timelineStmts['24h'];
  const rows = stmt.all(siteId);
  const byUnit = new Map(rows.map((r) => [r.units_ago, r]));
  const out = [];
  const nowMs = Date.now();
  for (let i = cfg.count - 1; i >= 0; i--) {
    const r = byUnit.get(i);
    const total = r ? r.total : 0;
    let pct = null, cls = 'none';
    if (total > 0) {
      pct = (100 * r.up_count) / total;
      cls = pct === 100 ? 'ok' : pct >= 90 ? 'warn' : 'down';
    }
    const endMs   = nowMs - i * cfg.unitMs;
    const startMs = endMs - cfg.unitMs;
    let label;
    if (cfg.unit === 'hour') {
      const d = new Date(endMs);
      label = `${d.toISOString().slice(0,10)} ${String(d.getUTCHours()).padStart(2,'0')}:00 UTC`;
    } else if (cfg.unit === 'day') {
      label = new Date(endMs).toISOString().slice(0, 10);
    } else {
      label = `${new Date(startMs).toISOString().slice(0,10)} → ${new Date(endMs).toISOString().slice(0,10)}`;
    }
    out.push({ label, pct, cls, total });
  }
  return out;
}

function getSiteSummaries(currentWindow = '24h') {
  const sites = db.prepare('SELECT * FROM sites WHERE enabled = 1 ORDER BY sort_order ASC, name ASC').all();
  return sites.map((site) => {
    const last = lastCheckStmt.get(site.id);
    const uptime24h = uptimeStmt.get(site.id, '-1 day');
    const uptime30d = uptimeStmt.get(site.id, '-30 days');
    const uptime1y  = uptimeStmt.get(site.id, '-1 year');
    const rtStats   = responseTimeStatsStmt.get(site.id);
    const timeline  = buildTimeline(site.id, currentWindow);
    const codes24h  = statusCodeDistStmt.all(site.id, '-1 day').map((r) => ({
      ...r, tier: statusCodeTier(r.status_code), label: statusCodeLabel(r.status_code),
    }));
    const errorCount24h = codes24h
      .filter((c) => c.tier === 'client' || c.tier === 'server')
      .reduce((sum, c) => sum + c.count, 0);
    const recentProblems = recentProblemCodesStmt.all(site.id).map((r) => ({
      ...r, tier: statusCodeTier(r.status_code), label: statusCodeLabel(r.status_code),
    }));
    const recentIncidents = recentIncidentsStmt.all(site.id);
    const pct = (u) => (u && u.total > 0 ? (100 * u.up_count / u.total) : null);
    const uptime24hPct = pct(uptime24h);
    const uptime30dPct = pct(uptime30d);
    const uptime1yPct  = pct(uptime1y);
    const currentWindowPct =
      currentWindow === '30d' ? uptime30dPct :
      currentWindow === '1y'  ? uptime1yPct  :
      uptime24hPct;
    return {
      site,
      last,
      uptime24hPct,
      uptime30dPct,
      uptime1yPct,
      currentWindowPct,
      rtStats,
      rtTier: monitor.tierResponseTime(site, last?.response_time_ms),
      timeline,
      codes24h,
      errorCount24h,
      recentProblems,
      recentIncidents,
    };
  });
}

/* ------------------ Domain grouping (manual parent/child) ------------------ */

function groupSummaries(summaries) {
  const byId = new Map(summaries.map(s => [s.site.id, s]));
  const childrenMap = new Map();
  const primaries = [];

  for (const s of summaries) {
    if (s.site.parent_id && byId.has(s.site.parent_id)) {
      if (!childrenMap.has(s.site.parent_id)) childrenMap.set(s.site.parent_id, []);
      childrenMap.get(s.site.parent_id).push(s);
    } else {
      primaries.push(s);
    }
  }

  return primaries.map(p => [p, ...(childrenMap.get(p.site.id) || [])]);
}

/* ------------------ Public status page ------------------ */

// Receive browser-collected metrics and attach them to the visitor record.
router.post('/api/visitor-data', (req, res) => {
  const id = parseInt(req.body.visitorId, 10);
  if (!id) return res.json({ ok: false });
  try {
    updateBrowser.run(
      parseInt(req.body.screenWidth)  || null,
      parseInt(req.body.screenHeight) || null,
      parseInt(req.body.windowWidth)  || null,
      parseInt(req.body.windowHeight) || null,
      req.body.timezone        || null,
      parseInt(req.body.colorDepth)   || null,
      parseInt(req.body.hardwareConcurrency) || null,
      parseFloat(req.body.deviceMemory)      || null,
      parseInt(req.body.touchPoints)  || null,
      req.body.connectionType  || null,
      req.body.platform        || null,
      req.body.cookiesEnabled === 'true' ? 1 : 0,
      req.body.doNotTrack      || null,
      parseInt(req.body.historyLength) || null,
      id
    );
  } catch (_) {}
  res.json({ ok: true });
});

router.get('/', trackVisit, (req, res) => {
  const win = ['24h', '30d', '1y'].includes(req.query.window) ? req.query.window : '24h';
  const summaries = getSiteSummaries(win);
  const groups = groupSummaries(summaries);

  const primarySummaries = groups.map(g => g[0]);
  const childSummaries = groups.flatMap(g => g.slice(1));

  const anyPrimaryDown = primarySummaries.some(s => s.last && s.last.is_up === 0);
  const allPrimaryUp = primarySummaries.length > 0 && primarySummaries.every(s => s.last && s.last.is_up === 1);
  const anyChildDown = childSummaries.some(s => s.last && s.last.is_up === 0);
  const primaryDownCount = primarySummaries.filter(s => s.last && s.last.is_up === 0).length;
  const sslExpiringSoon = summaries.some(
    s => s.last && s.last.ssl_valid === 1 && s.last.ssl_days_remaining != null && s.last.ssl_days_remaining <= 30
  );

  let overall;
  if (summaries.length === 0) {
    overall = { label: 'No sites configured', cls: 'muted' };
  } else if (anyPrimaryDown) {
    overall = { label: `${primaryDownCount} of ${primarySummaries.length} system${primarySummaries.length !== 1 ? 's' : ''} affected`, cls: 'down' };
  } else if (allPrimaryUp && anyChildDown && sslExpiringSoon) {
    overall = { label: 'All systems operational — SSL renewal needed soon', cls: 'warn' };
  } else if (allPrimaryUp && anyChildDown) {
    overall = { label: 'All systems operational', cls: 'ok' };
  } else if (allPrimaryUp && sslExpiringSoon) {
    overall = { label: 'All systems operational — SSL renewal needed soon', cls: 'warn' };
  } else if (allPrimaryUp) {
    overall = { label: 'All systems operational', cls: 'ok' };
  } else {
    overall = { label: 'Status unknown — waiting for first checks', cls: 'muted' };
  }

  res.render('status', {
    summaries, groups, overall,
    childrenWarning: allPrimaryUp && anyChildDown,
    currentWindow: win,
    measurementRegion: MEASUREMENT_REGION,
    measurementHost: MEASUREMENT_HOST,
    totalSites: summaries.length,
    downCount: primaryDownCount,
  });
});

/* ------------------ JSON API ------------------ */

router.get('/api/status', (req, res) => {
  const out = getSiteSummaries().map(({ site, last, uptime24hPct, uptime30dPct, uptime1yPct,
                                        rtStats, rtTier, codes24h, errorCount24h }) => ({
    id: site.id,
    name: site.name,
    url: site.url,
    is_up: last ? !!last.is_up : null,
    status_code: last?.status_code ?? null,
    status_code_tier: statusCodeTier(last?.status_code ?? null),
    response_time_ms: last?.response_time_ms ?? null,
    response_time_tier: rtTier,
    response_time_avg_24h_ms: rtStats?.avg_ms ? Math.round(rtStats.avg_ms) : null,
    ssl_valid: last ? (last.ssl_valid === 1) : null,
    ssl_days_remaining: last?.ssl_days_remaining ?? null,
    ssl_expires_at: last?.ssl_expires_at ?? null,
    last_checked_at: last?.checked_at ?? null,
    uptime_24h_pct: uptime24hPct,
    uptime_30d_pct: uptime30dPct,
    uptime_1y_pct:  uptime1yPct,
    status_codes_24h: codes24h,
    error_count_24h: errorCount24h,
    error: last?.error_message ?? null,
  }));
  res.json({
    generated_at: new Date().toISOString(),
    measurement_region: MEASUREMENT_REGION || null,
    measurement_host: MEASUREMENT_HOST,
    sites: out,
  });
});

// Per-site status-code breakdown over a configurable window.
router.get('/api/sites/:id/status-codes', (req, res) => {
  const site = db.prepare('SELECT id, name, url FROM sites WHERE id = ?').get(req.params.id);
  if (!site) return res.status(404).json({ error: 'not found' });
  const allowed = { '24h': '-1 day', '7d': '-7 days', '30d': '-30 days', '1y': '-1 year' };
  const win = allowed[req.query.window] || '-1 day';
  const dist = statusCodeDistStmt.all(site.id, win).map((r) => ({
    ...r, tier: statusCodeTier(r.status_code), label: statusCodeLabel(r.status_code),
  }));
  res.json({ site, window: req.query.window || '24h', distribution: dist });
});

/* ------------------ Per-site detail (used by expandable row, served as JSON) ------------------ */

router.get('/api/sites/:id/detail', (req, res) => {
  const site = db.prepare('SELECT * FROM sites WHERE id = ? AND enabled = 1').get(req.params.id);
  if (!site) return res.status(404).json({ error: 'not found' });
  const recent = recentChecksStmt.all(site.id).reverse();
  const incidents = recentIncidentsStmt.all(site.id);
  res.json({
    site: { id: site.id, name: site.name, url: site.url },
    recent_checks: recent.map((c) => ({
      checked_at: c.checked_at,
      is_up: !!c.is_up,
      status_code: c.status_code,
      response_time_ms: c.response_time_ms,
      ssl_valid: c.ssl_valid === 1,
      error: c.error_message,
    })),
    incidents: incidents.map((i) => ({
      id: i.id,
      started_at: i.started_at,
      resolved_at: i.resolved_at,
      reason: i.reason,
    })),
  });
});

/* ------------------ Response time chart data ------------------ */

router.get('/api/sites/:id/response-chart', (req, res) => {
  const siteId = parseInt(req.params.id, 10);
  const hours = Math.min(parseInt(req.query.hours || '24', 10), 168);
  const rows = db.prepare(`
    SELECT checked_at, response_time_ms, is_up
    FROM checks
    WHERE site_id = ? AND checked_at >= datetime('now', '-' || ? || ' hours')
      AND response_time_ms IS NOT NULL
    ORDER BY checked_at ASC
  `).all(siteId, hours);
  res.json(rows);
});

/* ------------------ Bug report (public form) ------------------ */

router.get('/report', (req, res) => {
  const sites = db.prepare('SELECT id, name, url FROM sites WHERE enabled = 1 ORDER BY name').all();
  const preselectedSiteId = req.query.site ? parseInt(req.query.site, 10) : null;
  res.render('report', { sites, preselectedSiteId, error: null, values: {} });
});

router.post('/report', async (req, res) => {
  const { site_id, reporter_name, reporter_email, severity, description, page_url } = req.body;
  const sites = db.prepare('SELECT id, name, url FROM sites WHERE enabled = 1 ORDER BY name').all();
  const errors = [];
  if (!description || description.trim().length < 10) {
    errors.push('Please describe the problem in at least 10 characters.');
  }
  if (description && description.length > 5000) {
    errors.push('Description is too long (max 5000 characters).');
  }
  if (reporter_email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(reporter_email)) {
    errors.push('Please enter a valid email or leave it blank.');
  }
  const allowedSeverities = ['low', 'medium', 'high'];
  const sev = allowedSeverities.includes(severity) ? severity : 'medium';

  if (errors.length) {
    return res.status(400).render('report', {
      sites,
      preselectedSiteId: site_id ? parseInt(site_id, 10) : null,
      error: errors.join(' '),
      values: { reporter_name, reporter_email, severity: sev, description, page_url },
    });
  }

  const userAgent = (req.get('user-agent') || '').slice(0, 500);
  const info = db.prepare(`
    INSERT INTO reports (site_id, reporter_name, reporter_email, severity, description, page_url, user_agent)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    site_id ? parseInt(site_id, 10) : null,
    (reporter_name || '').trim().slice(0, 120) || null,
    (reporter_email || '').trim().slice(0, 240) || null,
    sev,
    description.trim(),
    (page_url || '').trim().slice(0, 500) || null,
    userAgent
  );

  // Fire-and-forget admin notification.
  (async () => {
    try {
      const reportRow = db.prepare('SELECT * FROM reports WHERE id = ?').get(info.lastInsertRowid);
      const site = reportRow.site_id ? db.prepare('SELECT * FROM sites WHERE id = ?').get(reportRow.site_id) : null;
      await notifier.sendBugReportNotification(reportRow, site);
    } catch (e) { /* logged in notifier already */ }
  })();

  res.redirect('/report/thanks');
});

router.get('/report/thanks', (req, res) => res.render('report-thanks'));

// Export helpers so the admin routes can reuse the same classification.
module.exports = router;
module.exports.statusCodeTier  = statusCodeTier;
module.exports.statusCodeLabel = statusCodeLabel;
