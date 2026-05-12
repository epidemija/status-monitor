const express = require('express');
const fs = require('fs');
const db = require('../db/database');
const { requireAdmin } = require('../middleware/auth');
const { scanAndFormat } = require('../lib/cms');
const { LOG_PATH } = require('../lib/logger');
const queueAction = require('../lib/admin-queue');
const router = express.Router();

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

module.exports = router;
