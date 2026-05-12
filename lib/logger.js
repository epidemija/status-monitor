// Lightweight file logger.
// Patches console.log / console.error / console.warn so all existing
// [module] tags are captured automatically without touching other files.
// Log lines are appended to data/app.log; the file is rotated (.old) at 5 MB.

const fs = require('fs');
const path = require('path');

const LOG_PATH = path.join(__dirname, '..', 'app.log');
const MAX_BYTES = 5 * 1024 * 1024; // 5 MB

let _rotateChecked = 0;

function rotateIfNeeded() {
  const now = Date.now();
  // Only stat once per minute to avoid hammering the filesystem.
  if (now - _rotateChecked < 60000) return;
  _rotateChecked = now;
  try {
    const stat = fs.statSync(LOG_PATH);
    if (stat.size > MAX_BYTES) {
      fs.renameSync(LOG_PATH, LOG_PATH + '.old');
    }
  } catch (_) {}
}

function writeLine(level, args) {
  rotateIfNeeded();
  const ts = new Date().toISOString();
  const msg = args
    .map((a) => {
      if (a instanceof Error) return a.stack || a.message;
      if (typeof a === 'object' && a !== null) {
        try { return JSON.stringify(a); } catch (_) { return String(a); }
      }
      return String(a);
    })
    .join(' ');
  const line = `${ts} [${level}] ${msg}\n`;
  try { fs.appendFileSync(LOG_PATH, line); } catch (_) {}
}

// Patch the global console so every existing console.log/error/warn call
// also lands in the log file without needing to change other files.
const _origLog   = console.log.bind(console);
const _origError = console.error.bind(console);
const _origWarn  = console.warn.bind(console);

console.log = (...args) => { _origLog(...args);   writeLine('INFO',  args); };
console.error = (...args) => { _origError(...args); writeLine('ERROR', args); };
console.warn  = (...args) => { _origWarn(...args);  writeLine('WARN',  args); };

// Write a startup banner so each restart is visible in the log.
writeLine('INFO', [`===== App starting — node ${process.version} — pid ${process.pid} =====`]);

// Catch unhandled promise rejections and uncaught exceptions so they appear
// in the log file rather than only on stdout (which Plesk may suppress).
process.on('uncaughtException', (err) => {
  console.error('[process] Uncaught exception:', err);
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  console.error('[process] Unhandled rejection:', reason);
});

/**
 * Express middleware: logs METHOD /path -> STATUS (Xms) [ip] to the file.
 * Attach with app.use(requestLogger) after express.json() / urlencoded.
 */
function requestLogger(req, res, next) {
  const start = Date.now();
  // Log after the response is flushed so we have the final status code.
  res.on('finish', () => {
    const ms = Date.now() - start;
    const level = res.statusCode >= 500 ? 'ERROR' : res.statusCode >= 400 ? 'WARN' : 'HTTP';
    writeLine(level, [
      `${req.method} ${req.originalUrl} -> ${res.statusCode} (${ms}ms) [${req.ip || req.socket?.remoteAddress || '?'}]`,
    ]);
  });
  next();
}

module.exports = { requestLogger, LOG_PATH };
