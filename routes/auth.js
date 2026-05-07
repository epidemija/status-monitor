const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db/database');

const router = express.Router();

router.get('/login', (req, res) => {
  if (req.session && req.session.userId) return res.redirect('/admin');
  res.render('login', { error: null });
});

router.post('/login', (req, res) => {
  const email = (req.body.email || '').trim().toLowerCase();
  const password = req.body.password || '';
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).render('login', { error: 'Invalid email or password' });
  }
  req.session.userId = user.id;
  req.session.userEmail = user.email;
  res.redirect('/admin');
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

module.exports = router;
