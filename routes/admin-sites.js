const express = require('express');
const db = require('../db/database');
const { requireAdmin } = require('../middleware/auth');
const monitor = require('../lib/monitor');
const queueAction = require('../lib/admin-queue');
const router = express.Router();

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

module.exports = router;
