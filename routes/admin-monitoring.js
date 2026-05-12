const express = require('express');
const db = require('../db/database');
const { statusCodeTier, statusCodeLabel } = require('./public');
const router = express.Router();

// --- Status codes view ---
router.get('/status-codes', (req, res) => {
  const allowedWindows = { '24h': '-1 day', '7d': '-7 days', '30d': '-30 days', '1y': '-1 year' };
  const winKey = req.query.window && allowedWindows[req.query.window] ? req.query.window : '24h';
  const winSql = allowedWindows[winKey];
  const codeFilter = req.query.code ? parseInt(req.query.code, 10) : null;
  const siteFilter = req.query.site ? parseInt(req.query.site, 10) : null;

  const summary = db.prepare(`
    SELECT status_code, COUNT(*) AS count, COUNT(DISTINCT site_id) AS sites
    FROM checks
    WHERE checked_at >= datetime('now', ?) AND status_code IS NOT NULL AND status_code >= 400
    GROUP BY status_code
    ORDER BY count DESC
  `).all(winSql).map((r) => ({ ...r, tier: statusCodeTier(r.status_code), label: statusCodeLabel(r.status_code) }));

  const where = ['c.checked_at >= datetime(\'now\', ?)', 'c.status_code IS NOT NULL', 'c.status_code >= 400'];
  const params = [winSql];
  if (codeFilter) { where.push('c.status_code = ?'); params.push(codeFilter); }
  if (siteFilter) { where.push('c.site_id = ?'); params.push(siteFilter); }
  const events = db.prepare(`
    SELECT c.*, s.name AS site_name, s.url AS site_url
    FROM checks c JOIN sites s ON s.id = c.site_id
    WHERE ${where.join(' AND ')}
    ORDER BY c.id DESC
    LIMIT 200
  `).all(...params).map((r) => ({ ...r, tier: statusCodeTier(r.status_code), label: statusCodeLabel(r.status_code) }));

  const sites = db.prepare('SELECT id, name FROM sites ORDER BY name').all();

  res.render('admin/status-codes', {
    summary, events, sites,
    currentWindow: winKey, currentCode: codeFilter, currentSite: siteFilter,
  });
});

// --- Incidents ---
router.get('/incidents', (req, res) => {
  const rows = db.prepare(`
    SELECT i.*, s.name AS site_name, s.url AS site_url
    FROM incidents i JOIN sites s ON s.id = i.site_id
    ORDER BY i.started_at DESC LIMIT 200
  `).all();
  res.render('admin/incidents', { incidents: rows });
});

// --- Detailed check log ---
router.get('/check-log', (req, res) => {
  const limit   = Math.min(parseInt(req.query.limit  || '250', 10), 1000);
  const siteId  = req.query.site   ? parseInt(req.query.site, 10) : null;
  const status  = ['up', 'down'].includes(req.query.status) ? req.query.status : '';
  const window  = ['1h', '6h', '24h', '7d'].includes(req.query.window) ? req.query.window : '24h';

  const windowMap = { '1h': '-1 hour', '6h': '-6 hours', '24h': '-1 day', '7d': '-7 days' };
  const winSql = windowMap[window];

  const where  = [`c.checked_at >= datetime('now', '${winSql}')`];
  const params = [];
  if (siteId)        { where.push('c.site_id = ?'); params.push(siteId); }
  if (status === 'up')   where.push('c.is_up = 1');
  if (status === 'down') where.push('c.is_up = 0');

  const checks = db.prepare(`
    SELECT c.*, s.name AS site_name, s.url AS site_url
    FROM checks c JOIN sites s ON s.id = c.site_id
    WHERE ${where.join(' AND ')}
    ORDER BY c.id DESC
    LIMIT ?
  `).all(...params, limit);

  const sites = db.prepare('SELECT id, name FROM sites ORDER BY name').all();
  res.render('admin/check-log', { checks, sites, limit, siteId, status, window });
});

// --- Uptime statistics ---
router.get('/uptime', (req, res) => {
  const sites = db.prepare('SELECT * FROM sites WHERE parent_id IS NULL ORDER BY sort_order ASC, name ASC').all();
  const lastCheck = db.prepare('SELECT * FROM checks WHERE site_id = ? ORDER BY id DESC LIMIT 1');
  const statsStmt = db.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(is_up) AS up_count,
      ROUND(AVG(CASE WHEN response_time_ms IS NOT NULL THEN response_time_ms END)) AS avg_rt_ms
    FROM checks
    WHERE site_id = ? AND checked_at >= datetime('now', ?)
  `);
  const data = sites.map(s => ({
    ...s,
    last: lastCheck.get(s.id) || null,
    d1:  statsStmt.get(s.id, '-1 day'),
    d7:  statsStmt.get(s.id, '-7 days'),
    d30: statsStmt.get(s.id, '-30 days'),
    d90: statsStmt.get(s.id, '-90 days'),
  }));
  res.render('admin/uptime', { data, flash: req.query.flash || null });
});

// --- Maintenance windows ---
router.get('/maintenance', (req, res) => {
  const sites = db.prepare('SELECT id, name FROM sites WHERE parent_id IS NULL ORDER BY name').all();
  const windows = db.prepare(`
    SELECT mw.*, s.name AS site_name
    FROM maintenance_windows mw
    LEFT JOIN sites s ON s.id = mw.site_id
    ORDER BY mw.starts_at DESC
    LIMIT 100
  `).all();
  res.render('admin/maintenance', { windows, sites, flash: req.query.flash || null, error: null });
});

router.post('/maintenance/new', (req, res) => {
  const { title, site_id, starts_at, ends_at } = req.body;
  if (!title || !starts_at || !ends_at) {
    const sites = db.prepare('SELECT id, name FROM sites WHERE parent_id IS NULL ORDER BY name').all();
    const windows = db.prepare(`SELECT mw.*, s.name AS site_name FROM maintenance_windows mw LEFT JOIN sites s ON s.id = mw.site_id ORDER BY mw.starts_at DESC LIMIT 100`).all();
    return res.render('admin/maintenance', { windows, sites, flash: null, error: 'Title, start and end time are required' });
  }
  if (new Date(starts_at) >= new Date(ends_at)) {
    const sites = db.prepare('SELECT id, name FROM sites WHERE parent_id IS NULL ORDER BY name').all();
    const windows = db.prepare(`SELECT mw.*, s.name AS site_name FROM maintenance_windows mw LEFT JOIN sites s ON s.id = mw.site_id ORDER BY mw.starts_at DESC LIMIT 100`).all();
    return res.render('admin/maintenance', { windows, sites, flash: null, error: 'End time must be after start time' });
  }
  const siteId = site_id && site_id !== '' ? parseInt(site_id, 10) || null : null;
  db.prepare('INSERT INTO maintenance_windows (title, site_id, starts_at, ends_at, created_by) VALUES (?, ?, ?, ?, ?)').run(
    title.trim(), siteId, starts_at, ends_at, req.session.userEmail
  );
  res.redirect('/admin/maintenance?flash=' + encodeURIComponent('Maintenance window scheduled'));
});

router.post('/maintenance/:id/delete', (req, res) => {
  db.prepare('DELETE FROM maintenance_windows WHERE id = ?').run(req.params.id);
  res.redirect('/admin/maintenance?flash=' + encodeURIComponent('Maintenance window removed'));
});

module.exports = router;
