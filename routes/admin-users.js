const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db/database');
const { requireAdmin } = require('../middleware/auth');
const monitor = require('../lib/monitor');
const notifier = require('../lib/notifier');
const queueAction = require('../lib/admin-queue');
const router = express.Router();

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

module.exports = router;
