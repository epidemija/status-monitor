function requireLogin(req, res, next) {
  if (req.session && req.session.userId) return next();
  return res.redirect('/login');
}

function requireAdmin(req, res, next) {
  if (!req.session || !req.session.userId) return res.redirect('/login');
  if (req.session.userRole !== 'admin') return res.status(403).send('Forbidden: admin access required');
  return next();
}

module.exports = { requireLogin, requireAdmin };
