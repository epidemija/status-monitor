// Visitor tracking middleware.
// Logs every public page hit to the `visitors` table and does an async
// IP geolocation lookup via the free ip-api.com API.
// Collected data is entirely server-side (HTTP headers) plus optional
// browser-supplied metrics posted separately by the page JS.

const axios = require('axios');
const db = require('../db/database');

const insertVisitor = db.prepare(`
  INSERT INTO visitors
    (ip, user_agent, referrer, page, accept_language)
  VALUES (?, ?, ?, ?, ?)
`);

const updateGeo = db.prepare(`
  UPDATE visitors SET
    country = ?, country_code = ?, region = ?, city = ?,
    lat = ?, lon = ?, timezone = ?,
    isp = ?, org = ?, as_info = ?,
    is_proxy = ?, is_mobile = ?, is_hosting = ?
  WHERE id = ?
`);

const updateBrowser = db.prepare(`
  UPDATE visitors SET
    screen_width = ?, screen_height = ?,
    window_width = ?, window_height = ?,
    timezone_js = ?, color_depth = ?,
    hardware_concurrency = ?, device_memory = ?,
    touch_points = ?, connection_type = ?,
    platform_js = ?, cookies_enabled = ?,
    do_not_track = ?, history_length = ?
  WHERE id = ?
`);

// Simple in-memory geo cache to avoid hammering ip-api.com on repeat visits.
const geoCache = new Map();
const GEO_CACHE_TTL = 15 * 60 * 1000; // 15 minutes

async function geoLookup(ip, visitorId) {
  if (!ip) return;
  // Skip private / loopback addresses — they won't resolve to a useful location.
  if (ip === '::1' || /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip)) return;

  const cached = geoCache.get(ip);
  if (cached && Date.now() - cached.ts < GEO_CACHE_TTL) {
    updateGeo.run(...cached.values, visitorId);
    return;
  }

  try {
    const fields = [
      'status', 'country', 'countryCode', 'region', 'regionName',
      'city', 'lat', 'lon', 'timezone', 'isp', 'org', 'as',
      'proxy', 'hosting', 'mobile',
    ].join(',');
    const { data } = await axios.get(`http://ip-api.com/json/${ip}?fields=${fields}`, {
      timeout: 6000,
    });
    if (data.status !== 'success') return;

    const values = [
      data.country, data.countryCode, data.regionName, data.city,
      data.lat, data.lon, data.timezone,
      data.isp, data.org, data.as,
      data.proxy ? 1 : 0, data.mobile ? 1 : 0, data.hosting ? 1 : 0,
    ];
    geoCache.set(ip, { values, ts: Date.now() });
    updateGeo.run(...values, visitorId);
  } catch (_) {}
}

function trackVisit(req, res, next) {
  try {
    const ip = req.ip || req.socket?.remoteAddress || null;
    const ua = (req.headers['user-agent'] || '').slice(0, 500);
    const referrer = (req.headers['referer'] || req.headers['referrer'] || '').slice(0, 500);
    const page = req.originalUrl.slice(0, 200);
    const lang = (req.headers['accept-language'] || '').slice(0, 200);

    const { lastInsertRowid } = insertVisitor.run(ip, ua, referrer, page, lang);
    res.locals.visitorId = lastInsertRowid;

    // Geo lookup fires after the response so the page isn't delayed.
    setImmediate(() => {
      geoLookup(ip, lastInsertRowid).catch(() => {});
    });
  } catch (_) {}
  next();
}

module.exports = { trackVisit, updateBrowser };
