const express = require('express');
const bcrypt = require('bcryptjs');
const axios = require('axios');
const fs = require('fs');
const db = require('../db/database');
const { LOG_PATH } = require('../lib/logger');
const { requireLogin, requireAdmin } = require('../middleware/auth');
const monitor = require('../lib/monitor');
const notifier = require('../lib/notifier');
const { runGeoSweep, LOCATIONS } = require('../lib/geo');
const { scanAndFormat }          = require('../lib/cms');
const { statusCodeTier, statusCodeLabel } = require('./public');

const router = express.Router();
router.use(requireLogin);

// Make user info and pending-action count available to all admin templates.
router.use((req, res, next) => {
  res.locals.userEmail = req.session.userEmail;
  res.locals.userRole = req.session.userRole;
  res.locals.currentPath = req.path;
  res.locals.pendingCount = req.session.userRole === 'admin'
    ? db.prepare("SELECT COUNT(*) AS c FROM pending_actions WHERE status = 'pending'").get().c
    : 0;
  next();
});

// Queue a moderator action for admin review instead of executing it immediately.
function queueAction(req, res, actionType, actionData, description, redirectTo) {
  db.prepare(`
    INSERT INTO pending_actions (user_id, user_email, action_type, action_data, description)
    VALUES (?, ?, ?, ?, ?)
  `).run(req.session.userId, req.session.userEmail, actionType, JSON.stringify(actionData), description);
  notifier.sendPendingActionNotification(req.session.userEmail, description).catch(() => {});
  return res.redirect(redirectTo + '?flash=Change+submitted+for+admin+approval');
}

// --- Dashboard ---
router.get('/', (req, res) => {
  const sites = db.prepare('SELECT * FROM sites ORDER BY sort_order ASC, name ASC').all();
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
  const sslSoon = db.prepare(`
    SELECT s.id, s.name, s.url, c.ssl_days_remaining, c.ssl_expires_at
    FROM sites s
    JOIN checks c ON c.id = (SELECT id FROM checks WHERE site_id = s.id ORDER BY id DESC LIMIT 1)
    WHERE c.ssl_valid = 1 AND c.ssl_days_remaining IS NOT NULL AND c.ssl_days_remaining <= 30
    ORDER BY c.ssl_days_remaining ASC
  `).all();
  res.render('admin/dashboard', { summary, openIncidents, openReports, sslSoon, errorCodes24h });
});

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

// --- Sites list ---
router.get('/sites', (req, res) => {
  const sites = db.prepare('SELECT * FROM sites ORDER BY sort_order ASC, name ASC').all();
  const lastCheckStmt = db.prepare(
    'SELECT is_up, status_code, redirect_count, final_url FROM checks WHERE site_id = ? ORDER BY id DESC LIMIT 1'
  );
  const sitesWithStatus = sites.map(s => ({ ...s, last: lastCheckStmt.get(s.id) || null }));
  res.render('admin/sites', { sites: sitesWithStatus, flash: req.query.flash || null });
});

// --- Export sites as JSON ---
router.get('/sites/export', (req, res) => {
  const sites = db.prepare('SELECT * FROM sites ORDER BY sort_order ASC, name ASC').all();
  const byId = new Map(sites.map((s) => [s.id, s]));

  const payload = {
    exported_at: new Date().toISOString(),
    app: 'status-monitor',
    version: 1,
    count: sites.length,
    sites: sites.map((s) => ({
      name:                   s.name,
      url:                    s.url,
      enabled:                Boolean(s.enabled),
      expected_status:        s.expected_status  || 200,
      expected_keyword:       s.expected_keyword  || null,
      notify_on_down:         Boolean(s.notify_on_down),
      response_time_warn_ms:  s.response_time_warn_ms  || 800,
      response_time_crit_ms:  s.response_time_crit_ms  || 2500,
      ssl_warn_days:          s.ssl_warn_days     || 30,
      sort_order:             s.sort_order        ?? null,
      parent_url:             s.parent_id ? (byId.get(s.parent_id)?.url ?? null) : null,
    })),
  };

  const filename = `sites-backup-${new Date().toISOString().slice(0, 10)}.json`;
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.send(JSON.stringify(payload, null, 2));
});

// --- Import sites from JSON ---
router.get('/sites/import', requireAdmin, (req, res) => {
  res.render('admin/site-import', { error: null });
});

