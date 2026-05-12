const express = require('express');
const db = require('../db/database');
const { requireAdmin } = require('../middleware/auth');
const notifier = require('../lib/notifier');
const queueAction = require('../lib/admin-queue');
const router = express.Router();

const adminOnly = (req, res, next) =>
  req.session.userRole === 'admin' ? next()
    : res.redirect('/admin/settings?flash=' + encodeURIComponent('Only admins can send test messages'));

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
    slack_enabled: req.body.slack_enabled === 'on' ? '1' : '0',
    slack_webhook_url: (req.body.slack_webhook_url || '').trim(),
    discord_enabled: req.body.discord_enabled === 'on' ? '1' : '0',
    discord_webhook_url: (req.body.discord_webhook_url || '').trim(),
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

router.post('/settings/test-slack', adminOnly, async (req, res) => {
  const r = await notifier.sendTestSlack();
  const flash = r.ok ? 'Test+Slack+message+sent' : ('Slack+failed:+' + encodeURIComponent(r.error || ''));
  res.redirect('/admin/settings?flash=' + flash);
});

router.post('/settings/test-discord', adminOnly, async (req, res) => {
  const r = await notifier.sendTestDiscord();
  const flash = r.ok ? 'Test+Discord+message+sent' : ('Discord+failed:+' + encodeURIComponent(r.error || ''));
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

module.exports = router;
