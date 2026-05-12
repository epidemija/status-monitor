const crypto = require('crypto');
const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db/database');
const notifier = require('../lib/notifier');

const router = express.Router();

router.get('/login', (req, res) => {
  if (req.session && req.session.userId) return res.redirect('/admin');
  res.render('login', { error: null, flash: req.query.flash || null });
});

router.post('/login', (req, res) => {
  const email = (req.body.email || '').trim().toLowerCase();
  const password = req.body.password || '';
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).render('login', { error: 'Invalid email or password', flash: null });
  }
  req.session.userId = user.id;
  req.session.userEmail = user.email;
  req.session.userRole = user.role;

  // Record the login for the admin audit log.
  try {
    db.prepare(
      'INSERT INTO user_logins (user_id, user_email, user_role, ip, user_agent) VALUES (?, ?, ?, ?, ?)'
    ).run(
      user.id, user.email, user.role,
      req.ip || req.socket?.remoteAddress || null,
      (req.headers['user-agent'] || '').slice(0, 500)
    );
  } catch (_) {}

  res.redirect('/admin');
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

// --- Forgot password ---
router.get('/forgot-password', (req, res) => {
  if (req.session && req.session.userId) return res.redirect('/admin');
  res.render('forgot-password', { sent: false, error: null });
});

router.post('/forgot-password', async (req, res) => {
  const email = (req.body.email || '').trim().toLowerCase();
  // Always show the same response to avoid revealing whether an account exists.
  const done = () => res.render('forgot-password', { sent: true, error: null });

  if (!email) return done();

  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user) return done();

  // Delete any existing reset tokens for this user.
  db.prepare('DELETE FROM password_resets WHERE user_id = ?').run(user.id);

  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // 1 hour
  db.prepare('INSERT INTO password_resets (user_id, token, expires_at) VALUES (?, ?, ?)').run(user.id, token, expiresAt);

  const proto = req.get('x-forwarded-proto') || req.protocol;
  const host = req.get('x-forwarded-host') || req.get('host');
  const resetUrl = `${proto}://${host}/reset-password/${token}`;

  const sent = await notifier.sendPasswordResetEmail(email, resetUrl);
  if (!sent) {
    // SMTP not configured — log the link so a server admin can retrieve it.
    console.log(`[auth] Password reset link for ${email}: ${resetUrl}`);
  }

  done();
});

// --- Reset password ---
router.get('/reset-password/:token', (req, res) => {
  const row = db.prepare(`
    SELECT pr.*, u.email FROM password_resets pr
    JOIN users u ON u.id = pr.user_id
    WHERE pr.token = ? AND pr.expires_at > datetime('now')
  `).get(req.params.token);
  if (!row) return res.render('reset-password', { valid: false, token: null, error: null });
  res.render('reset-password', { valid: true, token: req.params.token, error: null });
});

router.post('/reset-password/:token', (req, res) => {
  const row = db.prepare(`
    SELECT pr.*, u.email FROM password_resets pr
    JOIN users u ON u.id = pr.user_id
    WHERE pr.token = ? AND pr.expires_at > datetime('now')
  `).get(req.params.token);
  if (!row) return res.render('reset-password', { valid: false, token: null, error: null });

  const { password, confirm } = req.body;
  if (!password || password.length < 8) {
    return res.render('reset-password', { valid: true, token: req.params.token, error: 'Password must be at least 8 characters' });
  }
  if (password !== confirm) {
    return res.render('reset-password', { valid: true, token: req.params.token, error: 'Passwords do not match' });
  }

  const hash = bcrypt.hashSync(password, 10);
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, row.user_id);
  db.prepare('DELETE FROM password_resets WHERE user_id = ?').run(row.user_id);

  res.redirect('/login?flash=' + encodeURIComponent('Password reset successfully. Please sign in.'));
});

module.exports = router;