router.post('/sites/import', requireAdmin, (req, res) => {
  const raw  = (req.body.json || '').trim();
  const mode = req.body.mode === 'update' ? 'update' : 'skip';

  let data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    return res.render('admin/site-import', { error: `Invalid JSON: ${e.message}` });
  }
  if (!data || !Array.isArray(data.sites)) {
    return res.render('admin/site-import', { error: 'Invalid format — expected a JSON object with a "sites" array.' });
  }

  // Build a URL → id map for all current sites so we can detect duplicates
  // and resolve parent_url references.
  const urlToId = new Map(
    db.prepare('SELECT id, url FROM sites').all().map((s) => [s.url, s.id])
  );
  const importedUrlToId = new Map(); // tracks IDs of sites touched in this import

  const insertSite = db.prepare(`
    INSERT INTO sites
      (name, url, enabled, expected_status, expected_keyword, notify_on_down,
       response_time_warn_ms, response_time_crit_ms, ssl_warn_days, sort_order)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const updateSite = db.prepare(`
    UPDATE sites SET
      name = ?, enabled = ?, expected_status = ?, expected_keyword = ?,
      notify_on_down = ?, response_time_warn_ms = ?, response_time_crit_ms = ?,
      ssl_warn_days = ?
    WHERE id = ?
  `);

  let added = 0, updated = 0, skipped = 0, errored = 0;

  // First pass — insert / update without parent_id (resolved in second pass).
  for (const s of data.sites) {
    if (!s.url || !s.name) { errored++; continue; }
    try { new URL(s.url); } catch (_) { errored++; continue; }

    const existingId = urlToId.get(s.url);
    const enabled  = s.enabled  !== false ? 1 : 0;
    const notify   = s.notify_on_down !== false ? 1 : 0;
    const expSt    = parseInt(s.expected_status)    || 200;
    const warnMs   = parseInt(s.response_time_warn_ms) || 800;
    const critMs   = parseInt(s.response_time_crit_ms) || 2500;
    const sslDays  = parseInt(s.ssl_warn_days)       || 30;
    const keyword  = s.expected_keyword || null;
    const order    = s.sort_order != null ? parseInt(s.sort_order) : null;

    if (existingId) {
      if (mode === 'update') {
        updateSite.run(s.name, enabled, expSt, keyword, notify, warnMs, critMs, sslDays, existingId);
        importedUrlToId.set(s.url, existingId);
        updated++;
      } else {
        importedUrlToId.set(s.url, existingId);
        skipped++;
      }
    } else {
      const { lastInsertRowid } = insertSite.run(
        s.name, s.url, enabled, expSt, keyword, notify, warnMs, critMs, sslDays, order
      );
      importedUrlToId.set(s.url, lastInsertRowid);
      urlToId.set(s.url, lastInsertRowid);
      added++;
    }
  }

  // Second pass — wire up parent_url → parent_id.
  for (const s of data.sites) {
    if (!s.parent_url || !s.url) continue;
    const childId  = importedUrlToId.get(s.url);
    const parentId = importedUrlToId.get(s.parent_url) ?? urlToId.get(s.parent_url);
    if (childId && parentId && childId !== parentId) {
      db.prepare('UPDATE sites SET parent_id = ? WHERE id = ?').run(parentId, childId);
    }
  }

  const parts = [`${added} added`];
  if (updated) parts.push(`${updated} updated`);
  if (skipped) parts.push(`${skipped} skipped (already exist)`);
  if (errored) parts.push(`${errored} invalid (skipped)`);
  res.redirect('/admin/sites?flash=' + encodeURIComponent('Import complete: ' + parts.join(', ')));
});

// --- Bulk add sites ---
router.get('/sites/bulk', (req, res) => {
  res.render('admin/site-bulk', { flash: req.query.flash || null, errors: [] });
});

router.post('/sites/bulk', (req, res) => {
  const lines = (req.body.bulk || '').split('\n');
  const sites = [];
  const errors = [];

  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;

    let name, url;
    const commaIdx = line.indexOf(',');
    if (commaIdx > 0) {
      name = line.slice(0, commaIdx).trim();
      url  = line.slice(commaIdx + 1).trim();
    } else {
      url = line;
      try { name = new URL(url).hostname; } catch (_) { name = url; }
    }

    if (!name) { errors.push(`Missing name: "${line}"`); continue; }
    try { new URL(url); } catch (_) { errors.push(`Invalid URL on line: "${line}"`); continue; }

    sites.push({ name, url });
  }

  if (sites.length === 0) {
    return res.render('admin/site-bulk', {
      flash: null,
      errors: errors.length ? errors : ['No valid sites found. Check the format and try again.'],
    });
  }

  if (req.session.userRole === 'moderator') {
    return queueAction(req, res, 'site_bulk_add', { sites },
      `Bulk add ${sites.length} site(s): ${sites.map((s) => s.name).join(', ')}`,
      '/admin/sites');
  }

  const insert = db.prepare(`
    INSERT INTO sites (name, url, enabled, expected_status, notify_on_down,
                       response_time_warn_ms, response_time_crit_ms, ssl_warn_days)
    VALUES (?, ?, 1, 200, 1, 800, 2500, 30)
  `);
  const tx = db.transaction((rows) => rows.forEach((r) => insert.run(r.name, r.url)));
  tx(sites);

  const msg = encodeURIComponent(`${sites.length} site(s) added${errors.length ? ` (${errors.length} line(s) skipped)` : ''}`);
  res.redirect('/admin/sites?flash=' + msg);
});

// --- Add site ---
router.get('/sites/new', (req, res) => {
  const allSites = db.prepare('SELECT id, name FROM sites ORDER BY name').all();
  res.render('admin/site-edit', { site: null, error: null, allSites });
});

router.post('/sites/new', (req, res) => {
  const allSites = db.prepare('SELECT id, name FROM sites ORDER BY name').all();
  const { name, url, expected_status, expected_keyword, notify_on_down, enabled,
          response_time_warn_ms, response_time_crit_ms, ssl_warn_days } = req.body;
  if (!name || !url) {
    return res.status(400).render('admin/site-edit', { site: null, error: 'Name and URL are required', allSites });
  }
  try {
    new URL(url);
  } catch (e) {
    return res.status(400).render('admin/site-edit', { site: null, error: 'Invalid URL', allSites });
  }

  const actionData = {
    name: name.trim(),
    url: url.trim(),
    enabled: enabled === 'on' ? 1 : 0,
    expected_status: parseInt(expected_status || '200', 10) || 200,
    expected_keyword: (expected_keyword || '').trim() || null,
    notify_on_down: notify_on_down === 'on' ? 1 : 0,
    response_time_warn_ms: parseInt(response_time_warn_ms || '800', 10) || 800,
    response_time_crit_ms: parseInt(response_time_crit_ms || '2500', 10) || 2500,
    ssl_warn_days: parseInt(ssl_warn_days || '30', 10) || 30,
    parent_id: req.body.parent_id ? parseInt(req.body.parent_id, 10) || null : null,
  };

  if (req.session.userRole === 'moderator') {
    return queueAction(req, res, 'site_add', actionData, `Add site: ${actionData.name}`, '/admin/sites');
  }

  db.prepare(`
    INSERT INTO sites
      (name, url, enabled, expected_status, expected_keyword, notify_on_down,
       response_time_warn_ms, response_time_crit_ms, ssl_warn_days, parent_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    actionData.name, actionData.url, actionData.enabled, actionData.expected_status,
    actionData.expected_keyword, actionData.notify_on_down, actionData.response_time_warn_ms,
    actionData.response_time_crit_ms, actionData.ssl_warn_days, actionData.parent_id
  );
  res.redirect('/admin/sites?flash=Site+added');
});

