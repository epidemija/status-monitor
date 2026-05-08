// Notification system: Email (SMTP) + WhatsApp (Twilio) + Microsoft Teams webhook.
// All channels are optional and disabled by default. Enable & configure recipients
// from /admin/settings; SMTP/Twilio credentials come from .env.
//
// Built-in cooldown: for ongoing outages each channel fires at most once per
// ALERT_COOLDOWN_MINUTES (default 60). First-open and recovery alerts always fire.

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

function isTeamsEnabled() {
  return getSetting('teams_enabled') === '1' && !!getSetting('teams_webhook_url');
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
  if (!isEmailEnabled()) {
    console.log('[notifier] email skipped: disabled or SMTP not configured');
    return { skipped: true, reason: 'email disabled' };
  }
  const recipients = (getSetting('email_recipients') || '')
    .split(/[,;\n\r]+/).map((s) => s.trim()).filter(Boolean);
  if (recipients.length === 0) {
    console.log('[notifier] email skipped: no recipients configured');
    return { skipped: true, reason: 'no recipients' };
  }

  const transporter = getTransporter();
  const from = process.env.SMTP_FROM || process.env.SMTP_USER;
  const results = [];
  for (const to of recipients) {
    try {
      await transporter.sendMail({ from, to, subject, text: body });
      console.log(`[notifier] email sent to ${to}`);
      results.push({ to, ok: true });
    } catch (err) {
      console.error(`[notifier] email FAILED to ${to}:`, err.message);
      results.push({ to, ok: false, error: err.message });
    }
  }
  return { results };
}

// ----- WhatsApp via Twilio -----
async function sendWhatsApp(message) {
  if (!isWhatsAppEnabled()) {
    console.log('[notifier] whatsapp skipped: disabled or Twilio not configured');
    return { skipped: true, reason: 'whatsapp disabled' };
  }
  const recipients = (getSetting('whatsapp_recipients') || '')
    .split(/[,;\n\r]+/).map((s) => s.trim()).filter(Boolean);
  if (recipients.length === 0) {
    console.log('[notifier] whatsapp skipped: no recipients configured');
    return { skipped: true, reason: 'no recipients' };
  }

  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_WHATSAPP_FROM;
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
      console.log(`[notifier] whatsapp sent to ${to}`);
      results.push({ to, ok: true });
    } catch (err) {
      const detail = err.response?.data?.message || err.message;
      console.error(`[notifier] whatsapp FAILED to ${to}:`, detail);
      results.push({ to, ok: false, error: detail });
    }
  }
  return { results };
}

// ----- Microsoft Teams via Incoming Webhook -----
// Uses Adaptive Cards format — MessageCard (@type: "MessageCard") was retired by Microsoft
// in 2024 and now arrives empty. Adaptive Cards work with both old connector webhook URLs
// (webhook.office.com) and new Workflow webhook URLs.
async function sendTeamsCard(title, body, themeColor = '0969DA') {
  const webhookUrl = getSetting('teams_webhook_url');
  if (!webhookUrl) return { ok: false, error: 'No webhook URL configured' };

  const colorMap = { 'CF222E': 'Attention', '2DA44E': 'Good', 'B08800': 'Warning' };
  const titleColor = colorMap[themeColor] || 'Default';

  const payload = {
    type: 'message',
    attachments: [{
      contentType: 'application/vnd.microsoft.card.adaptive',
      contentUrl: null,
      content: {
        $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
        type: 'AdaptiveCard',
        version: '1.2',
        body: [
          { type: 'TextBlock', text: title, weight: 'Bolder', size: 'Medium', color: titleColor, wrap: true },
          { type: 'TextBlock', text: body, wrap: true, spacing: 'Medium' },
        ],
      },
    }],
  };

  try {
    await axios.post(webhookUrl, payload, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 10000,
    });
    return { ok: true };
  } catch (err) {
    const detail = err.response?.data || err.message;
    return { ok: false, error: typeof detail === 'string' ? detail : JSON.stringify(detail).slice(0, 200) };
  }
}

