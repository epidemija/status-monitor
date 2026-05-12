const express = require('express');
const db = require('../db/database');
const { requireLogin } = require('../middleware/auth');
const monitor = require('../lib/monitor');

const router = express.Router();
router.use(requireLogin);

router.use((req, res, next) => {
  res.locals.userEmail = req.session.userEmail;
  res.locals.userRole = req.session.userRole;
  res.locals.currentPath = req.path;
  res.locals.pendingCount = req.session.userRole === 'admin'
    ? db.prepare("SELECT COUNT(*) AS c FROM pending_actions WHERE status = 'pending'").get().c
    : 0;
  next();
});

// --- Dashboard ---
router.get('/', (req, res) => {
  const sites = db.prepare('SELECT * FROM sites ORDER BY sort_order ASC, name ASC').all();
  const lastCheckStmt = db.prepare('SELECT * FROM checks WHERE site_id = ? ORDER BY id DESC LIMIT 1');
  const rtStmt = db.prepare(`
    SELECT AVG(response_time_ms) AS avg_ms, COUNT(*) AS samples
    FROM checks
    WHERE site_id = ? AND checked_at >= datetime('now', '-1 day') AND response_time_ms IS NOT NULL
  `);
  const summary = sites.map((s) => {
    const last = lastCheckStmt.get(s.id);
    const rt = rtStmt.get(s.id);
    return {
      site: s,
      last,
      avgRt24h: rt && rt.samples > 0 ? Math.round(rt.avg_ms) : null,
      rtTier: monitor.tierResponseTime(s, last?.response_time_ms),
    };
  });
  const openIncidents = db.prepare(`
    SELECT i.*, s.name AS site_name, s.url AS site_url
    FROM incidents i JOIN sites s ON s.id = i.site_id
    WHERE i.resolved_at IS NULL
    ORDER BY i.started_at DESC
  `).all();
  const openReports = db.prepare("SELECT COUNT(*) AS c FROM reports WHERE status = 'open'").get().c;
  const errorCodes24h = db.prepare(`
    SELECT COUNT(*) AS c FROM checks
    WHERE checked_at >= datetime('now', '-1 day') AND status_code >= 400
  `).get().c;
  const sslSoon = db.prepare(`
    SELECT s.id, s.name, s.url, c.ssl_days_remaining, c.ssl_expires_at
    FROM sites s
    JOIN checks c ON c.id = (SELECT id FROM checks WHERE site_id = s.id ORDER BY id DESC LIMIT 1)
    WHERE c.ssl_valid = 1 AND c.ssl_days_remaining IS NOT NULL AND c.ssl_days_remaining <= 30
    ORDER BY c.ssl_days_remaining ASC
  `).all();
  // Active maintenance windows
  const activeMaintenance = db.prepare(`
    SELECT mw.*, s.name AS site_name
    FROM maintenance_windows mw
    LEFT JOIN sites s ON s.id = mw.site_id
    WHERE mw.starts_at <= datetime('now') AND mw.ends_at >= datetime('now')
    ORDER BY mw.ends_at ASC
  `).all();
  res.render('admin/dashboard', { summary, openIncidents, openReports, sslSoon, errorCodes24h, activeMaintenance });
});

router.use('/', require('./admin-sites'));
router.use('/', require('./admin-monitoring'));
router.use('/', require('./admin-settings'));
router.use('/', require('./admin-tools'));
router.use('/', require('./admin-users'));

module.exports = router;