// --- Edit site ---
router.get('/sites/:id/edit', (req, res) => {
  const site = db.prepare('SELECT * FROM sites WHERE id = ?').get(req.params.id);
  if (!site) return res.status(404).send('Not found');
  const allSites = db.prepare('SELECT id, name FROM sites WHERE id != ? ORDER BY name').all(req.params.id);
  res.render('admin/site-edit', { site, error: null, allSites });
});

router.post('/sites/:id/edit', (req, res) => {
  const site = db.prepare('SELECT * FROM sites WHERE id = ?').get(req.params.id);
  if (!site) return res.status(404).send('Not found');
  const allSites = db.prepare('SELECT id, name FROM sites WHERE id != ? ORDER BY name').all(req.params.id);
  const { name, url, expected_status, expected_keyword, notify_on_down, enabled,
          response_time_warn_ms, response_time_crit_ms, ssl_warn_days } = req.body;
  try { new URL(url); } catch (e) {
    return res.status(400).render('admin/site-edit', { site, error: 'Invalid URL', allSites });
  }

  const actionData = {
    siteId: site.id,
    siteName: site.name,
    name: (name || '').trim(),
    url: (url || '').trim(),
    enabled: enabled === 'on' ? 1 : 0,
    expected_status: parseInt(expected_status || '200', 10) || 200,
    expected_keyword: (expected_keyword || '').trim() || null,
    notify_on_down: notify_on_down === 'on' ? 1 : 0,
    response_time_warn_ms: parseInt(response_time_warn_ms || '800', 10) || 800,
    response_time_crit_ms: parseInt(response_time_crit_ms || '2500', 10) || 2500,
    ssl_warn_days: parseInt(ssl_warn_days || '30', 10) || 30,
    parent_id: req.body.parent_id ? parseInt(req.body.parent_id, 10) || null : null,
  };

  if (req.session.userRole === 'moderator') {
    return queueAction(req, res, 'site_edit', actionData, `Edit site: ${actionData.name}`, '/admin/sites');
  }

  db.prepare(`
    UPDATE sites
    SET name = ?, url = ?, enabled = ?, expected_status = ?,
        expected_keyword = ?, notify_on_down = ?,
        response_time_warn_ms = ?, response_time_crit_ms = ?, ssl_warn_days = ?,
        parent_id = ?
    WHERE id = ?
  `).run(
    actionData.name, actionData.url, actionData.enabled, actionData.expected_status,
    actionData.expected_keyword, actionData.notify_on_down, actionData.response_time_warn_ms,
    actionData.response_time_crit_ms, actionData.ssl_warn_days, actionData.parent_id, req.params.id
  );
  res.redirect('/admin/sites?flash=Site+updated');
});

// --- Reorder sites (drag-and-drop; JSON body { ids: [1,2,3,...] }) ---
router.post('/sites/reorder', (req, res) => {
  const ids = [].concat(req.body.ids || []).map(Number).filter(Boolean);
  if (ids.length === 0) return res.status(400).json({ ok: false, error: 'No ids provided' });
  const stmt = db.prepare('UPDATE sites SET sort_order = ? WHERE id = ?');
  db.transaction((orderedIds) => {
    orderedIds.forEach((id, idx) => stmt.run(idx, id));
  })(ids);
  res.json({ ok: true });
});

// --- Bulk delete sites ---
router.post('/sites/bulk-delete', (req, res) => {
  const ids = [].concat(req.body.ids || []).map(Number).filter(Boolean);
  if (ids.length === 0) return res.redirect('/admin/sites?flash=Nothing+selected');

  if (req.session.userRole === 'moderator') {
    const names = db.prepare(`SELECT name FROM sites WHERE id IN (${ids.map(() => '?').join(',')})`)
      .all(...ids).map((r) => r.name).join(', ');
    return queueAction(req, res, 'site_bulk_delete', { ids },
      `Delete ${ids.length} site(s): ${names}`, '/admin/sites');
  }

  db.prepare(`DELETE FROM sites WHERE id IN (${ids.map(() => '?').join(',')})`).run(...ids);
  res.redirect('/admin/sites?flash=' + encodeURIComponent(`${ids.length} site(s) deleted`));
});

