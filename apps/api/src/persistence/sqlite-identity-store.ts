import { createMigrationTransactionId } from "./provider-migration-journal.ts";
import { createSqliteProviderMigrationCapture, migrationEntityKey, type CapturedChange } from "./sqlite-provider-migration-capture.ts";
import { DEFAULT_AUTHOR_DISPLAY_NAME } from "../domain/profile.ts";
import type { TypedPersistenceAdapterContract } from "../application/persistence-adapter.ts";

/** SQLite identity contract adapter, composed by sqlite-store.ts. */
export function createSqliteIdentityStore(db): Pick<TypedPersistenceAdapterContract, "createIdentityAccount" | "findIdentityAccount" | "createIdentitySession" | "rotateIdentityRefresh" | "revokeIdentityRefresh" | "revokeSession" | "issueIdentityToken" | "consumeIdentityToken" | "replaceIdentityPassword" | "listIdentitySessions" | "revokeIdentitySession" | "revokeIdentitySessions" | "markIdentityEmailVerified" | "findIdentityAccountByUserId" | "setIdentityEmail" | "findIdentityCredentials" | "pruneExpiredIdentityState" | "consumeRateLimit"> {
  if (!db || typeof db.prepare !== "function" || typeof db.exec !== "function") throw new TypeError("A SQLite database connection is required.");
  const run = (sql, ...args) => db.prepare(sql).run(...args);
  const get = (sql, ...args) => db.prepare(sql).get(...args);
  const all = (sql, ...args) => db.prepare(sql).all(...args);
  const migrationCapture = createSqliteProviderMigrationCapture(db);
  function transaction(work) {
    const transactionId = createMigrationTransactionId();
    db.exec("BEGIN IMMEDIATE");
    try { const result = work(transactionId); db.exec("COMMIT"); return result; }
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

  function captureSessionSnapshot(transactionId, sessionId) {
    const changes: CapturedChange[] = [];
    const session = get("SELECT * FROM auth_sessions WHERE id = ?", sessionId);
    const accessTokens = all("SELECT * FROM auth_access_tokens WHERE session_id = ?", sessionId);
    const refreshTokens = all("SELECT * FROM auth_refresh_tokens WHERE session_id = ?", sessionId);
    if (session) changes.push({ entityType: "auth_sessions", entityId: session.id, operation: "upsert", payload: session });
    changes.push(...accessTokens.map((row) => ({ entityType: "auth_access_tokens", entityId: row.token_id, operation: "upsert" as const, payload: row })));
    changes.push(...refreshTokens.map((row) => ({ entityType: "auth_refresh_tokens", entityId: row.token_hash, operation: "upsert" as const, payload: row })));
    const tokenIds = accessTokens.map((row) => row.token_id);
    const revoked = tokenIds.length
      ? all("SELECT * FROM revoked_sessions WHERE session_id = ? OR session_id IN (" + tokenIds.map(() => "?").join(",") + ")", sessionId, ...tokenIds)
      : all("SELECT * FROM revoked_sessions WHERE session_id = ?", sessionId);
    changes.push(...revoked.map((row) => ({ entityType: "revoked_sessions", entityId: row.session_id, operation: "upsert" as const, payload: row })));
    migrationCapture.captureInTransaction(db, transactionId, changes);
  }
  return Object.freeze({
    async createIdentityAccount({ userId, email, passwordHash, session, displayName = DEFAULT_AUTHOR_DISPLAY_NAME }) {
      return transaction((transactionId) => {
        const result = run("INSERT INTO auth_accounts (user_id,email,password_hash) VALUES (?, ?, ?) ON CONFLICT(email) DO NOTHING", userId, email, passwordHash);
        if (Number(result.changes) === 0) return false;
        insertSession({ ...session, userId });
        // A profile is part of the account, not a separate request the browser
        // might forget: without it REST serializes author: null and the public
        // reader filters the work out. ON CONFLICT keeps legacy profiles intact.
        run("INSERT INTO user_profiles (user_id) VALUES (?) ON CONFLICT(user_id) DO NOTHING", userId);
        run("INSERT INTO user_profile_translations (user_id, locale, display_name, bio) VALUES (?, 'zh-CN', ?, '') ON CONFLICT(user_id, locale) DO NOTHING", userId, displayName);
        migrationCapture.captureInTransaction(db, transactionId, [
          { entityType: "auth_accounts", entityId: userId, operation: "upsert", payload: get("SELECT * FROM auth_accounts WHERE user_id = ?", userId) },
          { entityType: "user_profiles", entityId: userId, operation: "upsert", payload: get("SELECT * FROM user_profiles WHERE user_id = ?", userId) },
          { entityType: "user_profile_translations", entityId: migrationEntityKey(userId, "zh-CN"), operation: "upsert", payload: get("SELECT * FROM user_profile_translations WHERE user_id = ? AND locale = ?", userId, "zh-CN") },
        ]);
        captureSessionSnapshot(transactionId, session.sessionId);
        return true;
      });
    },
    async findIdentityAccount({ email }) {
      const row = get("SELECT user_id, password_hash FROM auth_accounts WHERE email = ?", email);
      return row ? { userId: row.user_id, passwordHash: row.password_hash } : null;
    },
    async createIdentitySession(session) {
      return transaction((transactionId) => {
        insertSession(session);
        captureSessionSnapshot(transactionId, session.sessionId);
        return true;
      });
    },
    async rotateIdentityRefresh({ refreshHash, nextRefreshHash, accessTokenId, issuedAt, accessExpiresAt }) {
      return transaction((transactionId) => {
        const token = get("SELECT session_id, used_at FROM auth_refresh_tokens WHERE token_hash = ?", refreshHash);
        if (!token) return { status: "invalid" };
        const session = get("SELECT id, user_id, expires_at, revoked_at FROM auth_sessions WHERE id = ?", token.session_id);
        const expires = session && new Date(session.expires_at).getTime();
        if (!session || session.revoked_at || expires <= Date.now() || expires <= new Date(issuedAt).getTime()) return { status: "invalid" };
        if (token.used_at) {
          revokeSessionFamily(session.id);
          captureSessionSnapshot(transactionId, session.id);
          return { status: "reused" };
        }
        const cappedExpiry = new Date(Math.min(expires, new Date(accessExpiresAt).getTime()));
        const expirySeconds = Math.floor(cappedExpiry.getTime() / 1000);
        if (expirySeconds <= Math.max(Math.floor(new Date(issuedAt).getTime() / 1000), Math.floor(Date.now() / 1000))) return { status: "invalid" };
        run("UPDATE auth_refresh_tokens SET used_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE token_hash = ?", refreshHash);
        run("INSERT INTO auth_refresh_tokens (token_hash, session_id) VALUES (?, ?)", nextRefreshHash, session.id);
        run("INSERT INTO auth_access_tokens (token_id, session_id, expires_at) VALUES (?, ?, ?)", accessTokenId, session.id, cappedExpiry.toISOString());
        migrationCapture.captureInTransaction(db, transactionId, [
          { entityType: "auth_refresh_tokens", entityId: refreshHash, operation: "upsert", payload: get("SELECT * FROM auth_refresh_tokens WHERE token_hash = ?", refreshHash) },
          { entityType: "auth_refresh_tokens", entityId: nextRefreshHash, operation: "upsert", payload: get("SELECT * FROM auth_refresh_tokens WHERE token_hash = ?", nextRefreshHash) },
          { entityType: "auth_access_tokens", entityId: accessTokenId, operation: "upsert", payload: get("SELECT * FROM auth_access_tokens WHERE token_id = ?", accessTokenId) },
        ]);
        return { status: "rotated", userId: session.user_id, sessionId: session.id, accessExpiresAt: cappedExpiry.toISOString(), refreshExpiresAt: new Date(session.expires_at).toISOString() };
      });
    },
    async revokeIdentityRefresh({ refreshHash }) {
      return transaction((transactionId) => {
        const token = get("SELECT session_id FROM auth_refresh_tokens WHERE token_hash = ?", refreshHash);
        if (token) {
          revokeSessionFamily(token.session_id);
          captureSessionSnapshot(transactionId, token.session_id);
        }
        return true;
      });
    },
    async revokeSession({ sessionId, expiresAt }) {
      if (typeof sessionId !== "string" || sessionId.trim().length === 0 || sessionId !== sessionId.trim()) throw new TypeError("sessionId must be a non-empty, trimmed string.");
      const expiration = new Date(expiresAt);
      if (!Number.isFinite(expiration.getTime())) throw new TypeError("expiresAt must be a valid date.");
      return transaction((transactionId) => {
        const access = get("SELECT session_id FROM auth_access_tokens WHERE token_id = ?", sessionId);
        if (access) revokeSessionFamily(access.session_id);
        run(`INSERT INTO revoked_sessions (session_id, expires_at) VALUES (?, ?)
          ON CONFLICT (session_id) DO UPDATE SET
            expires_at = CASE WHEN excluded.expires_at > revoked_sessions.expires_at THEN excluded.expires_at ELSE revoked_sessions.expires_at END,
            revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`, sessionId, expiration.toISOString());
        if (access) captureSessionSnapshot(transactionId, access.session_id);
        migrationCapture.captureInTransaction(db, transactionId, [
          { entityType: "revoked_sessions", entityId: sessionId, operation: "upsert", payload: get("SELECT * FROM revoked_sessions WHERE session_id = ?", sessionId) },
        ]);
        return true;
      });
    },
    async issueIdentityToken({ userId, purpose, email, tokenHash, expiresAt }) {
      if (typeof tokenHash !== "string" || tokenHash.length !== 64) throw new TypeError("tokenHash must be a 64-character hex digest.");
      if (purpose !== "password_reset" && purpose !== "email_verification") throw new TypeError("purpose must be a supported identity token purpose.");
      return transaction((transactionId) => {
        // Only one live token per purpose: two outstanding reset links is a
        // support problem and doubles the surface a phished mailbox exposes.
        run("DELETE FROM auth_identity_tokens WHERE user_id = ? AND purpose = ?", userId, purpose);
        run("INSERT INTO auth_identity_tokens (token_hash, user_id, purpose, email, expires_at) VALUES (?, ?, ?, ?, ?)",
          tokenHash, userId, purpose, email, new Date(expiresAt).toISOString());
        migrationCapture.captureInTransaction(db, transactionId, [
          { entityType: "auth_identity_tokens", entityId: tokenHash, operation: "upsert", payload: get("SELECT * FROM auth_identity_tokens WHERE token_hash = ?", tokenHash) },
        ]);
        return true;
      });
    },
    async consumeIdentityToken({ tokenHash, purpose }) {
      // Single use, and decided by the UPDATE rather than by the SELECT that
      // preceded it: two redemptions racing on one link must not both win.
      return transaction((transactionId) => {
        const row = get("SELECT user_id, email, expires_at, consumed_at FROM auth_identity_tokens WHERE token_hash = ? AND purpose = ?", tokenHash, purpose);
        if (!row || row.consumed_at) return null;
        if (new Date(row.expires_at).getTime() <= Date.now()) return null;
        const result = run("UPDATE auth_identity_tokens SET consumed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE token_hash = ? AND consumed_at IS NULL", tokenHash);
        if (Number(result.changes) === 0) return null;
        migrationCapture.captureInTransaction(db, transactionId, [
          { entityType: "auth_identity_tokens", entityId: tokenHash, operation: "upsert", payload: get("SELECT * FROM auth_identity_tokens WHERE token_hash = ?", tokenHash) },
        ]);
        return { userId: row.user_id, email: row.email };
      });
    },
    /**
     * Replace a password and end the sessions that did not ask for it, in one
     * transaction.
     *
     * A password reset has to answer "what about the device that stole it" —
     * without this, the thief stays signed in for the rest of the refresh
     * lifetime. A password *change* made from inside a session spares that one
     * (`exceptSessionId`): it is the device that proved it knew the old
     * password, and it must not be signed out by the very request it made.
     *
     * The order inside the transaction matters as much as the transaction. The
     * sessions go first, so a failure leaves the old credential in place with
     * the other devices already out — an inconvenience. The reverse order would
     * leave a new credential behind with the old sessions still live, which is
     * the one state a password change exists to prevent.
     */
    async replaceIdentityPassword({ userId, passwordHash, exceptSessionId = null }) {
      return transaction((transactionId) => {
        const sessionIds = all("SELECT id FROM auth_sessions WHERE user_id = ? AND revoked_at IS NULL", userId)
          .map((row) => row.id)
          .filter((id) => id !== exceptSessionId);
        for (const sessionId of sessionIds) {
          revokeSessionFamily(sessionId);
          captureSessionSnapshot(transactionId, sessionId);
        }
        const result = run("UPDATE auth_accounts SET password_hash = ? WHERE user_id = ?", passwordHash, userId);
        migrationCapture.captureInTransaction(db, transactionId, [
          { entityType: "auth_accounts", entityId: userId, operation: "upsert", payload: get("SELECT * FROM auth_accounts WHERE user_id = ?", userId) },
        ]);
        return { updated: Number(result.changes) > 0, revokedSessions: sessionIds.length };
      });
    },
    /**
     * The devices this account is signed in on, newest first.
     *
     * Only sessions that are still live: a revoked one cannot be used and an
     * expired one is not a device, so neither belongs in a list somebody is
     * asked to choose from. `lastUsedAt` is the last time the session refreshed
     * — the closest thing to "in use" that a store holding no device
     * fingerprints can honestly claim — and is null until the first refresh.
     */
    async listIdentitySessions({ userId, limit }) {
      const rows = all(
        `SELECT s.id AS session_id, s.created_at, s.expires_at,
                (SELECT MAX(t.used_at) FROM auth_refresh_tokens t WHERE t.session_id = s.id) AS last_used_at
           FROM auth_sessions s
          WHERE s.user_id = ? AND s.revoked_at IS NULL AND s.expires_at > ?
          -- The subquery is repeated rather than aliased: PostgreSQL resolves a
          -- bare alias in ORDER BY but not one wrapped in an expression, and
          -- both providers have to answer the same question.
          ORDER BY COALESCE((SELECT MAX(t.used_at) FROM auth_refresh_tokens t WHERE t.session_id = s.id), s.created_at) DESC
          LIMIT ?`,
        userId, new Date().toISOString(), Math.max(1, Math.min(limit, 200)),
      );
      return rows.map((row) => ({
        sessionId: row.session_id,
        createdAt: new Date(row.created_at).toISOString(),
        lastUsedAt: row.last_used_at ? new Date(row.last_used_at).toISOString() : null,
        expiresAt: new Date(row.expires_at).toISOString(),
      }));
    },
    /**
     * End one device.
     *
     * Scoped to the account that asks: a session id belonging to somebody else
     * answers `false` rather than being ended, so guessing ids reveals nothing
     * and harms nobody. `false` also covers "already ended" and "expired" —
     * from the owner's point of view the device is gone either way.
     */
    async revokeIdentitySession({ userId, sessionId }) {
      return transaction((transactionId) => {
        const session = get(
          "SELECT id FROM auth_sessions WHERE id = ? AND user_id = ? AND revoked_at IS NULL AND expires_at > ?",
          sessionId, userId, new Date().toISOString(),
        );
        if (!session) return false;
        revokeSessionFamily(sessionId);
        captureSessionSnapshot(transactionId, sessionId);
        return true;
      });
    },
    /** End every other device of this account, and say how many that was. */
    async revokeIdentitySessions({ userId, exceptSessionId = null }) {
      return transaction((transactionId) => {
        const sessionIds = all(
          "SELECT id FROM auth_sessions WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ?",
          userId, new Date().toISOString(),
        )
          .map((row) => row.id)
          .filter((id) => id !== exceptSessionId);
        for (const sessionId of sessionIds) {
          revokeSessionFamily(sessionId);
          captureSessionSnapshot(transactionId, sessionId);
        }
        return sessionIds.length;
      });
    },
    async markIdentityEmailVerified({ userId, verifiedAt }) {
      return transaction((transactionId) => {
        const result = run("UPDATE auth_accounts SET email_verified_at = COALESCE(email_verified_at, ?) WHERE user_id = ?", new Date(verifiedAt).toISOString(), userId);
        migrationCapture.captureInTransaction(db, transactionId, [
          { entityType: "auth_accounts", entityId: userId, operation: "upsert", payload: get("SELECT * FROM auth_accounts WHERE user_id = ?", userId) },
        ]);
        return Number(result.changes) > 0;
      });
    },
    async findIdentityAccountByUserId({ userId }) {
      const row = get("SELECT user_id, email, email_verified_at FROM auth_accounts WHERE user_id = ?", userId);
      return row ? { userId: row.user_id, email: row.email, emailVerifiedAt: row.email_verified_at ? new Date(row.email_verified_at).toISOString() : null } : null;
    },
    /**
     * Move an account to another address, and drop the proof of the old one.
     *
     * `OR IGNORE` is the whole point: the unique index on `email` decides
     * whether the update happened, so two callers racing for one address get
     * one winner and one `false` instead of a constraint error nobody mapped.
     * `false` therefore means "that address belongs to somebody else" — the
     * caller has already established that this account exists and has already
     * normalised the address, so there is no second meaning left.
     */
    async setIdentityEmail({ userId, email }) {
      return transaction((transactionId) => {
        const result = run("UPDATE OR IGNORE auth_accounts SET email = ?, email_verified_at = NULL WHERE user_id = ?", email, userId);
        if (Number(result.changes) === 0) return false;
        migrationCapture.captureInTransaction(db, transactionId, [
          { entityType: "auth_accounts", entityId: userId, operation: "upsert", payload: get("SELECT * FROM auth_accounts WHERE user_id = ?", userId) },
        ]);
        return true;
      });
    },
    /**
     * The password hash of one account, on its own.
     *
     * A separate accessor from `findIdentityAccountByUserId` on purpose: the
     * account record is what the application shows the owner, and the
     * credential is what it verifies against. Keeping them apart means a
     * future caller that forwards "the account" to a response cannot forward
     * the hash with it.
     */
    async findIdentityCredentials({ userId }) {
      const row = get("SELECT user_id, password_hash FROM auth_accounts WHERE user_id = ?", userId);
      return row ? { userId: row.user_id, passwordHash: row.password_hash } : null;
    },
    async pruneExpiredIdentityState() {
      return transaction((transactionId) => {
        const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
        const now = new Date().toISOString();
        const expiredSessionIds = all(`SELECT s.id FROM auth_sessions s WHERE s.expires_at < ?
          AND NOT EXISTS (SELECT 1 FROM auth_access_tokens a WHERE a.session_id = s.id AND a.expires_at > ?)
          ORDER BY s.expires_at LIMIT 100`, cutoff, now).map((row) => row.id);
        const expiredLimits = all("SELECT * FROM auth_rate_limits WHERE reset_at < ? ORDER BY reset_at LIMIT 512", now);
        const expiredRevocations = all("SELECT * FROM revoked_sessions WHERE expires_at <= ? ORDER BY expires_at LIMIT 512", now);
        const expiredTokens = all("SELECT * FROM auth_identity_tokens WHERE expires_at <= ? ORDER BY expires_at LIMIT 512", now);
        const changes: CapturedChange[] = [];
        for (const sessionId of expiredSessionIds) {
          changes.push({ entityType: "auth_sessions", entityId: sessionId, operation: "delete", payload: null });
          for (const row of all("SELECT token_id FROM auth_access_tokens WHERE session_id = ?", sessionId)) {
            changes.push({ entityType: "auth_access_tokens", entityId: row.token_id, operation: "delete", payload: null });
          }
          for (const row of all("SELECT token_hash FROM auth_refresh_tokens WHERE session_id = ?", sessionId)) {
            changes.push({ entityType: "auth_refresh_tokens", entityId: row.token_hash, operation: "delete", payload: null });
          }
        }
        for (const row of expiredLimits) changes.push({ entityType: "auth_rate_limits", entityId: row.key, operation: "delete", payload: null });
        for (const row of expiredRevocations) changes.push({ entityType: "revoked_sessions", entityId: row.session_id, operation: "delete", payload: null });
        for (const row of expiredTokens) changes.push({ entityType: "auth_identity_tokens", entityId: row.token_hash, operation: "delete", payload: null });
        const sessions = run(`DELETE FROM auth_sessions WHERE id IN (
          SELECT s.id FROM auth_sessions s WHERE s.expires_at < ?
          AND NOT EXISTS (SELECT 1 FROM auth_access_tokens a WHERE a.session_id = s.id AND a.expires_at > ?)
          ORDER BY s.expires_at LIMIT 100)`, cutoff, now);
        const limits = run("DELETE FROM auth_rate_limits WHERE key IN (SELECT key FROM auth_rate_limits WHERE reset_at < ? ORDER BY reset_at LIMIT 512)", now);
        // Expired revocations are no longer consulted by isSessionRevoked.
        // BEGIN IMMEDIATE serializes this bounded cleanup with concurrent writers.
        const revokedSessions = run("DELETE FROM revoked_sessions WHERE session_id IN (SELECT session_id FROM revoked_sessions WHERE expires_at <= ? ORDER BY expires_at LIMIT 512)", now);
        migrationCapture.captureInTransaction(db, transactionId, changes);
        const tokens = run("DELETE FROM auth_identity_tokens WHERE token_hash IN (SELECT token_hash FROM auth_identity_tokens WHERE expires_at <= ? ORDER BY expires_at LIMIT 512)", now);
        return {
          sessions: Number(sessions.changes),
          rateLimits: Number(limits.changes),
          revokedSessions: Number(revokedSessions.changes),
          identityTokens: Number(tokens.changes),
        };
      });
    },
    async consumeRateLimit({ key, limit, windowSeconds }) {
      return transaction((transactionId) => {
        const now = new Date().toISOString();
        const resetAt = new Date(Date.now() + windowSeconds * 1000).toISOString();
        const row = get(`INSERT INTO auth_rate_limits (key, attempts, reset_at) VALUES (?, 1, ?)
          ON CONFLICT (key) DO UPDATE SET
            attempts = CASE WHEN auth_rate_limits.reset_at <= ? THEN 1
                            WHEN auth_rate_limits.attempts >= ? THEN ? ELSE auth_rate_limits.attempts + 1 END,
            reset_at = CASE WHEN auth_rate_limits.reset_at <= ? THEN excluded.reset_at ELSE auth_rate_limits.reset_at END
          RETURNING attempts, reset_at`, key, resetAt, now, limit + 1, limit + 1, now);
        migrationCapture.captureInTransaction(db, transactionId, [
          { entityType: "auth_rate_limits", entityId: key, operation: "upsert", payload: get("SELECT * FROM auth_rate_limits WHERE key = ?", key) },
        ]);
        return { allowed: Number(row.attempts) <= limit, resetAt: row.reset_at };
      });
    },
  });
}
