// Website monitoring engine.
// For each site we measure:
//   * HTTP availability (status code) and response time in ms
//   * Final URL after redirects + redirect count
//   * SSL certificate validity, issuer, days remaining (HTTPS only)
//   * Optional keyword presence in the response body
//
// All results are written to the `checks` table and incidents are opened/closed
// based on a configurable threshold of consecutive failures.

const tls = require('tls');
const { URL } = require('url');
const axios = require('axios');
const db = require('../db/database');
const notifier = require('./notifier');

const ALERT_THRESHOLD = parseInt(process.env.ALERT_THRESHOLD || '2', 10);

function isInMaintenance(siteId) {
  const row = db.prepare(`
    SELECT id FROM maintenance_windows
    WHERE (site_id IS NULL OR site_id = ?)
      AND starts_at <= datetime('now')
      AND ends_at >= datetime('now')
    LIMIT 1
  `).get(siteId);
  return !!row;
}

/**
 * Fetch the SSL certificate for a hostname:port and return validity info.
 * Returns { valid, issuer, validTo, daysRemaining } or { valid: false, error }.
 */
function checkSsl(hostname, port = 443, timeoutMs = 10000) {
  return new Promise((resolve) => {
    const socket = tls.connect(
      { host: hostname, port, servername: hostname, rejectUnauthorized: false, timeout: timeoutMs },
      () => {
        const cert = socket.getPeerCertificate();
        const authorized = socket.authorized;
        socket.end();
        if (!cert || Object.keys(cert).length === 0) {
          return resolve({ valid: false, error: 'No certificate' });
        }
        const validTo = new Date(cert.valid_to);
        const daysRemaining = Math.floor((validTo - new Date()) / 86400000);
        const issuer = (cert.issuer && (cert.issuer.O || cert.issuer.CN)) || 'Unknown';
        resolve({
          valid: authorized && daysRemaining > 0,
          authorized,
          issuer,
          validTo,
          daysRemaining,
          authorizationError: socket.authorizationError ? String(socket.authorizationError) : null,
        });
      }
    );
    socket.on('error', (err) => resolve({ valid: false, error: err.message }));
    socket.on('timeout', () => {
      socket.destroy();
      resolve({ valid: false, error: 'TLS timeout' });
    });
  });
}

/**
 * Run a full check on one site.
 */