// --- Delete site ---
router.post('/sites/:id/delete', (req, res) => {
  const site = db.prepare('SELECT * FROM sites WHERE id = ?').get(req.params.id);
  if (!site) return res.redirect('/admin/sites?flash=Site+not+found');

  if (req.session.userRole === 'moderator') {
    return queueAction(req, res, 'site_delete', { siteId: site.id, siteName: site.name },
      `Delete site: ${site.name}`, '/admin/sites');
  }

  db.prepare('DELETE FROM sites WHERE id = ?').run(req.params.id);
  res.redirect('/admin/sites?flash=Site+removed');
});

// --- Check all sites ---
router.post('/sites/check-all', async (req, res) => {
  if (req.session.userRole === 'moderator') {
    return queueAction(req, res, 'check_all', {}, 'Check all sites now', '/admin/sites');
  }

  const sites = db.prepare('SELECT * FROM sites WHERE enabled = 1').all();
  let checked = 0;
  let errors = 0;
  for (const site of sites) {
    try {
      const result = await monitor.checkSite(site);
      monitor.recordCheck(result);
      checked++;
    } catch (_) {
      errors++;
    }
  }
  const msg = encodeURIComponent(`Checked ${checked} site(s)${errors ? `, ${errors} error(s)` : ''}`);
  res.redirect('/admin/sites?flash=' + msg);
});

// --- Run a check on demand ---
router.post('/sites/:id/check', async (req, res) => {
  const site = db.prepare('SELECT * FROM sites WHERE id = ?').get(req.params.id);
  if (!site) return res.status(404).send('Not found');

  if (req.session.userRole === 'moderator') {
    return queueAction(req, res, 'site_check', { siteId: site.id, siteName: site.name },
      `Run check: ${site.name}`, '/admin/sites');
  }

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

// --- Reports ---
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
  const returnStatus = req.query.return || status;

  if (req.session.userRole === 'moderator') {
    return queueAction(req, res, 'report_status',
      { reportId: req.params.id, status, return: returnStatus },
      `Set report #${req.params.id} status to: ${status}`,
      '/admin/reports');
  }

  if (status === 'resolved') {
    db.prepare("UPDATE reports SET status = ?, resolved_at = CURRENT_TIMESTAMP WHERE id = ?").run(status, req.params.id);
  } else {
    db.prepare("UPDATE reports SET status = ?, resolved_at = NULL WHERE id = ?").run(status, req.params.id);
  }
  res.redirect('/admin/reports?status=' + returnStatus + '&flash=Updated');
});

router.post('/reports/:id/delete', (req, res) => {
  if (req.session.userRole === 'moderator') {
    return queueAction(req, res, 'report_delete',
      { reportId: req.params.id },
      `Delete report #${req.params.id}`,
      '/admin/reports');
  }

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
    teams_enabled: req.body.teams_enabled === 'on' ? '1' : '0',
    teams_webhook_url: (req.body.teams_webhook_url || '').trim(),
  };

  if (req.session.userRole === 'moderator') {
    return queueAction(req, res, 'settings_update', updates,
      'Update notification settings', '/admin/settings');
  }

  const stmt = db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  );
  for (const [k, v] of Object.entries(updates)) stmt.run(k, v);
  res.redirect('/admin/settings?flash=Settings+saved');
});

// --- SMTP Check ---
function smtpConfig() {
  return {
    host: process.env.SMTP_HOST || null,
    port: process.env.SMTP_PORT || '587',
    user: process.env.SMTP_USER || null,
    from: process.env.SMTP_FROM || process.env.SMTP_USER || null,
    secure: process.env.SMTP_SECURE === 'true',
    configured: !!process.env.SMTP_HOST && !!process.env.SMTP_USER,
  };
}

router.get('/smtp-check', (req, res) => {
  res.render('admin/smtp-check', { config: smtpConfig(), result: null, lastTo: '' });
});

router.post('/smtp-check', async (req, res) => {
  const to = (req.body.to || '').trim();
  if (!to || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
    return res.render('admin/smtp-check', {
      config: smtpConfig(), lastTo: to,
      result: { ok: false, error: 'Enter a valid email address.' },
    });
  }
  const result = await notifier.sendTestEmail(to);
  res.render('admin/smtp-check', { config: smtpConfig(), result, lastTo: to });
});

const adminOnly = (req, res, next) =>
  req.session.userRole === 'admin' ? next()
    : res.redirect('/admin/settings?flash=' + encodeURIComponent('Only admins can send test messages'));

router.post('/settings/test-email', adminOnly, async (req, res) => {
  const r = await notifier.sendTestEmail();
  const flash = r.ok ? 'Test+email+sent' : ('Email+failed:+' + encodeURIComponent(r.error));
  res.redirect('/admin/settings?flash=' + flash);
});

router.post('/settings/test-whatsapp', adminOnly, async (req, res) => {
  const r = await notifier.sendTestWhatsApp();
  const flash = r.ok ? 'Test+WhatsApp+sent' : ('WhatsApp+failed:+' + encodeURIComponent(r.error));
  res.redirect('/admin/settings?flash=' + flash);
});


