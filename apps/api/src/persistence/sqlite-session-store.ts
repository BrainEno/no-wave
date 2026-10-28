/**
 * SQLite persistence slice for revoked sessions, composed by sqlite-store.ts.
 */
function requiredSessionId(sessionId) {
  if (typeof sessionId !== "string" || sessionId.trim().length === 0 || sessionId !== sessionId.trim()) {
    throw new TypeError("sessionId must be a non-empty, trimmed string.");
  }
}

export function createSqliteSessionStore(db) {
  if (!db || typeof db.prepare !== "function") throw new TypeError("A SQLite database connection is required.");
  const findRevoked = db.prepare(
    "SELECT 1 AS revoked FROM revoked_sessions WHERE session_id = ? AND expires_at > ?",
  );
  const upsertRevocation = db.prepare(`
    INSERT INTO revoked_sessions (session_id, expires_at)
    VALUES (?, ?)
    ON CONFLICT (session_id) DO UPDATE SET
      expires_at = CASE WHEN excluded.expires_at > revoked_sessions.expires_at
                        THEN excluded.expires_at ELSE revoked_sessions.expires_at END,
      revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  `);

  return Object.freeze({
    async revokeSession({ sessionId, expiresAt }) {
      requiredSessionId(sessionId);
      const expiration = new Date(expiresAt);
      if (!Number.isFinite(expiration.getTime())) throw new TypeError("expiresAt must be a valid date.");
      upsertRevocation.run(sessionId, expiration.toISOString());
      return true;
    },
    async isSessionRevoked(sessionId) {
      requiredSessionId(sessionId);
      const now = new Date().toISOString();
      return Boolean(findRevoked.get(sessionId, now));
    },
  });
}
