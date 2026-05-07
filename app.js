// Status Monitor - main entry point
require('dotenv').config();

const path = require('path');
const fs = require('fs');
const express = require('express');
const session = require('express-session');
const Database = require('better-sqlite3');
const SqliteStore = require('better-sqlite3-session-store')(session);

// Initialize the database (creates schema, seeds admin user + initial sites)
require('./db/database');

// Separate SQLite file just for sessions, lives next to the main DB.
const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
const sessionDb = new Database(path.join(dataDir, 'sessions.db'));

const publicRoutes = require('./routes/public');
const authRoutes = require('./routes/auth');
const adminRoutes = require('./routes/admin');
const scheduler = require('./lib/scheduler');

const app = express();

// Plesk usually puts the Node.js app behind a reverse proxy.
app.set('trust proxy', 1);
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

app.use(session({
  store: new SqliteStore({
    client: sessionDb,
    expired: { clear: true, intervalMs: 15 * 60 * 1000 }, // sweep every 15 min
  }),
  secret: process.env.SESSION_SECRET || 'dev-only-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
    secure: process.env.NODE_ENV === 'production',
  },
}));

// Healthcheck (handy for Plesk monitoring or external uptime checks)
app.get('/healthz', (_req, res) => res.json({ ok: true, ts: new Date().toISOString() }));

// Routes
app.use('/', publicRoutes);
app.use('/', authRoutes);
app.use('/admin', adminRoutes);

// 404
app.use((req, res) => res.status(404).send('Not found'));

// Error handler
app.use((err, _req, res, _next) => {
  console.error('[error]', err);
  res.status(500).send('Internal server error');
});

const PORT = parseInt(process.env.PORT || '3000', 10);
app.listen(PORT, () => {
  console.log(`[server] Status Monitor listening on port ${PORT}`);
  scheduler.start();
});
