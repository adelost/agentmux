-- Agentmux Link mailbox V1 (docs/link-internet-v1.md). Idempotent apply.

CREATE TABLE IF NOT EXISTS messages (
  clientMessageId TEXT PRIMARY KEY,
  identityId TEXT NOT NULL,
  target TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'text' CHECK (kind IN ('text', 'voice')),
  body TEXT NOT NULL DEFAULT '',
  voiceRef TEXT,
  state TEXT NOT NULL DEFAULT 'queued'
    CHECK (state IN ('queued', 'leased', 'delivered', 'replied', 'failed')),
  createdAt INTEGER NOT NULL,
  leaseOwner TEXT,
  leaseExpiresAt INTEGER,
  deliveredAt INTEGER,
  replyBody TEXT,
  replyAt INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,
  lastError TEXT
);
CREATE INDEX IF NOT EXISTS idx_messages_state_lease
  ON messages (state, leaseExpiresAt);
CREATE INDEX IF NOT EXISTS idx_messages_target_state
  ON messages (target, state);
CREATE INDEX IF NOT EXISTS idx_messages_identity
  ON messages (identityId);

-- Every observable mutation gets its own cursor position. Messages remain the
-- canonical current state; this append-only projection keeps a client that
-- already saw "queued" able to observe a later "replied" or "failed".
CREATE TABLE IF NOT EXISTS message_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  clientMessageId TEXT NOT NULL,
  identityId TEXT NOT NULL,
  target TEXT NOT NULL,
  kind TEXT NOT NULL,
  state TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  replyBody TEXT,
  createdAt INTEGER NOT NULL,
  deliveredAt INTEGER,
  replyAt INTEGER,
  lastError TEXT
);
CREATE INDEX IF NOT EXISTS idx_message_events_identity_seq
  ON message_events (identityId, seq);

-- Idempotently migrate rows written before the event ledger existed.
INSERT INTO message_events (
  clientMessageId, identityId, target, kind, state, body, replyBody,
  createdAt, deliveredAt, replyAt, lastError
)
SELECT
  message.clientMessageId, message.identityId, message.target, message.kind,
  message.state, message.body, message.replyBody, message.createdAt,
  message.deliveredAt, message.replyAt, message.lastError
FROM messages AS message
WHERE NOT EXISTS (
  SELECT 1 FROM message_events AS event
  WHERE event.clientMessageId = message.clientMessageId
);

CREATE TRIGGER IF NOT EXISTS append_message_insert_event
AFTER INSERT ON messages
BEGIN
  INSERT INTO message_events (
    clientMessageId, identityId, target, kind, state, body, replyBody,
    createdAt, deliveredAt, replyAt, lastError
  ) VALUES (
    NEW.clientMessageId, NEW.identityId, NEW.target, NEW.kind, NEW.state,
    NEW.body, NEW.replyBody, NEW.createdAt, NEW.deliveredAt, NEW.replyAt,
    NEW.lastError
  );
END;

CREATE TRIGGER IF NOT EXISTS append_message_update_event
AFTER UPDATE OF state, deliveredAt, replyAt, lastError ON messages
BEGIN
  INSERT INTO message_events (
    clientMessageId, identityId, target, kind, state, body, replyBody,
    createdAt, deliveredAt, replyAt, lastError
  ) VALUES (
    NEW.clientMessageId, NEW.identityId, NEW.target, NEW.kind, NEW.state,
    NEW.body, NEW.replyBody, NEW.createdAt, NEW.deliveredAt, NEW.replyAt,
    NEW.lastError
  );
END;

CREATE TABLE IF NOT EXISTS sessions (
  tokenHash TEXT PRIMARY KEY,
  identityId TEXT NOT NULL,
  createdAt INTEGER NOT NULL,
  expiresAt INTEGER NOT NULL,
  revokedAt INTEGER
);
CREATE INDEX IF NOT EXISTS idx_sessions_identity ON sessions (identityId);

CREATE TABLE IF NOT EXISTS identities (
  identityId TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  createdAt INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS bindings (
  identityId TEXT PRIMARY KEY,
  verifiedEmail TEXT NOT NULL,
  boundAt INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS heartbeats (
  connectorId TEXT NOT NULL,
  target TEXT NOT NULL,
  seenAt INTEGER NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('wsl', 'windows')),
  PRIMARY KEY (connectorId, target)
);

CREATE TABLE IF NOT EXISTS rate_windows (
  subject TEXT NOT NULL,
  scope TEXT NOT NULL,
  bucket INTEGER NOT NULL,
  count INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (subject, scope, bucket)
);

CREATE TABLE IF NOT EXISTS exchange_codes (
  codeHash TEXT PRIMARY KEY,
  challenge TEXT NOT NULL,
  identityId TEXT NOT NULL,
  verifiedEmail TEXT NOT NULL,
  createdAt INTEGER NOT NULL,
  expiresAt INTEGER NOT NULL,
  usedAt INTEGER
);
