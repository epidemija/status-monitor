const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db/database');
const { requireLogin } = require('../middleware/auth');
const monitor = require('../lib/monitor');
const notifier = require('../lib/notifier');
const { statusCodeTier, statusCodeLabel } = require('./public');

const router = express.Router();
router.use(requireLogin);

// Make user info available to all admin templates
router.use((req, res, next) => {
  res.locals.userEmail = req.session.userEmail;
  next();
});

// --- Dashboard ---
router.get('/', (req, res) => {
  const sites = db.prepare('SELECT * FROM sites ORDER BY name').all();
  const lastCheckStmt = db.prepare(
    'SELECT * FROM checks WHERE site_id = ? ORDER BY id DESC LIMIT 1'
  );
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
  const openReports = db.prepare(
    "SELECT COUNT(*) AS c FROM reports WHERE status = 'open'"
  ).get().c;
  const errorCodes24h = db.prepare(`
    SELECT COUNT(*) AS c FROM checks
    WHERE checked_at >= datetime('now', '-1 day') AND status_code >= 400
  `).get().c;
  // Sites whose SSL cert expires in <= 30 days, based on the latest check.
  const sslSoon = db.prepare(`
    SELECT s.id, s.name, s.url, c.ssl_days_remaining, c.ssl_expires_at
    FROM sites s
    JOIN checks c ON c.id = (SELECT id FROM checks WHERE site_id = s.id ORDER BY id DESC LIMIT 1)
    WHERE c.ssl_valid = 1 AND c.ssl_days_remaining IS NOT NULL AND c.ssl_days_remaining <= 30
    ORDER BY c.ssl_days_remaining ASC
  `).all();
  res.render('admin/dashboard', { summary, openIncidents, openReports, sslSoon, errorCodes24h });
});

