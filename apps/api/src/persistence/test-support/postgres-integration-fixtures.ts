/**
 * Shared harness for the pg-integration suites. Not a test file: node:test
 * discovers only `*.test.ts`; each suite imports what it needs from here.
 */

import { createPostgresClient, createPostgresStore } from "../postgres.ts";

import { runMigrations } from "../migrate.ts";

import { after, before } from "node:test";

export const connectionString = process.env.TEST_DATABASE_URL;

export const integrationOptions = { skip: !connectionString && "Set TEST_DATABASE_URL to run PostgreSQL integration tests." };

export let sql!: Awaited<ReturnType<typeof createPostgresClient>>;

export let store!: ReturnType<typeof createPostgresStore>;

export function registerPostgresIntegration(): void {
  before(async () => {
    if (!connectionString) return;
    sql = await createPostgresClient({ connectionString, max: 4 });
    await runMigrations(sql);
    store = createPostgresStore(sql);
  });

  after(async () => { if (sql) await sql.end({ timeout: 5 }); });
}
