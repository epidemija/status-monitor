const db = require('../db/database');
const notifier = require('./notifier');

function queueAction(req, res, actionType, actionData, description, redirectTo) {
  db.prepare(`
    INSERT INTO pending_actions (user_id, user_email, action_type, action_data, description)
    VALUES (?, ?, ?, ?, ?)
  `).run(req.session.userId, req.session.userEmail, actionType, JSON.stringify(actionData), description);
  notifier.sendPendingActionNotification(req.session.userEmail, description).catch(() => {});
  return res.redirect(redirectTo + '?flash=Change+submitted+for+admin+approval');
}

module.exports = queueAction;
