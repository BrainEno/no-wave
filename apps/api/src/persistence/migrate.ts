import { mkdir, readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPostgresClient } from "./postgres.ts";
import { createSqliteClient, runSqliteMigrations } from "./sqlite.ts";
import { resolveDatabaseProvider, resolvePostgresMigrationUrl, resolveSqliteDatabasePath } from "../infrastructure/database-config.ts";

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

export async function runConfiguredMigrations({ env = process.env } = {}) {
  const provider = resolveDatabaseProvider({ env });
  if (provider === "sqlite") {
    const filename = resolveSqliteDatabasePath({ env });
    if (filename !== ":memory:") await mkdir(dirname(filename), { recursive: true });
    const db = createSqliteClient({ filename });
    try {
      const applied = await runSqliteMigrations(db);
      const discovered = Number(db.prepare("SELECT count(*) AS count FROM api_schema_migrations").get().count);
      return { provider, discovered, applied };
    } finally {
      db.close();
    }
  }
  if (provider === "postgres") {
    let sql;
    try {
      sql = await createPostgresClient({ connectionString: resolvePostgresMigrationUrl({ env }) });
      return { provider, ...(await runMigrations(sql)) };
    } finally {
      if (sql) await sql.end({ timeout: 5 });
    }
  }
  throw new Error(`No migration runner is registered for DATABASE_PROVIDER="${provider}". No other database was modified.`);
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  try {
    const result = await runConfiguredMigrations();
    process.stdout.write(`${result.provider} migrations checked: ${result.discovered}; newly applied: ${result.applied.length}\n`);
  } catch (error) {
    process.stderr.write(`Database migration failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}