router.post('/settings/test-teams', adminOnly, async (req, res) => {
  const r = await notifier.sendTestTeams();
  const flash = r.ok ? 'Test+Teams+message+sent' : ('Teams+failed:+' + encodeURIComponent(r.error || ''));
  res.redirect('/admin/settings?flash=' + flash);
});

// --- Notification log ---
router.get('/notification-log', (req, res) => {
  const logs = db.prepare(`
    SELECT nl.*, s.name AS site_name
    FROM notification_log nl
    LEFT JOIN sites s ON s.id = nl.site_id
    ORDER BY nl.id DESC LIMIT 200
  `).all();
  // Compute cooldown status per site+channel so admin can see what's blocked
  const cooldowns = db.prepare(`
    SELECT site_id, channel, MAX(sent_at) AS last_ok_at
    FROM notification_log WHERE status = 'ok'
    GROUP BY site_id, channel
  `).all().map(r => ({
    ...r,
    blocked: ((Date.now() - new Date(r.last_ok_at + 'Z').getTime()) / 60000) < (parseInt(process.env.ALERT_COOLDOWN_MINUTES || '60', 10)),
    minutesAgo: Math.round((Date.now() - new Date(r.last_ok_at + 'Z').getTime()) / 60000),
  }));
  res.render('admin/notification-log', { logs, cooldowns, flash: req.query.flash || null });
});

// --- Account / Change password + email ---
router.get('/account', (req, res) => {
  res.render('admin/account', { error: null, flash: req.query.flash || null });
});

router.post('/account/email', (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId);
  if (!user) return res.redirect('/login');
  const newEmail = (req.body.email || '').trim().toLowerCase();
  const currentPassword = req.body.current_password || '';
  if (!newEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(newEmail)) {
    return res.status(400).render('admin/account', { error: 'Invalid email address', flash: null });
  }
  if (!bcrypt.compareSync(currentPassword, user.password_hash)) {
    return res.status(400).render('admin/account', { error: 'Current password is incorrect', flash: null });
  }
  try {
    db.prepare('UPDATE users SET email = ? WHERE id = ?').run(newEmail, user.id);
    req.session.userEmail = newEmail;
    res.redirect('/admin/account?flash=Email+updated');
  } catch (err) {
    res.status(400).render('admin/account', { error: 'That email address is already in use', flash: null });
  }
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

// --- User management (admin only) ---
router.get('/users', requireAdmin, (req, res) => {
  const users = db.prepare('SELECT id, email, role, created_at FROM users ORDER BY role DESC, email').all();
  res.render('admin/users', { users, flash: req.query.flash || null, error: null });
});

router.post('/users/new', requireAdmin, (req, res) => {
  const email = (req.body.email || '').trim().toLowerCase();
  const password = req.body.password || '';
  const role = req.body.role === 'admin' ? 'admin' : 'moderator';

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    const users = db.prepare('SELECT id, email, role, created_at FROM users ORDER BY role DESC, email').all();
    return res.status(400).render('admin/users', { users, flash: null, error: 'Invalid email address' });
  }
  if (!password || password.length < 8) {
    const users = db.prepare('SELECT id, email, role, created_at FROM users ORDER BY role DESC, email').all();
    return res.status(400).render('admin/users', { users, flash: null, error: 'Password must be at least 8 characters' });
  }
  try {
    const hash = bcrypt.hashSync(password, 10);
    db.prepare('INSERT INTO users (email, password_hash, role) VALUES (?, ?, ?)').run(email, hash, role);
    res.redirect('/admin/users?flash=' + encodeURIComponent(`User ${email} added as ${role}`));
  } catch (err) {
    const users = db.prepare('SELECT id, email, role, created_at FROM users ORDER BY role DESC, email').all();
    res.status(400).render('admin/users', { users, flash: null, error: 'That email address is already in use' });
  }
});

router.post('/users/:id/delete', requireAdmin, (req, res) => {
  if (parseInt(req.params.id, 10) === req.session.userId) {
    return res.redirect('/admin/users?flash=Cannot+delete+your+own+account');
  }
  db.prepare('DELETE FROM users WHERE id = ?').run(req.params.id);
  res.redirect('/admin/users?flash=User+removed');
});

// --- Pending actions (admin only) ---
router.get('/pending', requireAdmin, (req, res) => {
  const filter = req.query.filter || 'pending';
  const validFilters = ['pending', 'approved', 'rejected', 'all'];
  const f = validFilters.includes(filter) ? filter : 'pending';
  const where = f === 'all' ? '' : 'WHERE status = ?';
  const params = f === 'all' ? [] : [f];
  const actions = db.prepare(`
    SELECT * FROM pending_actions ${where} ORDER BY created_at DESC LIMIT 200
  `).all(...params);
  const counts = db.prepare(`
    SELECT status, COUNT(*) AS c FROM pending_actions GROUP BY status
  `).all().reduce((acc, r) => { acc[r.status] = r.c; return acc; }, { pending: 0, approved: 0, rejected: 0 });
  res.render('admin/pending', { actions, counts, currentFilter: f, flash: req.query.flash || null });
});