async function checkSite(site) {
  const start = Date.now();
  const result = {
    site_id: site.id,
    is_up: 0,
    status_code: null,
    initial_status_code: null,
    response_time_ms: null,
    ssl_valid: null,
    ssl_days_remaining: null,
    ssl_issuer: null,
    ssl_expires_at: null,
    redirect_count: 0,
    final_url: null,
    keyword_ok: null,
    error_message: null,
    server_ip: null,
    server_header: null,
  };

  let parsedUrl;
  try {
    parsedUrl = new URL(site.url);
  } catch (e) {
    result.error_message = 'Invalid URL';
    return result;
  }

  // 1) HTTP request with redirect tracking and timing
  let redirectCount = 0;
  let initialStatusCode = null;
  let statusOk = false;
  let keywordOk = null;

  try {
    const response = await axios.get(site.url, {
      timeout: 15000,
      maxRedirects: 5,
      validateStatus: () => true, // we want to capture any status code, not throw
      headers: {
        'User-Agent': 'StatusMonitor/1.0 (+https://wirthgruppe.com)',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
      // The first time this fires we record the original 3xx that triggered the redirect.
      beforeRedirect: (opts, responseDetails) => {
        redirectCount++;
        if (initialStatusCode == null && responseDetails && responseDetails.statusCode) {
          initialStatusCode = responseDetails.statusCode;
        }
      },
    });
    result.response_time_ms = Date.now() - start;
    result.status_code = response.status;
    // If no redirect happened, the initial code IS the final code.
    result.initial_status_code = initialStatusCode != null ? initialStatusCode : response.status;
    result.redirect_count = redirectCount;
    result.final_url = response.request?.res?.responseUrl || site.url;
    result.server_ip     = response.request?.socket?.remoteAddress ?? null;
    result.server_header = response.headers?.['server'] ?? null;

    const expectedStatus = site.expected_status || 200;
    statusOk = response.status === expectedStatus ||
               (expectedStatus === 200 && response.status >= 200 && response.status < 300);

    if (site.expected_keyword) {
      const body = typeof response.data === 'string'
        ? response.data
        : JSON.stringify(response.data || '');
      keywordOk = body.includes(site.expected_keyword) ? 1 : 0;
      result.keyword_ok = keywordOk;
    }
  } catch (err) {
    result.response_time_ms = Date.now() - start;
    result.error_message = err.code || err.message || 'Request failed';
    return result; // is_up stays 0
  }

  // 2) SSL check on the FINAL URL's hostname so domain-level redirects
  //    (e.g. http://example.com → https://www.example.com) are evaluated
  //    against the cert that actually serves the content, not the origin hostname.
  let finalParsed = parsedUrl;
  try { finalParsed = new URL(result.final_url || site.url); } catch (_) {}

  if (finalParsed.protocol === 'https:') {
    const ssl = await checkSsl(finalParsed.hostname, finalParsed.port || 443);
    result.ssl_valid = ssl.valid ? 1 : 0;
    result.ssl_days_remaining = ssl.daysRemaining ?? null;
    result.ssl_issuer = ssl.issuer ?? null;
    result.ssl_expires_at = ssl.validTo ? ssl.validTo.toISOString() : null;
    if (!ssl.valid && ssl.error) {
      result.error_message = `SSL: ${ssl.error}`;
    } else if (!ssl.valid && ssl.authorizationError) {
      result.error_message = `SSL: ${ssl.authorizationError}`;
    }
  }

  // 3) Compute is_up combining HTTP status + SSL + keyword
  const sslOk = finalParsed.protocol !== 'https:' || result.ssl_valid === 1;
  const keywordOkFinal = keywordOk === null ? true : keywordOk === 1;
  result.is_up = statusOk && sslOk && keywordOkFinal ? 1 : 0;
  if (!result.is_up && !result.error_message) {
    if (!statusOk) result.error_message = `Unexpected status ${result.status_code}`;
    else if (!keywordOkFinal) result.error_message = `Missing keyword "${site.expected_keyword}"`;
  }

  return result;
}

/**
 * Persist a check result and run incident logic.
 */
function recordCheck(result) {
  db.prepare(`
    INSERT INTO checks
      (site_id, is_up, status_code, initial_status_code, response_time_ms, ssl_valid, ssl_days_remaining,
       ssl_issuer, ssl_expires_at, redirect_count, final_url, keyword_ok, error_message,
       server_ip, server_header)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    result.site_id, result.is_up, result.status_code, result.initial_status_code, result.response_time_ms,
    result.ssl_valid, result.ssl_days_remaining, result.ssl_issuer, result.ssl_expires_at,
    result.redirect_count, result.final_url, result.keyword_ok, result.error_message,
    result.server_ip, result.server_header
  );
}

/**
 * Categorize a response time relative to per-site thresholds.
 * Returns 'good' | 'warn' | 'crit' | 'unknown'.
 */
function tierResponseTime(site, ms) {
  if (ms == null) return 'unknown';
  const warn = site.response_time_warn_ms ?? 800;
  const crit = site.response_time_crit_ms ?? 2500;
  if (ms >= crit) return 'crit';
  if (ms >= warn) return 'warn';
  return 'good';
}

/**
 * SSL expiry warning logic.
 * Fires email/WhatsApp at 30, 14, 7, 1 days remaining — once per (site, threshold, cert).
 * The unique constraint on ssl_alert_log keeps it from spamming.
 */
async function maintainSslAlert(site, result) {
  if (site.parent_id) return; // SSL alerts only for primary domains
  if (result.ssl_valid !== 1) return; // only warn for currently-valid certs
  if (result.ssl_days_remaining == null || result.ssl_expires_at == null) return;
  const thresholds = [30, 14, 7, 1];
  for (const t of thresholds) {
    if (result.ssl_days_remaining <= t) {
      try {
        const info = db.prepare(`
          INSERT INTO ssl_alert_log (site_id, threshold_days, cert_expires_at)
          VALUES (?, ?, ?)
        `).run(site.id, t, result.ssl_expires_at);
        if (info.changes === 1) {
          // We were the first to insert this (site, threshold, cert) tuple — send the alert.
          await notifier.sendSslWarning(site, result, t);
          console.log(`[monitor] SSL warning sent for ${site.name}: <${t} day(s) remaining`);
        }
      } catch (e) {
        // UNIQUE violation = already sent for this cert+threshold; ignore.
      }
      break; // only the most-urgent matched threshold this run
    }
  }
}

/**
 * Open / close incidents based on consecutive failures.
 * Returns { opened, closed } booleans.
 */
async function maintainIncident(site, result) {
  // Look at the last N checks (most recent first)
  const recent = db.prepare(
    'SELECT is_up FROM checks WHERE site_id = ? ORDER BY id DESC LIMIT ?'
  ).all(site.id, ALERT_THRESHOLD);

  const open = db.prepare(
    'SELECT * FROM incidents WHERE site_id = ? AND resolved_at IS NULL ORDER BY id DESC LIMIT 1'
  ).get(site.id);

  let opened = false;
  let closed = false;

  // OPEN: last N checks all failed AND there is no open incident
  if (
    recent.length >= ALERT_THRESHOLD &&
    recent.every((c) => c.is_up === 0) &&
    !open
  ) {
    db.prepare(
      'INSERT INTO incidents (site_id, reason) VALUES (?, ?)'
    ).run(site.id, result.error_message || 'Down');
    opened = true;
  }

  // CLOSE: site recovered AND there is an open incident
  if (result.is_up === 1 && open) {
    db.prepare(
      'UPDATE incidents SET resolved_at = CURRENT_TIMESTAMP WHERE id = ?'
    ).run(open.id);
    closed = true;
  }

  // Notifications only for primary (non-child) domains, and not during maintenance windows.
  if (!site.parent_id && !isInMaintenance(site.id)) {
    if (site.notify_on_down && result.is_up === 0 && (opened || open)) {
      await notifier.sendDownAlert(site, result);
      if (opened) {
        db.prepare('UPDATE incidents SET notified = 1 WHERE site_id = ? AND resolved_at IS NULL').run(site.id);
      }
    }
    if (closed && site.notify_on_down) {
      await notifier.sendUpAlert(site);
    }
  }

  return { opened, closed };
}

/**
 * Run a full sweep across all enabled sites. Sequential is fine — usually just a few sites.
 */
async function runSweep() {
  const sites = db.prepare('SELECT * FROM sites WHERE enabled = 1').all();
  console.log(`[monitor] Sweep starting for ${sites.length} site(s)`);
  for (const site of sites) {
    try {
      const result = await checkSite(site);
      recordCheck(result);
      await maintainIncident(site, result);
      await maintainSslAlert(site, result);
      console.log(
        `[monitor] ${site.name} -> ${result.is_up ? 'UP' : 'DOWN'} ` +
        `(status=${result.status_code} time=${result.response_time_ms}ms ` +
        `ssl=${result.ssl_valid === 1 ? 'ok' : result.ssl_valid === 0 ? 'bad' : 'n/a'})`
      );
    } catch (err) {
      console.error(`[monitor] Error checking ${site.url}:`, err.message);
    }
  }
  console.log('[monitor] Sweep complete');
}

/**
 * Fetch the <title> of a site's URL and update sites.name in the DB if it changed.
 * Only called during manual checks — not during scheduled sweeps.
 * Returns the new title string, or null if unchanged / unreachable.
 */
async function fetchAndUpdateTitle(site) {
  try {
    const { data } = await axios.get(site.url, {
      timeout: 6000,
      maxRedirects: 5,
      responseType: 'text',
      headers: { 'User-Agent': 'StatusMonitor/1.0 (title-fetch)' },
    });
    const match = String(data).match(/<title[^>]*>([^<]{1,200})<\/title>/i);
    if (!match) return null;
    const title = match[1].trim().replace(/\s+/g, ' ');
    if (title && title !== site.name) {
      db.prepare('UPDATE sites SET name = ? WHERE id = ?').run(title, site.id);
      return title;
    }
    return null;
  } catch (_) {
    return null;
  }
}

module.exports = { runSweep, checkSite, recordCheck, checkSsl, tierResponseTime, fetchAndUpdateTitle };
