'use strict';

// Admin action audit log. auditStatement() returns a [sql, args] pair so the
// log entry is written in the SAME atomic batch as the action it describes:
// either both are stored or neither is.

const db = require('../db');

function auditStatement(actor, action, targetType, targetId, details = {}) {
  return [
    `INSERT INTO admin_audit_log (actor_id, actor_username, action, target_type, target_id, details)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [actor.id, actor.username, action, targetType, targetId, JSON.stringify(details)],
  ];
}

// Moderation by an admin on content they do not own is audited; owners
// deleting their own content are not.
function moderationAudit(actor, ownerId, action, targetType, targetId, details) {
  return actor.role === 'admin' && actor.id !== ownerId
    ? [auditStatement(actor, action, targetType, targetId, details)]
    : [];
}

async function recentEntries(limit = 100) {
  const rows = await db.all('SELECT * FROM admin_audit_log ORDER BY id DESC LIMIT ?', [limit]);
  return rows.map((r) => ({ ...r, details: JSON.parse(r.details) }));
}

module.exports = { auditStatement, moderationAudit, recentEntries };
