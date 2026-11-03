import { createPostgresProviderMigrationCapture } from "./postgres-provider-migration-capture.ts";
import type { TypedPersistenceAdapterContract } from "../application/persistence-ports.ts";

export function createPostgresSessionStore(sql: any): Partial<TypedPersistenceAdapterContract> {
  if (!sql || typeof sql.unsafe !== "function" || typeof sql.begin !== "function") {
    throw new TypeError("A postgres.js SQL client is required.");
  }
  return Object.freeze({
    async health() {
      await sql.unsafe("SELECT 1 AS ok");
      return true;
    },
    transaction(work: (client: unknown) => unknown) {
      if (typeof work !== "function") throw new TypeError("Transaction callback is required.");
      return sql.begin(work);
    },
    async isSessionRevoked(sessionId: string) {
      const rows = await sql.unsafe("SELECT 1 FROM revoked_sessions WHERE session_id = $1 AND expires_at > now()", [sessionId]);
      return (rows as unknown[]).length > 0;
    },
  });
}
