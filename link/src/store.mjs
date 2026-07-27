// D1/store layer for the Link mailbox. Every statement is parameterized;
// `db` is the D1 binding in the worker and a node:sqlite adapter in tests.

/** WHAT: Builds the mailbox store over a D1-shaped binding. WHY: Keeps SQL out of the decision layer. */
export function createLinkStore(db) {
  const run = (sql, ...args) => db.prepare(sql).bind(...args).run();
  const first = (sql, ...args) => db.prepare(sql).bind(...args).first();
  const all = (sql, ...args) => db.prepare(sql).bind(...args).all();

  return {
    getMessage: (clientMessageId) =>
      first("SELECT * FROM messages WHERE clientMessageId = ?", clientMessageId),

    insertMessage: ({ clientMessageId, target, kind, body, voiceRef = null, nowMs }) =>
      run(
        `INSERT INTO messages (clientMessageId, target, kind, body, voiceRef, state, createdAt)
         VALUES (?, ?, ?, ?, ?, 'queued', ?)`,
        clientMessageId, target, kind, body, voiceRef, nowMs,
      ),

    reclaimExpiredLeases: (nowMs) =>
      run(
        `UPDATE messages SET state = 'queued', leaseOwner = NULL, leaseExpiresAt = NULL
         WHERE state = 'leased' AND leaseExpiresAt < ?`,
        nowMs,
      ),

    claimQueued: ({ connectorId, targets, leaseMs, nowMs }) => {
      const marks = targets.map(() => "?").join(",");
      return all(
        `UPDATE messages SET state = 'leased', leaseOwner = ?, leaseExpiresAt = ?, attempts = attempts + 1
         WHERE clientMessageId IN (
           SELECT clientMessageId FROM messages
           WHERE state = 'queued' AND target IN (${marks})
           ORDER BY createdAt LIMIT 5)
         RETURNING *`,
        connectorId, nowMs + leaseMs, ...targets,
      );
    },

    markDelivered: ({ clientMessageId, connectorId, nowMs }) =>
      run(
        `UPDATE messages SET state = 'delivered', deliveredAt = ?
         WHERE clientMessageId = ? AND state = 'leased' AND leaseOwner = ?`,
        nowMs, clientMessageId, connectorId,
      ),

    markReplied: ({ clientMessageId, connectorId, replyBody, nowMs }) =>
      run(
        `UPDATE messages SET state = 'replied', replyBody = ?, replyAt = ?
         WHERE clientMessageId = ? AND state = 'delivered' AND leaseOwner = ?`,
        replyBody, nowMs, clientMessageId, connectorId,
      ),

    markFailed: ({ clientMessageId, connectorId, error, nowMs }) =>
      run(
        `UPDATE messages SET state = 'failed', lastError = ?, replyAt = ?
         WHERE clientMessageId = ? AND state IN ('queued','leased','delivered')
           AND (leaseOwner = ? OR leaseOwner IS NULL)`,
        String(error || "").slice(0, 300), nowMs, clientMessageId, connectorId,
      ),

    eventsAfter: ({ afterSeq = 0, limit = 50 }) =>
      all(
        `SELECT rowid AS seq, clientMessageId, target, kind, state, body, replyBody,
                createdAt, deliveredAt, replyAt, lastError
         FROM messages WHERE rowid > ? ORDER BY rowid LIMIT ?`,
        afterSeq, limit,
      ),

    heartbeat: ({ connectorId, target, source, nowMs }) =>
      run(
        `INSERT INTO heartbeats (connectorId, target, seenAt, source) VALUES (?, ?, ?, ?)
         ON CONFLICT (connectorId, target) DO UPDATE SET seenAt = excluded.seenAt`,
        connectorId, target, nowMs, source,
      ),

    heartbeatStates: (staleMs, nowMs) =>
      all(
        `SELECT target, source, seenAt, (CASE WHEN seenAt >= ? THEN 1 ELSE 0 END) AS online
         FROM heartbeats`,
        nowMs - staleMs,
      ),

    insertSession: ({ tokenHash, identityId, nowMs, ttlSeconds }) =>
      run(
        "INSERT INTO sessions (tokenHash, identityId, createdAt, expiresAt) VALUES (?, ?, ?, ?)",
        tokenHash, identityId, nowMs, nowMs + ttlSeconds * 1000,
      ),

    sessionFor: (tokenHash, nowMs) =>
      first(
        "SELECT * FROM sessions WHERE tokenHash = ? AND revokedAt IS NULL AND expiresAt > ?",
        tokenHash, nowMs,
      ),

    revokeSession: (tokenHash, nowMs) =>
      run("UPDATE sessions SET revokedAt = ? WHERE tokenHash = ? AND revokedAt IS NULL", nowMs, tokenHash),

    identityFor: (identityId) =>
      first("SELECT * FROM identities WHERE identityId = ?", identityId),

    bindOnce: ({ identityId, verifiedEmail, nowMs }) =>
      run(
        `INSERT INTO bindings (identityId, verifiedEmail, boundAt) VALUES (?, ?, ?)
         ON CONFLICT (identityId) DO NOTHING`,
        identityId, verifiedEmail, nowMs,
      ),

    bindingFor: (identityId) =>
      first("SELECT * FROM bindings WHERE identityId = ?", identityId),

    insertExchangeCode: ({ codeHash, challenge, identityId, verifiedEmail, nowMs, ttlSeconds }) =>
      run(
        `INSERT INTO exchange_codes (codeHash, challenge, identityId, verifiedEmail, createdAt, expiresAt)
         VALUES (?, ?, ?, ?, ?, ?)`,
        codeHash, challenge, identityId, verifiedEmail, nowMs, nowMs + ttlSeconds * 1000,
      ),

    takeExchangeCode: (codeHash, nowMs) =>
      first(
        `UPDATE exchange_codes SET usedAt = ?
         WHERE codeHash = ? AND usedAt IS NULL AND expiresAt > ? RETURNING *`,
        nowMs, codeHash, nowMs,
      ),
  };
}