async function sendTestTeams() {
  const webhookUrl = getSetting('teams_webhook_url');
  if (!webhookUrl) return { ok: false, error: 'No Teams webhook URL configured in Settings' };
  const body = [
    '✅ Teams notifications are configured correctly.',
    '',
    'You will receive messages here when:',
    '• A monitored website goes **DOWN**',
    '• A website **recovers**',
    '• An SSL certificate is about to expire',
    '',
    `Sent at: ${new Date().toISOString()}`,
  ].join('\n');
  return sendTeamsCard('🔵 Test — Status Monitor', body, '0969DA');
}

// ----- WhatsApp all-sites test -----
async function sendTestWhatsAppAll(summaries) {
  const lines = ['🧪 *[TEST] Status Monitor — Full Site Check*', ''];
  for (const { site, last } of summaries) {
    const icon = last ? (last.is_up ? '✅' : '❌') : '⬜';
    const detail = last
      ? (last.is_up
          ? `UP · ${last.response_time_ms != null ? last.response_time_ms + 'ms' : '—'}`
          : `DOWN${last.status_code ? ' · ' + last.status_code : ''}${last.error_message ? ' — ' + last.error_message.slice(0, 50) : ''}`)
      : 'No data';
    lines.push(`${icon} *${site.name}*  ${detail}`);
  }
  lines.push('');
  lines.push('_This is a test message. No action required._');
  return sendWhatsApp(lines.join('\n'));
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

  if (isEmailEnabled()) {
    if (withinCooldown(site.id, 'email')) {
      console.log(`[notifier] email cooldown active for ${site.name} — skipping`);
    } else {
      const out = await sendEmail(subject, body);
      if (out.results) {
        for (const r of out.results) {
          logNotification(site.id, 'email', r.to, r.ok ? 'ok' : 'error', r.error);
        }
      }
    }
  }
  if (isWhatsAppEnabled()) {
    if (withinCooldown(site.id, 'whatsapp')) {
      console.log(`[notifier] whatsapp cooldown active for ${site.name} — skipping`);
    } else {
      const out = await sendWhatsApp(body);
      if (out.results) {
        for (const r of out.results) {
          logNotification(site.id, 'whatsapp', r.to, r.ok ? 'ok' : 'error', r.error);
        }
      }
    }
  }
  if (isTeamsEnabled()) {
    if (withinCooldown(site.id, 'teams')) {
      console.log(`[notifier] teams cooldown active for ${site.name} — skipping`);
    } else {
      const out = await sendTeamsCard(`🔴 DOWN: ${site.name}`, body, 'CF222E');
      logNotification(site.id, 'teams', 'webhook', out.ok ? 'ok' : 'error', out.ok ? null : out.error);
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
  if (isTeamsEnabled()) {
    await sendTeamsCard(`⚠️ SSL expiring ≤${thresholdDays}d: ${site.name}`, body, 'B08800');
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
  if (isTeamsEnabled()) {
    await sendTeamsCard(`🟢 RECOVERED: ${site.name}`, body, '2DA44E');
  }
}

async function sendTestEmail(toOverride) {
  const recipients = toOverride
    ? [toOverride]
    : (getSetting('email_recipients') || '').split(/[,;\n\r]+/).map((s) => s.trim()).filter(Boolean);
  if (!process.env.SMTP_HOST) return { ok: false, error: 'SMTP not configured in .env' };
  if (recipients.length === 0) return { ok: false, error: 'No recipients configured' };
  const transporter = getTransporter();
  const errors = [];
  for (const to of recipients) {
    try {
      await transporter.sendMail({
        from: process.env.SMTP_FROM || process.env.SMTP_USER,
        to,
        subject: '[Status Monitor] Test email',
        text: 'This is a test message from your Status Monitor.',
      });
    } catch (err) {
      errors.push(`${to}: ${err.message}`);
    }
  }
  return errors.length === 0
    ? { ok: true }
    : { ok: errors.length < recipients.length, error: errors.join('; ') };
}

async function sendTestWhatsApp(toOverride) {
  const recipients = toOverride
    ? [toOverride]
    : (getSetting('whatsapp_recipients') || '').split(/[,;\n\r]+/).map((s) => s.trim()).filter(Boolean);
  if (!process.env.TWILIO_ACCOUNT_SID) return { ok: false, error: 'Twilio not configured in .env' };
  if (recipients.length === 0) return { ok: false, error: 'No recipients configured' };
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_WHATSAPP_FROM;
  const url = `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`;
  const errors = [];
  for (let to of recipients) {
    if (!to.startsWith('whatsapp:')) to = `whatsapp:${to}`;
    try {
      const params = new URLSearchParams({
        From: from, To: to, Body: 'Test message from Status Monitor',
      });
      await axios.post(url, params, {
        auth: { username: sid, password: token },
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: 15000,
      });
    } catch (err) {
      const detail = err.response?.data?.message || err.message;
      errors.push(`${to}: ${detail}`);
    }
  }
  return errors.length === 0
    ? { ok: true }
    : { ok: errors.length < recipients.length, error: errors.join('; ') };
}

async function sendPasswordResetEmail(toEmail, resetUrl) {
  if (!process.env.SMTP_HOST) return false;
  const transporter = getTransporter();
  const from = process.env.SMTP_FROM || process.env.SMTP_USER;
  const subject = '[Status Monitor] Password reset request';
  const body = [
    'You requested a password reset for your Status Monitor account.',
    '',
    'Click the link below to set a new password (valid for 1 hour):',
    resetUrl,
    '',
    'If you did not request this, you can ignore this email.',
  ].join('\n');
  try {
    await transporter.sendMail({ from, to: toEmail, subject, text: body });
    return true;
  } catch (err) {
    console.error('[notifier] password reset email failed:', err.message);
    return false;
  }
}

async function sendPendingActionNotification(moderatorEmail, description) {
  if (!isEmailEnabled()) return;
  const admins = db.prepare("SELECT email FROM users WHERE role = 'admin'").all();
  if (admins.length === 0) return;
  const transporter = getTransporter();
  const from = process.env.SMTP_FROM || process.env.SMTP_USER;
  const subject = '[Status Monitor] Moderator action pending your approval';
  const body = [
    'A moderator has submitted a change that requires your approval.',
    '',
    `Moderator: ${moderatorEmail}`,
    `Action: ${description}`,
    '',
    'Log in to the admin panel and go to Pending Actions to approve or reject.',
  ].join('\n');
  for (const admin of admins) {
    try {
      await transporter.sendMail({ from, to: admin.email, subject, text: body });
    } catch (err) {
      console.error('[notifier] pending action email failed:', err.message);
    }
  }
}

async function sendActionResultNotification(moderatorEmail, description, approved, note = '') {
  if (!isEmailEnabled()) return;
  const transporter = getTransporter();
  const from = process.env.SMTP_FROM || process.env.SMTP_USER;
  const subject = approved
    ? '[Status Monitor] Your change has been approved'
    : '[Status Monitor] Your change has been rejected';
  const lines = [
    `Your pending action has been ${approved ? 'approved and executed' : 'rejected'}.`,
    '',
    `Action: ${description}`,
  ];
  if (note) lines.push(`Note: ${note}`);
  try {
    await transporter.sendMail({ from, to: moderatorEmail, subject, text: lines.join('\n') });
  } catch (err) {
    console.error('[notifier] action result email failed:', err.message);
  }
}

module.exports = {
  sendDownAlert,
  sendUpAlert,
  sendSslWarning,
  sendBugReportNotification,
  sendPasswordResetEmail,
  sendPendingActionNotification,
  sendActionResultNotification,
  sendTestEmail,
  sendTestWhatsApp,
  sendTestWhatsAppAll,
  sendTestTeams,
  isEmailEnabled,
  isWhatsAppEnabled,
  isTeamsEnabled,
};
