/**
 * PostgreSQL persistence slice: Revoked-session lookups; identity-store revocation writes the rows.
 *
 * Composed by postgres.ts. Row mapping and shared SQL helpers live in
 * postgres-shared.ts so every slice reads rows the same way.
 */
import type { PostgresStoreContext } from "./postgres-shared.ts";
import type { TypedPersistenceAdapterContract } from "../application/persistence-ports.ts";

export function createPostgresSessionStore(ctx: PostgresStoreContext) {
  const { sql } = ctx;
  return Object.freeze({
    async isSessionRevoked(sessionId) {
      const rows = await sql.unsafe("SELECT 1 FROM revoked_sessions WHERE session_id = $1 AND expires_at > now()", [sessionId]);
      return rows.length > 0;
    },

  }) satisfies Pick<TypedPersistenceAdapterContract, "isSessionRevoked">;
}
