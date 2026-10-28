/**
 * PostgreSQL identity persistence. Refresh rotation, replay detection, logout
 * and access-token revocation all serialize on the same session row.
 */
export function createPostgresIdentityStore(sql) {
  async function insertSession(tx, session) {
    await tx.unsafe(
      "INSERT INTO auth_sessions (id, user_id, expires_at) VALUES ($1, $2, $3)",
      [session.sessionId, session.userId, session.expiresAt],
    );
    await tx.unsafe(
      "INSERT INTO auth_access_tokens (token_id, session_id, expires_at) VALUES ($1, $2, $3)",
      [session.accessTokenId, session.sessionId, session.accessExpiresAt],
    );
    await tx.unsafe(
      "INSERT INTO auth_refresh_tokens (token_hash, session_id) VALUES ($1, $2)",
      [session.refreshHash, session.sessionId],
    );
  }

  async function revokeLockedSession(tx, sessionId) {
    await tx.unsafe("UPDATE auth_sessions SET revoked_at = COALESCE(revoked_at, clock_timestamp()) WHERE id = $1", [sessionId]);
    await tx.unsafe(
      `INSERT INTO revoked_sessions (session_id, expires_at)
       SELECT token_id, expires_at FROM auth_access_tokens WHERE session_id = $1
       ON CONFLICT (session_id) DO UPDATE SET
         expires_at = GREATEST(revoked_sessions.expires_at, EXCLUDED.expires_at), revoked_at = clock_timestamp()`,
      [sessionId],
    );
  }

  return Object.freeze({
    async createIdentityAccount({ userId, email, passwordHash, session }) {
      return sql.begin(async (tx) => {
        const inserted = await tx.unsafe(
          "INSERT INTO auth_accounts (user_id, email, password_hash) VALUES ($1, $2, $3) ON CONFLICT (email) DO NOTHING RETURNING user_id",
          [userId, email, passwordHash],
        );
        if (!inserted[0]) return false;
        await insertSession(tx, { ...session, userId });
        return true;
      });
    },
    async findIdentityAccount({ email }) {
      const rows = await sql.unsafe("SELECT user_id, password_hash FROM auth_accounts WHERE email = $1", [email]);
      return rows[0] ? { userId: rows[0].user_id, passwordHash: rows[0].password_hash } : null;
    },
    async createIdentitySession(session) {
      return sql.begin(async (tx) => { await insertSession(tx, session); return true; });
    },
    async rotateIdentityRefresh({ refreshHash, nextRefreshHash, accessTokenId, issuedAt, accessExpiresAt }) {
      return sql.begin(async (tx) => {
        const token = await tx.unsafe("SELECT session_id FROM auth_refresh_tokens WHERE token_hash = $1", [refreshHash]);
        if (!token[0]) return { status: "invalid" };
        const rows = await tx.unsafe(
          "SELECT id, user_id, expires_at, revoked_at FROM auth_sessions WHERE id = $1 FOR UPDATE",
          [token[0].session_id],
        );
        const session = rows[0];
        if (!session || session.revoked_at) return { status: "invalid" };
        // Evaluate the clock *after* acquiring the lock. A projection in the
        // locking SELECT can be evaluated before a long wait on another tx.
        const [clock] = await tx.unsafe("SELECT clock_timestamp() AS current_time");
        const expires = new Date(session.expires_at).getTime();
        if (expires <= new Date(clock.current_time).getTime() || expires <= new Date(issuedAt).getTime()) {
          return { status: "invalid" };
        }
        // Re-read after locking: another request may have consumed this token
        // while this transaction was waiting for the session row.
        const current = await tx.unsafe("SELECT used_at FROM auth_refresh_tokens WHERE token_hash = $1 AND session_id = $2", [refreshHash, session.id]);
        if (!current[0]) return { status: "invalid" };
        if (current[0].used_at) {
          await revokeLockedSession(tx, session.id);
          return { status: "reused" };
        }
        const cappedExpiry = new Date(Math.min(expires, new Date(accessExpiresAt).getTime()));
        // NumericDate is whole seconds: do not consume a refresh token if the
        // resulting JWT would already be expired or have exp equal to iat.
        const expirySeconds = Math.floor(cappedExpiry.getTime() / 1000);
        if (expirySeconds <= Math.max(Math.floor(new Date(issuedAt).getTime() / 1000), Math.floor(new Date(clock.current_time).getTime() / 1000))) {
          return { status: "invalid" };
        }
        await tx.unsafe("UPDATE auth_refresh_tokens SET used_at = clock_timestamp() WHERE token_hash = $1", [refreshHash]);
        await tx.unsafe("INSERT INTO auth_refresh_tokens (token_hash, session_id) VALUES ($1, $2)", [nextRefreshHash, session.id]);
        await tx.unsafe("INSERT INTO auth_access_tokens (token_id, session_id, expires_at) VALUES ($1, $2, $3)", [accessTokenId, session.id, cappedExpiry]);
        return { status: "rotated", userId: session.user_id, accessExpiresAt: cappedExpiry.toISOString(), refreshExpiresAt: new Date(session.expires_at).toISOString() };
      });
    },
    async revokeIdentityRefresh({ refreshHash }) {
      return sql.begin(async (tx) => {
        const token = await tx.unsafe("SELECT session_id FROM auth_refresh_tokens WHERE token_hash = $1", [refreshHash]);
        if (!token[0]) return true;
        const session = await tx.unsafe("SELECT id FROM auth_sessions WHERE id = $1 FOR UPDATE", [token[0].session_id]);
        if (session[0]) await revokeLockedSession(tx, session[0].id);
        return true;
      });
    },
    async revokeSession({ sessionId, expiresAt }) {
      if (typeof sessionId !== "string" || sessionId.trim().length === 0 || sessionId !== sessionId.trim()) {
        throw new TypeError("sessionId must be a non-empty, trimmed string.");
      }
      const expiration = new Date(expiresAt);
      if (!Number.isFinite(expiration.getTime())) throw new TypeError("expiresAt must be a valid date.");
      return sql.begin(async (tx) => {
        const access = await tx.unsafe("SELECT session_id FROM auth_access_tokens WHERE token_id = $1", [sessionId]);
        if (access[0]) {
          const session = await tx.unsafe("SELECT id FROM auth_sessions WHERE id = $1 FOR UPDATE", [access[0].session_id]);
          if (session[0]) await revokeLockedSession(tx, session[0].id);
        }
        // Also preserve existing behavior for independently issued JWTs.
        await tx.unsafe(
          "INSERT INTO revoked_sessions (session_id, expires_at) VALUES ($1, $2) ON CONFLICT (session_id) DO UPDATE SET expires_at = GREATEST(revoked_sessions.expires_at, EXCLUDED.expires_at), revoked_at = clock_timestamp()",
          [sessionId, expiration],
        );
        return true;
      });
    },
    async pruneExpiredIdentityState() {
      return sql.begin(async (tx) => {
        const sessions = await tx.unsafe(`WITH expired AS (
          SELECT s.id FROM auth_sessions s
          WHERE s.expires_at < clock_timestamp() - interval '24 hours'
            AND NOT EXISTS (SELECT 1 FROM auth_access_tokens a WHERE a.session_id = s.id AND a.expires_at > clock_timestamp())
          ORDER BY s.expires_at LIMIT 100 FOR UPDATE OF s SKIP LOCKED
        ) DELETE FROM auth_sessions WHERE id IN (SELECT id FROM expired) RETURNING id`);
        const limits = await tx.unsafe(`WITH expired AS (
          SELECT key FROM auth_rate_limits WHERE reset_at < clock_timestamp()
          ORDER BY reset_at LIMIT 512 FOR UPDATE SKIP LOCKED
        ) DELETE FROM auth_rate_limits WHERE key IN (SELECT key FROM expired)
          AND reset_at < clock_timestamp() RETURNING key`);
        // Expired revocations are no longer consulted by isSessionRevoked.
        // Keep cleanup bounded and skip rows another maintenance transaction holds.
        const revokedSessions = await tx.unsafe(`WITH expired AS (
          SELECT session_id FROM revoked_sessions WHERE expires_at <= clock_timestamp()
          ORDER BY expires_at LIMIT 512 FOR UPDATE SKIP LOCKED
        ) DELETE FROM revoked_sessions WHERE session_id IN (SELECT session_id FROM expired)
          AND expires_at <= clock_timestamp() RETURNING session_id`);
        return { sessions: sessions.length, rateLimits: limits.length, revokedSessions: revokedSessions.length };
      });
    },
    async consumeIdentityRateLimit({ key, limit, windowSeconds }) {
      const rows = await sql.unsafe(
        `INSERT INTO auth_rate_limits (key, attempts, reset_at)
         VALUES ($1, 1, statement_timestamp() + ($2 * interval '1 second'))
         ON CONFLICT (key) DO UPDATE SET
           attempts = CASE WHEN auth_rate_limits.reset_at <= statement_timestamp() THEN 1
                           WHEN auth_rate_limits.attempts >= $3 THEN $3 ELSE auth_rate_limits.attempts + 1 END,
           reset_at = CASE WHEN auth_rate_limits.reset_at <= statement_timestamp() THEN statement_timestamp() + ($2 * interval '1 second') ELSE auth_rate_limits.reset_at END
         RETURNING attempts, reset_at`,
        [key, windowSeconds, limit + 1],
      );
      return { allowed: Number(rows[0].attempts) <= limit, resetAt: new Date(rows[0].reset_at).toISOString() };
    },
  });
}
