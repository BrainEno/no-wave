import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPostgresClient } from "./postgres.ts";

const here = dirname(fileURLToPath(import.meta.url));
const defaultDirectory = join(here, "migrations");
const advisoryLockId = 87412026;

export async function runMigrations(sql, { directory = defaultDirectory } = {}) {
  const files = (await readdir(directory)).filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/.test(name)).sort();
  if (files.length === 0) throw new Error("No versioned SQL migrations were found.");
  const applied = [];

  await sql.begin(async (tx) => {
    await tx.unsafe("SELECT pg_advisory_xact_lock($1)", [advisoryLockId]);
    await tx.unsafe("CREATE TABLE IF NOT EXISTS api_schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
  });

  for (const file of files) {
    const version = file.slice(0, -".sql".length);
    const source = await readFile(join(directory, file), "utf8");
    let wasApplied = false;
    await sql.begin(async (tx) => {
      await tx.unsafe("SELECT pg_advisory_xact_lock($1)", [advisoryLockId]);
      const rows = await tx.unsafe("SELECT version FROM api_schema_migrations WHERE version = $1", [version]);
      if (rows.length) return;
      await tx.unsafe(source);
      await tx.unsafe("INSERT INTO api_schema_migrations (version) VALUES ($1)", [version]);
      wasApplied = true;
    });
    if (wasApplied) applied.push(version);
  }
  return { discovered: files.length, applied };
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  let sql;
  try {
    sql = await createPostgresClient();
    const result = await runMigrations(sql);
    process.stdout.write(`PostgreSQL migrations checked: ${result.discovered}; newly applied: ${result.applied.length}\n`);
  } catch (error) {
    process.stderr.write(`PostgreSQL migration failed: ${error.message}\n`);
    process.exitCode = 1;
  } finally {
    if (sql) await sql.end({ timeout: 5 });
  }
}
