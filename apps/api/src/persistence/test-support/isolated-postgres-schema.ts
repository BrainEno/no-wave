import { randomUUID } from "node:crypto";
import { runMigrations } from "../migrate.ts";
import { createPostgresClient } from "../postgres.ts";
import type { PgDatabase } from "../postgres-driver.ts";

/** A disposable, fully migrated schema independent of other tests' fixtures. */
export async function createIsolatedPostgresTestSchema(connectionString: string): Promise<{ sql: PgDatabase; cleanup(): Promise<void> }> {
  const admin = await createPostgresClient({ connectionString, max: 1 });
  const schema = `nw_replay_${randomUUID().replaceAll("-", "")}`;
  let isolated: PgDatabase | undefined;
  let created = false;
  try {
    // Install the shared extension in public without migrating public tables;
    // dropping this isolated schema must not remove an extension other tests use.
    await admin.unsafe("CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public");
    await admin.unsafe(`CREATE SCHEMA ${schema}`);
    created = true;
    const { default: postgres } = await import("postgres");
    isolated = postgres(connectionString, { max: 8, connection: { search_path: `${schema},public`, application_name: "bot-thk-replay-tests" } });
    await runMigrations(isolated);
    const sql = isolated;
    return {
      sql,
      async cleanup() {
        await sql.end({ timeout: 5 });
        try {
          await admin.unsafe("SET client_min_messages TO WARNING");
          await admin.unsafe(`DROP SCHEMA ${schema} CASCADE`);
        } finally { await admin.end({ timeout: 5 }); }
      },
    };
  } catch (error) {
    if (isolated) await isolated.end({ timeout: 5 });
    if (created) await admin.unsafe(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end({ timeout: 5 });
    throw error;
  }
}
