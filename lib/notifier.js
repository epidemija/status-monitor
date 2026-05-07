// Notification system: Email (SMTP) + WhatsApp (Twilio API).
// Both are optional and disabled by default. Enable & configure recipients
// from /admin/settings (or the settings table); credentials come from .env.
//
// Built-in cooldown: we never re-alert about the same site/channel more than
// once within ALERT_COOLDOWN_MINUTES.

const nodemailer = require('nodemailer');
const axios = require('axios');
const db = require('../db/database');

const COOLDOWN_MIN = parseInt(process.env.ALERT_COOLDOWN_MINUTES || '60', 10);

function getSetting(key, fallback = '') {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

function isEmailEnabled() {
  return getSetting('email_enabled') === '1' &&
         !!process.env.SMTP_HOST && !!process.env.SMTP_USER;
}

function isWhatsAppEnabled() {
  return getSetting('whatsapp_enabled') === '1' &&
         !!process.env.TWILIO_ACCOUNT_SID &&
         !!process.env.TWILIO_AUTH_TOKEN &&
         !!process.env.TWILIO_WHATSAPP_FROM;
}

function withinCooldown(siteId, channel) {
  const row = db.prepare(`
    SELECT sent_at FROM notification_log
    WHERE site_id = ? AND channel = ? AND status = 'ok'
    ORDER BY id DESC LIMIT 1
  `).get(siteId, channel);
  if (!row) return false;
  const ageMin = (Date.now() - new Date(row.sent_at + 'Z').getTime()) / 60000;
  return ageMin < COOLDOWN_MIN;
}

function logNotification(siteId, channel, recipient, status, errorMessage = null) {
  db.prepare(`
    INSERT INTO notification_log (site_id, channel, recipient, status, error_message)
    VALUES (?, ?, ?, ?, ?)
  `).run(siteId, channel, recipient, status, errorMessage);
}

// ----- Email transport -----
let _transporter = null;
function getTransporter() {
  if (!_transporter && process.env.SMTP_HOST) {
    _transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: parseInt(process.env.SMTP_PORT || '587', 10),
      secure: process.env.SMTP_SECURE === 'true',
      auth: process.env.SMTP_USER ? {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      } : undefined,
    });
  }
  return _transporter;
}