// --- Status codes view (every non-2xx response across all sites) ---
router.get('/status-codes', (req, res) => {
  const allowedWindows = { '24h': '-1 day', '7d': '-7 days', '30d': '-30 days', '1y': '-1 year' };
  const winKey = req.query.window && allowedWindows[req.query.window] ? req.query.window : '24h';
  const winSql = allowedWindows[winKey];
  const codeFilter = req.query.code ? parseInt(req.query.code, 10) : null;
  const siteFilter = req.query.site ? parseInt(req.query.site, 10) : null;

  // Summary by code (across all sites in the window)
  const summary = db.prepare(`
    SELECT status_code, COUNT(*) AS count, COUNT(DISTINCT site_id) AS sites
    FROM checks
    WHERE checked_at >= datetime('now', ?) AND status_code IS NOT NULL AND status_code >= 400
    GROUP BY status_code
    ORDER BY count DESC
  `).all(winSql).map((r) => ({ ...r, tier: statusCodeTier(r.status_code), label: statusCodeLabel(r.status_code) }));

  // Recent events list (filtered)
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

// --- Sites list ---
router.get('/sites', (req, res) => {
  const sites = db.prepare('SELECT * FROM sites ORDER BY name').all();
  res.render('admin/sites', { sites, flash: req.query.flash || null });
});

// --- Add site ---
router.get('/sites/new', (req, res) => {
  res.render('admin/site-edit', { site: null, error: null });
});

router.post('/sites/new', (req, res) => {
  const { name, url, expected_status, expected_keyword, notify_on_down, enabled,
          response_time_warn_ms, response_time_crit_ms, ssl_warn_days } = req.body;
  if (!name || !url) {
    return res.status(400).render('admin/site-edit', { site: null, error: 'Name and URL are required' });
  }
  try {
    new URL(url); // validate
  } catch (e) {
    return res.status(400).render('admin/site-edit', { site: null, error: 'Invalid URL' });
  }
  db.prepare(`
    INSERT INTO sites
      (name, url, enabled, expected_status, expected_keyword, notify_on_down,
       response_time_warn_ms, response_time_crit_ms, ssl_warn_days)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    name.trim(),
    url.trim(),
    enabled === 'on' ? 1 : 0,
    parseInt(expected_status || '200', 10) || 200,
    (expected_keyword || '').trim() || null,
    notify_on_down === 'on' ? 1 : 0,
    parseInt(response_time_warn_ms || '800', 10) || 800,
    parseInt(response_time_crit_ms || '2500', 10) || 2500,
    parseInt(ssl_warn_days || '30', 10) || 30
  );
  res.redirect('/admin/sites?flash=Site+added');
});

// --- Edit site ---
router.get('/sites/:id/edit', (req, res) => {
  const site = db.prepare('SELECT * FROM sites WHERE id = ?').get(req.params.id);
  if (!site) return res.status(404).send('Not found');
  res.render('admin/site-edit', { site, error: null });
});

router.post('/sites/:id/edit', (req, res) => {
  const site = db.prepare('SELECT * FROM sites WHERE id = ?').get(req.params.id);
  if (!site) return res.status(404).send('Not found');
  const { name, url, expected_status, expected_keyword, notify_on_down, enabled,
          response_time_warn_ms, response_time_crit_ms, ssl_warn_days } = req.body;
  try { new URL(url); } catch (e) {
    return res.status(400).render('admin/site-edit', { site, error: 'Invalid URL' });
  }
  db.prepare(`
    UPDATE sites
    SET name = ?, url = ?, enabled = ?, expected_status = ?,
        expected_keyword = ?, notify_on_down = ?,
        response_time_warn_ms = ?, response_time_crit_ms = ?, ssl_warn_days = ?
    WHERE id = ?
  `).run(
    (name || '').trim(),
    (url || '').trim(),
    enabled === 'on' ? 1 : 0,
    parseInt(expected_status || '200', 10) || 200,
    (expected_keyword || '').trim() || null,
    notify_on_down === 'on' ? 1 : 0,
    parseInt(response_time_warn_ms || '800', 10) || 800,
    parseInt(response_time_crit_ms || '2500', 10) || 2500,
    parseInt(ssl_warn_days || '30', 10) || 30,
    req.params.id
  );
  res.redirect('/admin/sites?flash=Site+updated');
});

// --- Delete site ---
router.post('/sites/:id/delete', (req, res) => {
  db.prepare('DELETE FROM sites WHERE id = ?').run(req.params.id);
  res.redirect('/admin/sites?flash=Site+removed');
});

// --- Run a check on demand ---
router.post('/sites/:id/check', async (req, res) => {
  const site = db.prepare('SELECT * FROM sites WHERE id = ?').get(req.params.id);
  if (!site) return res.status(404).send('Not found');
  try {
    const result = await monitor.checkSite(site);
    monitor.recordCheck(result);
    res.redirect('/admin/sites?flash=Check+complete');
  } catch (err) {
    res.status(500).send('Check failed: ' + err.message);
  }
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

// --- Reports (bug reports submitted by users from the public page) ---
router.get('/reports', (req, res) => {
  const status = req.query.status || 'open';
  const validStatus = ['open', 'in_progress', 'resolved', 'all'].includes(status) ? status : 'open';
  const where = validStatus === 'all' ? '' : 'WHERE r.status = ?';
  const params = validStatus === 'all' ? [] : [validStatus];
  const reports = db.prepare(`
    SELECT r.*, s.name AS site_name, s.url AS site_url
    FROM reports r LEFT JOIN sites s ON s.id = r.site_id
    ${where}
    ORDER BY r.created_at DESC
    LIMIT 200
  `).all(...params);
  const counts = db.prepare(`
    SELECT status, COUNT(*) AS c FROM reports GROUP BY status
  `).all().reduce((acc, r) => { acc[r.status] = r.c; return acc; }, { open: 0, in_progress: 0, resolved: 0 });
  res.render('admin/reports', { reports, counts, currentStatus: validStatus, flash: req.query.flash || null });
});

router.post('/reports/:id/status', (req, res) => {
  const status = ['open', 'in_progress', 'resolved'].includes(req.body.status) ? req.body.status : 'open';
  if (status === 'resolved') {
    db.prepare("UPDATE reports SET status = ?, resolved_at = CURRENT_TIMESTAMP WHERE id = ?").run(status, req.params.id);
  } else {
    db.prepare("UPDATE reports SET status = ?, resolved_at = NULL WHERE id = ?").run(status, req.params.id);
  }
  res.redirect('/admin/reports?status=' + (req.query.return || status) + '&flash=Updated');
});

router.post('/reports/:id/delete', (req, res) => {
  db.prepare('DELETE FROM reports WHERE id = ?').run(req.params.id);
  res.redirect('/admin/reports?flash=Report+deleted');
});

// --- Settings ---
router.get('/settings', (req, res) => {
  const all = db.prepare('SELECT key, value FROM settings').all();
  const map = Object.fromEntries(all.map((r) => [r.key, r.value]));
  res.render('admin/settings', {
    settings: map,
    smtpConfigured: !!process.env.SMTP_HOST && !!process.env.SMTP_USER,
    twilioConfigured: !!process.env.TWILIO_ACCOUNT_SID && !!process.env.TWILIO_WHATSAPP_FROM,
    flash: req.query.flash || null,
  });
});

router.post('/settings', (req, res) => {
  const updates = {
    email_enabled: req.body.email_enabled === 'on' ? '1' : '0',
    email_recipients: (req.body.email_recipients || '').trim(),
    whatsapp_enabled: req.body.whatsapp_enabled === 'on' ? '1' : '0',
    whatsapp_recipients: (req.body.whatsapp_recipients || '').trim(),
    notify_on_report: req.body.notify_on_report === 'on' ? '1' : '0',
  };
  const stmt = db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  );
  for (const [k, v] of Object.entries(updates)) stmt.run(k, v);
  res.redirect('/admin/settings?flash=Settings+saved');
});

router.post('/settings/test-email', async (req, res) => {
  const r = await notifier.sendTestEmail();
  const flash = r.ok ? 'Test+email+sent' : ('Email+failed:+' + encodeURIComponent(r.error));
  res.redirect('/admin/settings?flash=' + flash);
});

router.post('/settings/test-whatsapp', async (req, res) => {
  const r = await notifier.sendTestWhatsApp();
  const flash = r.ok ? 'Test+WhatsApp+sent' : ('WhatsApp+failed:+' + encodeURIComponent(r.error));
  res.redirect('/admin/settings?flash=' + flash);
});

// --- Account / Change password ---
router.get('/account', (req, res) => {
  res.render('admin/account', { error: null, flash: req.query.flash || null });
});

router.post('/account/password', (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId);
  if (!user) return res.redirect('/login');
  const { current, next, confirm } = req.body;
  if (!bcrypt.compareSync(current || '', user.password_hash)) {
    return res.status(400).render('admin/account', { error: 'Current password is incorrect', flash: null });
  }
  if (!next || next.length < 8) {
    return res.status(400).render('admin/account', { error: 'New password must be at least 8 characters', flash: null });
  }
  if (next !== confirm) {
    return res.status(400).render('admin/account', { error: 'Confirmation does not match', flash: null });
  }
  const hash = bcrypt.hashSync(next, 10);
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, user.id);
  res.redirect('/admin/account?flash=Password+updated');
});

module.exports = router;
