// SQLite database setup using better-sqlite3 (synchronous, fast, single-file).
// The DB file lives in ./data/monitor.db.
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');

const DATA_DIR = path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH = path.join(DATA_DIR, 'monitor.db');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// --- Schema ---
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT DEFAULT 'admin',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS sites (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  expected_status INTEGER NOT NULL DEFAULT 200,
  expected_keyword TEXT,
  notify_on_down INTEGER NOT NULL DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS checks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id INTEGER NOT NULL,
  checked_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  is_up INTEGER NOT NULL,
  status_code INTEGER,
  response_time_ms INTEGER,
  ssl_valid INTEGER,
  ssl_days_remaining INTEGER,
  ssl_issuer TEXT,
  ssl_expires_at DATETIME,
  redirect_count INTEGER,
  final_url TEXT,
  keyword_ok INTEGER,
  error_message TEXT,
  FOREIGN KEY (site_id) REFERENCES sites(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_checks_site_time ON checks(site_id, checked_at DESC);

CREATE TABLE IF NOT EXISTS incidents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id INTEGER NOT NULL,
  started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  resolved_at DATETIME,
  reason TEXT,
  notified INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (site_id) REFERENCES sites(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS notification_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id INTEGER NOT NULL,
  channel TEXT NOT NULL,
  recipient TEXT,
  status TEXT,
  sent_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  error_message TEXT
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id INTEGER,
  reporter_name TEXT,
  reporter_email TEXT,
  severity TEXT NOT NULL DEFAULT 'medium',
  description TEXT NOT NULL,
  page_url TEXT,
  user_agent TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  resolved_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (site_id) REFERENCES sites(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_reports_status_time ON reports(status, created_at DESC);

CREATE TABLE IF NOT EXISTS ssl_alert_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id INTEGER NOT NULL,
  threshold_days INTEGER NOT NULL,
  cert_expires_at TEXT NOT NULL,
  sent_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (site_id) REFERENCES sites(id) ON DELETE CASCADE,
  UNIQUE(site_id, threshold_days, cert_expires_at)
);
`);

// --- Defensive ALTER TABLE: add new columns to `sites` if they don't exist yet.
//     Safe to run repeatedly on already-migrated DBs.
function columnExists(table, col) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col);
}
const sitesAdditions = [
  ['response_time_warn_ms', 'INTEGER NOT NULL DEFAULT 800'],
  ['response_time_crit_ms', 'INTEGER NOT NULL DEFAULT 2500'],
  ['ssl_warn_days',         'INTEGER NOT NULL DEFAULT 30'],
];
for (const [col, defn] of sitesAdditions) {
  if (!columnExists('sites', col)) {
    db.exec(`ALTER TABLE sites ADD COLUMN ${col} ${defn};`);
    console.log(`[db] Migrated sites: added column ${col}`);
  }
}

// `initial_status_code` lets us show "200 ← 301" (the actual first response,
// before redirects were followed). NULL on existing rows is fine.
if (!columnExists('checks', 'initial_status_code')) {
  db.exec('ALTER TABLE checks ADD COLUMN initial_status_code INTEGER;');
  console.log('[db] Migrated checks: added column initial_status_code');
}

// --- Default settings ---
const defaultSettings = {
  email_enabled: '0',
  email_recipients: '',
  whatsapp_enabled: '0',
  whatsapp_recipients: '', // comma-separated, format: +491701234567
  notify_on_report: '1',   // notify admin email when a bug report is filed
};

const insertSetting = db.prepare(
  'INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)'
);
for (const [k, v] of Object.entries(defaultSettings)) insertSetting.run(k, v);

// --- Seed initial admin user from env vars on first boot ---
function seedAdmin() {
  const count = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
  if (count > 0) return;
  const email = (process.env.ADMIN_EMAIL || 'admin@example.com').trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD || 'ChangeMe!2026';
  const hash = bcrypt.hashSync(password, 10);
  db.prepare(
    'INSERT INTO users (email, password_hash, role) VALUES (?, ?, ?)'
  ).run(email, hash, 'admin');
  console.log(`[db] Seeded initial admin user: ${email}`);
  console.log(`[db] Initial password: ${password}  (CHANGE IT after first login)`);
}

// --- Seed initial sites if none exist ---
function seedSites() {
  const count = db.prepare('SELECT COUNT(*) AS c FROM sites').get().c;
  if (count > 0) return;
  const initial = [
    { name: 'Wirth Gruppe',   url: 'https://wirthgruppe.com/' },
    { name: 'Wirsol',         url: 'https://wirsol.de' },
    { name: 'Höffner GmbH',   url: 'https://www.hoffner-gmbh.de' },
    { name: 'WPower',         url: 'https://wpower.eco/start/' },
  ];
  const insert = db.prepare(
    'INSERT INTO sites (name, url, enabled, expected_status, notify_on_down) VALUES (?, ?, 1, 200, 1)'
  );
  const tx = db.transaction((rows) => rows.forEach((r) => insert.run(r.name, r.url)));
  tx(initial);
  console.log(`[db] Seeded ${initial.length} initial sites`);
}

seedAdmin();
seedSites();

module.exports = db;