async function sendEmail(subject, body) {
  if (!isEmailEnabled()) return { skipped: true, reason: 'email disabled' };
  const recipients = (getSetting('email_recipients') || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
  if (recipients.length === 0) return { skipped: true, reason: 'no recipients' };

  const transporter = getTransporter();
  const from = process.env.SMTP_FROM || process.env.SMTP_USER;
  const results = [];
  for (const to of recipients) {
    try {
      await transporter.sendMail({ from, to, subject, text: body });
      results.push({ to, ok: true });
    } catch (err) {
      results.push({ to, ok: false, error: err.message });
    }
  }
  return { results };
}

// ----- WhatsApp via Twilio -----
async function sendWhatsApp(message) {
  if (!isWhatsAppEnabled()) return { skipped: true, reason: 'whatsapp disabled' };
  const recipients = (getSetting('whatsapp_recipients') || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
  if (recipients.length === 0) return { skipped: true, reason: 'no recipients' };

  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_WHATSAPP_FROM; // e.g. whatsapp:+14155238886
  const url = `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`;

  const results = [];
  for (let to of recipients) {
    if (!to.startsWith('whatsapp:')) to = `whatsapp:${to}`;
    try {
      const params = new URLSearchParams({ From: from, To: to, Body: message });
      await axios.post(url, params, {
        auth: { username: sid, password: token },
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: 15000,
      });
      results.push({ to, ok: true });
    } catch (err) {
      const detail = err.response?.data?.message || err.message;
      results.push({ to, ok: false, error: detail });
    }
  }
  return { results };
}

// ----- High-level alert builders -----
function buildDownMessage(site, result) {
  const lines = [
    `🔴 DOWN: ${site.name}`,
    `URL: ${site.url}`,
    `Time: ${new Date().toISOString()}`,
  ];
  if (result.status_code) lines.push(`Status code: ${result.status_code}`);
  if (result.response_time_ms) lines.push(`Response time: ${result.response_time_ms} ms`);
  if (result.error_message) lines.push(`Error: ${result.error_message}`);
  return lines.join('\n');
}

function buildUpMessage(site) {
  return `🟢 RECOVERED: ${site.name}\nURL: ${site.url}\nTime: ${new Date().toISOString()}`;
}

async function sendDownAlert(site, result) {
  const subject = `[Status] DOWN: ${site.name}`;
  const body = buildDownMessage(site, result);

  if (isEmailEnabled() && !withinCooldown(site.id, 'email')) {
    const out = await sendEmail(subject, body);
    if (out.results) {
      for (const r of out.results) {
        logNotification(site.id, 'email', r.to, r.ok ? 'ok' : 'error', r.error);
      }
    }
  }
  if (isWhatsAppEnabled() && !withinCooldown(site.id, 'whatsapp')) {
    const out = await sendWhatsApp(body);
    if (out.results) {
      for (const r of out.results) {
        logNotification(site.id, 'whatsapp', r.to, r.ok ? 'ok' : 'error', r.error);
      }
    }
  }
}

async function sendSslWarning(site, result, thresholdDays) {
  const subject = `[Status] SSL expires in ≤${thresholdDays} day(s): ${site.name}`;
  const body = [
    `⚠️ SSL CERTIFICATE EXPIRING: ${site.name}`,
    `URL: ${site.url}`,
    `Days remaining: ${result.ssl_days_remaining}`,
    `Issuer: ${result.ssl_issuer || 'unknown'}`,
    `Expires: ${result.ssl_expires_at}`,
    '',
    'Renew the certificate to avoid an outage.',
  ].join('\n');

  if (isEmailEnabled()) {
    const out = await sendEmail(subject, body);
    if (out.results) {
      for (const r of out.results) {
        logNotification(site.id, 'email-ssl', r.to, r.ok ? 'ok' : 'error', r.error);
      }
    }
  }
  if (isWhatsAppEnabled()) {
    const out = await sendWhatsApp(body);
    if (out.results) {
      for (const r of out.results) {
        logNotification(site.id, 'whatsapp-ssl', r.to, r.ok ? 'ok' : 'error', r.error);
      }
    }
  }
}

async function sendBugReportNotification(report, site) {
  if (getSetting('notify_on_report') !== '1') return;
  const subject = `[Status] New report${site ? ': ' + site.name : ''}`;
  const lines = [
    'A user submitted a problem report.',
    '',
    site ? `Site: ${site.name} (${site.url})` : 'Site: (not specified)',
    `Severity: ${report.severity}`,
    `From: ${report.reporter_name || '(anonymous)'} ${report.reporter_email ? '<' + report.reporter_email + '>' : ''}`,
    report.page_url ? `Page: ${report.page_url}` : '',
    '',
    'Description:',
    report.description,
    '',
    'Open the admin panel → Reports to manage this.',
  ].filter(Boolean).join('\n');
  if (isEmailEnabled()) {
    const out = await sendEmail(subject, lines);
    if (out.results) {
      for (const r of out.results) {
        logNotification(site ? site.id : 0, 'email-report', r.to, r.ok ? 'ok' : 'error', r.error);
      }
    }
  }
}

async function sendUpAlert(site) {
  const subject = `[Status] RECOVERED: ${site.name}`;
  const body = buildUpMessage(site);
  if (isEmailEnabled()) {
    const out = await sendEmail(subject, body);
    if (out.results) {
      for (const r of out.results) {
        logNotification(site.id, 'email', r.to, r.ok ? 'ok' : 'error', r.error);
      }
    }
  }
  if (isWhatsAppEnabled()) {
    const out = await sendWhatsApp(body);
    if (out.results) {
      for (const r of out.results) {
        logNotification(site.id, 'whatsapp', r.to, r.ok ? 'ok' : 'error', r.error);
      }
    }
  }
}

async function sendTestEmail(toOverride) {
  const recipients = toOverride
    ? [toOverride]
    : (getSetting('email_recipients') || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!process.env.SMTP_HOST) return { ok: false, error: 'SMTP not configured in .env' };
  if (recipients.length === 0) return { ok: false, error: 'No recipients configured' };
  const transporter = getTransporter();
  try {
    for (const to of recipients) {
      await transporter.sendMail({
        from: process.env.SMTP_FROM || process.env.SMTP_USER,
        to,
        subject: '[Status Monitor] Test email',
        text: 'This is a test message from your Status Monitor.',
      });
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function sendTestWhatsApp(toOverride) {
  const recipients = toOverride
    ? [toOverride]
    : (getSetting('whatsapp_recipients') || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!process.env.TWILIO_ACCOUNT_SID) return { ok: false, error: 'Twilio not configured in .env' };
  if (recipients.length === 0) return { ok: false, error: 'No recipients configured' };
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_WHATSAPP_FROM;
  const url = `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`;
  try {
    for (let to of recipients) {
      if (!to.startsWith('whatsapp:')) to = `whatsapp:${to}`;
      const params = new URLSearchParams({
        From: from, To: to, Body: 'Test message from Status Monitor',
      });
      await axios.post(url, params, {
        auth: { username: sid, password: token },
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: 15000,
      });
    }
    return { ok: true };
  } catch (err) {
    const detail = err.response?.data?.message || err.message;
    return { ok: false, error: detail };
  }
}

module.exports = {
  sendDownAlert,
  sendUpAlert,
  sendSslWarning,
  sendBugReportNotification,
  sendTestEmail,
  sendTestWhatsApp,
  isEmailEnabled,
  isWhatsAppEnabled,
};