router.post('/pending/:id/approve', requireAdmin, async (req, res) => {
  const action = db.prepare('SELECT * FROM pending_actions WHERE id = ?').get(req.params.id);
  if (!action || action.status !== 'pending') return res.redirect('/admin/pending?flash=Action+not+found+or+already+reviewed');

  const data = JSON.parse(action.action_data);
  try {
    switch (action.action_type) {
      case 'check_all': {
        const allSites = db.prepare('SELECT * FROM sites WHERE enabled = 1').all();
        for (const s of allSites) {
          try {
            const r = await monitor.checkSite(s);
            monitor.recordCheck(r);
          } catch (_) {}
        }
        break;
      }

      case 'site_bulk_add': {
        const bulkInsert = db.prepare(`
          INSERT INTO sites (name, url, enabled, expected_status, notify_on_down,
                             response_time_warn_ms, response_time_crit_ms, ssl_warn_days)
          VALUES (?, ?, 1, 200, 1, 800, 2500, 30)
        `);
        db.transaction((rows) => rows.forEach((r) => bulkInsert.run(r.name, r.url)))(data.sites);
        break;
      }

      case 'site_add':
        db.prepare(`
          INSERT INTO sites (name, url, enabled, expected_status, expected_keyword, notify_on_down,
                             response_time_warn_ms, response_time_crit_ms, ssl_warn_days, parent_id)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(data.name, data.url, data.enabled, data.expected_status, data.expected_keyword,
               data.notify_on_down, data.response_time_warn_ms, data.response_time_crit_ms,
               data.ssl_warn_days, data.parent_id ?? null);
        break;

      case 'site_edit':
        db.prepare(`
          UPDATE sites SET name=?, url=?, enabled=?, expected_status=?, expected_keyword=?,
                           notify_on_down=?, response_time_warn_ms=?, response_time_crit_ms=?,
                           ssl_warn_days=?, parent_id=?
          WHERE id=?
        `).run(data.name, data.url, data.enabled, data.expected_status, data.expected_keyword,
               data.notify_on_down, data.response_time_warn_ms, data.response_time_crit_ms,
               data.ssl_warn_days, data.parent_id ?? null, data.siteId);
        break;

      case 'site_delete':
        db.prepare('DELETE FROM sites WHERE id = ?').run(data.siteId);
        break;

      case 'site_bulk_delete':
        db.prepare(`DELETE FROM sites WHERE id IN (${data.ids.map(() => '?').join(',')})`).run(...data.ids);
        break;

      case 'site_check': {
        const site = db.prepare('SELECT * FROM sites WHERE id = ?').get(data.siteId);
        if (site) {
          const result = await monitor.checkSite(site);
          monitor.recordCheck(result);
        }
        break;
      }

      case 'settings_update': {
        const stmt = db.prepare(
          'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
        );
        for (const [k, v] of Object.entries(data)) stmt.run(k, v);
        break;
      }

      case 'report_status':
        if (data.status === 'resolved') {
          db.prepare('UPDATE reports SET status=?, resolved_at=CURRENT_TIMESTAMP WHERE id=?').run(data.status, data.reportId);
        } else {
          db.prepare('UPDATE reports SET status=?, resolved_at=NULL WHERE id=?').run(data.status, data.reportId);
        }
        break;

      case 'report_delete':
        db.prepare('DELETE FROM reports WHERE id = ?').run(data.reportId);
        break;

      default:
        throw new Error(`Unknown action type: ${action.action_type}`);
    }

    db.prepare('UPDATE pending_actions SET status=?, reviewed_at=CURRENT_TIMESTAMP WHERE id=?')
      .run('approved', action.id);
    notifier.sendActionResultNotification(action.user_email, action.description, true).catch(() => {});
    res.redirect('/admin/pending?flash=Action+approved+and+executed');
  } catch (err) {
    db.prepare('UPDATE pending_actions SET status=?, reviewed_at=CURRENT_TIMESTAMP, review_note=? WHERE id=?')
      .run('rejected', 'Execution error: ' + err.message, action.id);
    res.redirect('/admin/pending?flash=' + encodeURIComponent('Approval failed: ' + err.message));
  }
});

router.post('/pending/:id/reject', requireAdmin, (req, res) => {
  const action = db.prepare('SELECT * FROM pending_actions WHERE id = ?').get(req.params.id);
  if (!action || action.status !== 'pending') return res.redirect('/admin/pending?flash=Action+not+found+or+already+reviewed');
  const note = (req.body.note || '').trim() || 'Rejected by admin';
  db.prepare('UPDATE pending_actions SET status=?, reviewed_at=CURRENT_TIMESTAMP, review_note=? WHERE id=?')
    .run('rejected', note, action.id);
  notifier.sendActionResultNotification(action.user_email, action.description, false, note).catch(() => {});
  res.redirect('/admin/pending?flash=Action+rejected');
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

// --- Geographic response times ---
router.get('/geo', (req, res) => {
  const sites = db.prepare(
    'SELECT * FROM sites WHERE enabled = 1 AND parent_id IS NULL ORDER BY sort_order ASC, name ASC'
  ).all();

  // Latest geo check per (site, location)
  const latestRows = db.prepare(`
    SELECT g.*
    FROM geo_checks g
    WHERE g.id IN (
      SELECT MAX(id) FROM geo_checks GROUP BY site_id, location_key
    )
  `).all();

  // 24h average per (site, location)
  const avgRows = db.prepare(`
    SELECT site_id, location_key,
           AVG(response_time_ms) AS avg_ms,
           COUNT(*) AS samples
    FROM geo_checks
    WHERE checked_at >= datetime('now', '-1 day') AND response_time_ms IS NOT NULL
    GROUP BY site_id, location_key
  `).all();

  // Build lookup maps keyed by siteId -> locationKey -> data
  const latestByKey = {};
  for (const r of latestRows) {
    if (!latestByKey[r.site_id]) latestByKey[r.site_id] = {};
    latestByKey[r.site_id][r.location_key] = r;
  }
  const avgByKey = {};
  for (const r of avgRows) {
    if (!avgByKey[r.site_id]) avgByKey[r.site_id] = {};
    avgByKey[r.site_id][r.location_key] = r;
  }

  const lastSweepRow = db.prepare(
    'SELECT MAX(checked_at) AS ts FROM geo_checks'
  ).get();
  const lastSweepAt = lastSweepRow?.ts || null;

  res.render('admin/geo', {
    sites, locations: LOCATIONS,
    latestByKey, avgByKey, lastSweepAt,
    flash: req.query.flash || null,
  });
});

router.post('/geo/run', requireAdmin, (req, res) => {
  // Fire-and-forget; the sweep takes ~15 s per site so we redirect immediately.
  runGeoSweep().catch((err) => console.error('[geo] Manual sweep error:', err));
  res.redirect('/admin/geo?flash=' + encodeURIComponent('Geo sweep started — results will appear in ~1–2 minutes'));
});

// --- Technology / CMS scanner ---
const cmsUpsert = db.prepare(`
  INSERT INTO cms_scans
    (site_id, scanned_at, cms, cms_version, theme, theme_version,
     plugins, technologies, server, powered_by, generator, cdn, language,
     scan_status, error_message)
  VALUES (?, CURRENT_TIMESTAMP, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(site_id) DO UPDATE SET
    scanned_at    = excluded.scanned_at,
    cms           = excluded.cms,
    cms_version   = excluded.cms_version,
    theme         = excluded.theme,
    theme_version = excluded.theme_version,
    plugins       = excluded.plugins,
    technologies  = excluded.technologies,
    server        = excluded.server,
    powered_by    = excluded.powered_by,
    generator     = excluded.generator,
    cdn           = excluded.cdn,
    language      = excluded.language,
    scan_status   = excluded.scan_status,
    error_message = excluded.error_message
`);

function saveCmsScan(r) {
  cmsUpsert.run(
    r.site_id, r.cms, r.cms_version, r.theme, r.theme_version,
    r.plugins, r.technologies, r.server, r.powered_by, r.generator,
    r.cdn, r.language, r.scan_status, r.error_message
  );
}

router.get('/cms', (req, res) => {
  const sites = db.prepare('SELECT * FROM sites ORDER BY sort_order ASC, name ASC').all();
  const scans = db.prepare('SELECT * FROM cms_scans').all();
  const scanMap = new Map(scans.map((s) => [s.site_id, s]));

  const rows = sites.map((s) => {
    const scan = scanMap.get(s.id) || {};
    return { site_id: s.id, site_name: s.name, site_url: s.url, ...scan };
  });

  const stats = {
    total:   sites.length,
    scanned: scans.filter((s) => s.scan_status === 'ok' || s.scan_status === 'error').length,
    wp:      scans.filter((s) => s.cms === 'WordPress').length,
    other:   scans.filter((s) => s.cms && s.cms !== 'WordPress').length,
    unknown: scans.filter((s) => s.scan_status === 'ok' && !s.cms).length,
    errors:  scans.filter((s) => s.scan_status === 'error').length,
  };

  const scanning = scans.filter((s) => s.scan_status === 'scanning').length;

  res.render('admin/cms', { rows, stats, scanning, flash: req.query.flash || null });
});

router.post('/cms/scan/:id', async (req, res) => {
  const site = db.prepare('SELECT * FROM sites WHERE id = ?').get(req.params.id);
  if (!site) return res.redirect('/admin/cms?flash=' + encodeURIComponent('Site not found'));

  // Mark as scanning immediately so the UI shows feedback.
  cmsUpsert.run(
    site.id, null, null, null, null, '[]', '[]', null, null, null, null, null, 'scanning', null
  );

  // Fire-and-forget.
  (async () => {
    try {
      const result = await scanAndFormat(site);
      saveCmsScan(result);
      console.log(`[cms] Scanned ${site.name}: ${result.cms || 'unknown'}`);
    } catch (err) {
      console.error(`[cms] Scan error for ${site.name}: ${err.message}`);
      cmsUpsert.run(site.id, null, null, null, null, '[]', '[]', null, null, null, null, null, 'error', err.message);
    }
  })();

  res.redirect('/admin/cms?flash=' + encodeURIComponent(`Scanning ${site.name}… refresh in a few seconds`));
});

router.post('/cms/scan-all', async (req, res) => {
  const sites = db.prepare('SELECT * FROM sites WHERE enabled = 1 AND parent_id IS NULL').all();

  // Mark all as scanning.
  for (const s of sites) {
    cmsUpsert.run(s.id, null, null, null, null, '[]', '[]', null, null, null, null, null, 'scanning', null);
  }

  // Scan sequentially in the background (avoids hammering targets in parallel).
  (async () => {
    for (const site of sites) {
      try {
        const result = await scanAndFormat(site);
        saveCmsScan(result);
        console.log(`[cms] Scanned ${site.name}: ${result.cms || 'unknown'}`);
      } catch (err) {
        console.error(`[cms] Scan error for ${site.name}: ${err.message}`);
        cmsUpsert.run(site.id, null, null, null, null, '[]', '[]', null, null, null, null, null, 'error', err.message);
      }
    }
    console.log('[cms] Scan-all complete');
  })();

  res.redirect('/admin/cms?flash=' + encodeURIComponent(`Scanning ${sites.length} sites in the background — refresh to see results`));
});

// --- Visitors (admin only) ---
router.get('/visitors', requireAdmin, (req, res) => {
  const windowMap = { '24h': '-1 day', '7d': '-7 days', '30d': '-30 days', all: null };
  const win = windowMap[req.query.window] !== undefined ? req.query.window : '7d';
  const winSql = windowMap[win];
  const vpnFilter = ['yes', 'no'].includes(req.query.vpn) ? req.query.vpn : '';
  const countryFilter = (req.query.country || '').trim();

  const where = [];
  const params = [];
  if (winSql)              { where.push(`visited_at >= datetime('now', '${winSql}')`); }
  if (vpnFilter === 'yes') { where.push('(is_proxy = 1 OR is_hosting = 1)'); }
  if (vpnFilter === 'no')  { where.push('is_proxy = 0 AND is_hosting = 0'); }
  if (countryFilter)       { where.push('country LIKE ?'); params.push(`%${countryFilter}%`); }

  const whereClause = where.length ? 'WHERE ' + where.join(' AND ') : '';

  const visitors = db.prepare(
    `SELECT * FROM visitors ${whereClause} ORDER BY id DESC LIMIT 500`
  ).all(...params);

  // Stats (always today / this week regardless of filter)
  const stats = {
    today:        db.prepare("SELECT COUNT(*) AS c FROM visitors WHERE visited_at >= datetime('now','-1 day')").get().c,
    uniqueIpsToday: db.prepare("SELECT COUNT(DISTINCT ip) AS c FROM visitors WHERE visited_at >= datetime('now','-1 day')").get().c,
    week:         db.prepare("SELECT COUNT(*) AS c FROM visitors WHERE visited_at >= datetime('now','-7 days')").get().c,
    countries:    db.prepare("SELECT COUNT(DISTINCT country_code) AS c FROM visitors WHERE country_code IS NOT NULL").get().c,
    vpn:          db.prepare("SELECT COUNT(*) AS c FROM visitors WHERE (is_proxy=1 OR is_hosting=1) AND visited_at >= datetime('now','-7 days')").get().c,
  };

  // Build map points: group by rounded lat/lon, keep first city/country/isp per group.
  const mapWhere = winSql ? `WHERE lat IS NOT NULL AND lon IS NOT NULL AND visited_at >= datetime('now','${winSql}')` : 'WHERE lat IS NOT NULL AND lon IS NOT NULL';
  const geoRows = db.prepare(`SELECT lat, lon, city, country, isp, org, is_proxy, is_hosting FROM visitors ${mapWhere}`).all();
  const grouped = new Map();
  for (const r of geoRows) {
    const key = `${r.lat.toFixed(2)},${r.lon.toFixed(2)}`;
    if (!grouped.has(key)) {
      grouped.set(key, { lat: r.lat, lon: r.lon, city: r.city, country: r.country, isp: r.isp || r.org, isVpn: false, count: 0 });
    }
    const g = grouped.get(key);
    g.count++;
    if (r.is_proxy || r.is_hosting) g.isVpn = true;
  }
  const mapPoints = Array.from(grouped.values());

  res.render('admin/visitors', {
    visitors, stats, mapPoints,
    window: win, vpnFilter, countryFilter,
    flash: req.query.flash || null,
  });
});

// --- Login log (admin only) ---
router.get('/login-log', requireAdmin, (req, res) => {
  const windowMap = { '7d': '-7 days', '30d': '-30 days', all: null };
  const win = windowMap[req.query.window] !== undefined ? req.query.window : '7d';
  const winSql = windowMap[win];
  const roleFilter = ['admin', 'moderator'].includes(req.query.role) ? req.query.role : '';

  const where = [];
  const params = [];
  if (winSql)    { where.push(`logged_in_at >= datetime('now', '${winSql}')`); }
  if (roleFilter){ where.push('user_role = ?'); params.push(roleFilter); }
  const whereClause = where.length ? 'WHERE ' + where.join(' AND ') : '';

  const logins = db.prepare(
    `SELECT * FROM user_logins ${whereClause} ORDER BY id DESC LIMIT 500`
  ).all(...params);

  res.render('admin/login-log', { logins, window: win, roleFilter });
});

// --- App logs ---
router.get('/logs', requireAdmin, (req, res) => {
  const limit = Math.min(parseInt(req.query.lines || '500', 10), 2000);
  const filter = (req.query.filter || '').toUpperCase(); // INFO | WARN | ERROR | HTTP | ''
  let lines = [];
  try {
    const raw = fs.readFileSync(LOG_PATH, 'utf8');
    const all = raw.trim().split('\n');
    const filtered = filter ? all.filter((l) => l.includes(`[${filter}]`)) : all;
    lines = filtered.slice(-limit).reverse();
  } catch (_) {}
  res.render('admin/logs', { lines, limit, filter: req.query.filter || '', flash: req.query.flash });
});

router.post('/logs/clear', requireAdmin, (req, res) => {
  try { fs.writeFileSync(LOG_PATH, ''); } catch (_) {}
  res.redirect('/admin/logs?flash=Log+cleared');
});

module.exports = router;
