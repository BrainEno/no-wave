/** SQLite identity contract adapter, composed by sqlite-store.ts. */
export function createSqliteIdentityStore(db) {
  if (!db || typeof db.prepare !== "function" || typeof db.exec !== "function") throw new TypeError("A SQLite database connection is required.");
  const run = (sql, ...args) => db.prepare(sql).run(...args);
  const get = (sql, ...args) => db.prepare(sql).get(...args);
  function transaction(work) {
    db.exec("BEGIN IMMEDIATE");
    try { const result = work(); db.exec("COMMIT"); return result; }
    catch (error) { try { db.exec("ROLLBACK"); } catch {} throw error; }
  }
  function insertSession(session) {
    run("INSERT INTO auth_sessions (id, user_id, expires_at) VALUES (?, ?, ?)", session.sessionId, session.userId, new Date(session.expiresAt).toISOString());
    run("INSERT INTO auth_access_tokens (token_id, session_id, expires_at) VALUES (?, ?, ?)", session.accessTokenId, session.sessionId, new Date(session.accessExpiresAt).toISOString());
    run("INSERT INTO auth_refresh_tokens (token_hash, session_id) VALUES (?, ?)", session.refreshHash, session.sessionId);
  }
  function revokeSessionFamily(sessionId) {
    run("UPDATE auth_sessions SET revoked_at = COALESCE(revoked_at, strftime('%Y-%m-%dT%H:%M:%fZ','now')) WHERE id = ?", sessionId);
    run(`INSERT INTO revoked_sessions (session_id, expires_at)
      SELECT token_id, expires_at FROM auth_access_tokens WHERE session_id = ?
      ON CONFLICT (session_id) DO UPDATE SET
        expires_at = CASE WHEN excluded.expires_at > revoked_sessions.expires_at THEN excluded.expires_at ELSE revoked_sessions.expires_at END,
        revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`, sessionId);
  }
  return Object.freeze({
    async createIdentityAccount({ userId, email, passwordHash, session }) {
      return transaction(() => {
        const result = run("INSERT INTO auth_accounts (user_id,email,password_hash) VALUES (?, ?, ?) ON CONFLICT(email) DO NOTHING", userId, email, passwordHash);
        if (Number(result.changes) === 0) return false;
        insertSession({ ...session, userId });
        return true;
      });
    },
    async findIdentityAccount({ email }) {
      const row = get("SELECT user_id, password_hash FROM auth_accounts WHERE email = ?", email);
      return row ? { userId: row.user_id, passwordHash: row.password_hash } : null;
    },
    async createIdentitySession(session) {
      return transaction(() => { insertSession(session); return true; });
    },
    async rotateIdentityRefresh({ refreshHash, nextRefreshHash, accessTokenId, issuedAt, accessExpiresAt }) {
      return transaction(() => {
        const token = get("SELECT session_id, used_at FROM auth_refresh_tokens WHERE token_hash = ?", refreshHash);
        if (!token) return { status: "invalid" };
        const session = get("SELECT id, user_id, expires_at, revoked_at FROM auth_sessions WHERE id = ?", token.session_id);
        const expires = session && new Date(session.expires_at).getTime();
        if (!session || session.revoked_at || expires <= Date.now() || expires <= new Date(issuedAt).getTime()) return { status: "invalid" };
        if (token.used_at) {
          revokeSessionFamily(session.id);
          return { status: "reused" };
        }
        const cappedExpiry = new Date(Math.min(expires, new Date(accessExpiresAt).getTime()));
        const expirySeconds = Math.floor(cappedExpiry.getTime() / 1000);
        if (expirySeconds <= Math.max(Math.floor(new Date(issuedAt).getTime() / 1000), Math.floor(Date.now() / 1000))) return { status: "invalid" };
        run("UPDATE auth_refresh_tokens SET used_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE token_hash = ?", refreshHash);
        run("INSERT INTO auth_refresh_tokens (token_hash, session_id) VALUES (?, ?)", nextRefreshHash, session.id);
        run("INSERT INTO auth_access_tokens (token_id, session_id, expires_at) VALUES (?, ?, ?)", accessTokenId, session.id, cappedExpiry.toISOString());
        return { status: "rotated", userId: session.user_id, accessExpiresAt: cappedExpiry.toISOString(), refreshExpiresAt: new Date(session.expires_at).toISOString() };
      });
    },
    async revokeIdentityRefresh({ refreshHash }) {
      return transaction(() => {
        const token = get("SELECT session_id FROM auth_refresh_tokens WHERE token_hash = ?", refreshHash);
        if (token) revokeSessionFamily(token.session_id);
        return true;
      });
    },
    async revokeSession({ sessionId, expiresAt }) {
      if (typeof sessionId !== "string" || sessionId.trim().length === 0 || sessionId !== sessionId.trim()) throw new TypeError("sessionId must be a non-empty, trimmed string.");
      const expiration = new Date(expiresAt);
      if (!Number.isFinite(expiration.getTime())) throw new TypeError("expiresAt must be a valid date.");
      return transaction(() => {
        const access = get("SELECT session_id FROM auth_access_tokens WHERE token_id = ?", sessionId);
        if (access) revokeSessionFamily(access.session_id);
        run(`INSERT INTO revoked_sessions (session_id, expires_at) VALUES (?, ?)
          ON CONFLICT (session_id) DO UPDATE SET
            expires_at = CASE WHEN excluded.expires_at > revoked_sessions.expires_at THEN excluded.expires_at ELSE revoked_sessions.expires_at END,
            revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`, sessionId, expiration.toISOString());
        return true;
      });
    },
    async pruneExpiredIdentityState() {
      return transaction(() => {
        const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
        const now = new Date().toISOString();
        const sessions = run(`DELETE FROM auth_sessions WHERE id IN (
          SELECT s.id FROM auth_sessions s WHERE s.expires_at < ?
          AND NOT EXISTS (SELECT 1 FROM auth_access_tokens a WHERE a.session_id = s.id AND a.expires_at > ?)
          ORDER BY s.expires_at LIMIT 100)`, cutoff, now);
        const limits = run("DELETE FROM auth_rate_limits WHERE key IN (SELECT key FROM auth_rate_limits WHERE reset_at < ? ORDER BY reset_at LIMIT 512)", now);
        // Expired revocations are no longer consulted by isSessionRevoked.
        // BEGIN IMMEDIATE serializes this bounded cleanup with concurrent writers.
        const revokedSessions = run("DELETE FROM revoked_sessions WHERE session_id IN (SELECT session_id FROM revoked_sessions WHERE expires_at <= ? ORDER BY expires_at LIMIT 512)", now);
        return {
          sessions: Number(sessions.changes),
          rateLimits: Number(limits.changes),
          revokedSessions: Number(revokedSessions.changes),
        };
      });
    },
    async consumeIdentityRateLimit({ key, limit, windowSeconds }) {
      const now = new Date().toISOString();
      const resetAt = new Date(Date.now() + windowSeconds * 1000).toISOString();
      const row = get(`INSERT INTO auth_rate_limits (key, attempts, reset_at) VALUES (?, 1, ?)
        ON CONFLICT (key) DO UPDATE SET
          attempts = CASE WHEN auth_rate_limits.reset_at <= ? THEN 1
                          WHEN auth_rate_limits.attempts >= ? THEN ? ELSE auth_rate_limits.attempts + 1 END,
          reset_at = CASE WHEN auth_rate_limits.reset_at <= ? THEN excluded.reset_at ELSE auth_rate_limits.reset_at END
        RETURNING attempts, reset_at`, key, resetAt, now, limit + 1, limit + 1, now);
      return { allowed: Number(row.attempts) <= limit, resetAt: row.reset_at };
    },
  });
}
