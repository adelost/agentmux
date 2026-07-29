// D1/store layer for the Link mailbox. Every statement is parameterized;
// `db` is the D1 binding in the worker and a node:sqlite adapter in tests.

/** WHAT: Builds the mailbox store over a D1-shaped binding. WHY: Keeps SQL out of the decision layer. */
export function createLinkStore(db) {
  const run = (sql, ...args) => db.prepare(sql).bind(...args).run();
  const first = (sql, ...args) => db.prepare(sql).bind(...args).first();
  const all = async (sql, ...args) => {
    const result = await db.prepare(sql).bind(...args).all();
    if (Array.isArray(result)) return result;
    if (Array.isArray(result?.results)) return result.results;
    throw new Error("d1-results-invalid");
  };

  return {
    getMessage: (clientMessageId) =>
      first("SELECT * FROM messages WHERE clientMessageId = ?", clientMessageId),

    getMessageForApp: (clientMessageId, identityId) =>
      first(
        "SELECT * FROM messages WHERE clientMessageId = ? AND identityId = ?",
        clientMessageId, identityId,
      ),

    insertMessage: ({ clientMessageId, identityId, target, kind, body, voiceRef = null, nowMs }) =>
      first(
        `INSERT INTO messages (clientMessageId, identityId, target, kind, body, voiceRef, state, createdAt)
         VALUES (?, ?, ?, ?, ?, ?, 'queued', ?)
         ON CONFLICT (clientMessageId) DO NOTHING RETURNING *`,
        clientMessageId, identityId, target, kind, body, voiceRef, nowMs,
      ),

    reclaimExpiredLeases: (nowMs) =>
      run(
        `UPDATE messages SET state = 'queued', leaseOwner = NULL, leaseExpiresAt = NULL
         WHERE state = 'leased' AND leaseExpiresAt < ?`,
        nowMs,
      ),

    reclaimStaleDelivered: (staleBeforeMs) =>
      run(
        `UPDATE messages SET state = 'queued', leaseOwner = NULL, leaseExpiresAt = NULL, deliveredAt = NULL
         WHERE state = 'delivered' AND deliveredAt < ?`,
        staleBeforeMs,
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

    eventsAfter: ({ afterSeq = 0, limit = 50, identityId = null }) => {
      if (identityId) {
        return all(
          `SELECT seq, clientMessageId, target, kind, state, body, replyBody,
                  createdAt, deliveredAt, replyAt, lastError
           FROM message_events WHERE seq > ? AND identityId = ? ORDER BY seq LIMIT ?`,
          afterSeq, identityId, limit,
        );
      }
      return all(
        `SELECT seq, clientMessageId, target, kind, state, body, replyBody,
                createdAt, deliveredAt, replyAt, lastError
         FROM message_events WHERE seq > ? ORDER BY seq LIMIT ?`,
        afterSeq, limit,
      );
    },

    heartbeat: ({ connectorId, target, source, nowMs }) =>
      run(
        `INSERT INTO heartbeats (connectorId, target, seenAt, source) VALUES (?, ?, ?, ?)
         ON CONFLICT (connectorId, target) DO UPDATE SET seenAt = excluded.seenAt`,
        connectorId, target, nowMs, source,
      ),

    heartbeatStates: (staleMs, nowMs) =>
      all(
        `SELECT target, MAX(seenAt) AS seenAt,
                MAX(CASE WHEN seenAt >= ? THEN 1 ELSE 0 END) AS online
         FROM heartbeats GROUP BY target`,
        nowMs - staleMs,
      ),

    /** WHAT: Counts one scoped action and prunes expired windows. WHY: Bounds both request bursts and retained rate-limit debt. */
    hitRateLimit: async ({ subject, scope, bucket, max }) => {
      await run("DELETE FROM rate_windows WHERE bucket < ?", bucket - 1);
      const row = await first(
        `INSERT INTO rate_windows (subject, scope, bucket, count) VALUES (?, ?, ?, 1)
         ON CONFLICT (subject, scope, bucket) DO UPDATE SET count = count + 1
         RETURNING count`,
        subject, scope, bucket,
      );
      return (row?.count ?? 0) > max;
    },

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

    takeExchangeCode: (codeHash, challenge, nowMs) =>
      first(
        `UPDATE exchange_codes SET usedAt = ?
         WHERE codeHash = ? AND challenge = ? AND usedAt IS NULL AND expiresAt > ? RETURNING *`,
        nowMs, codeHash, challenge, nowMs,
      ),
  };
}
