import { mkdir, readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPostgresClient } from "./postgres.ts";
import { createSqliteClient, runSqliteMigrations } from "./sqlite.ts";
import { resolveDatabaseProvider, resolvePostgresMigrationUrl, resolveSqliteDatabasePath } from "../infrastructure/database-config.ts";

const here = dirname(fileURLToPath(import.meta.url));
const defaultDirectory = join(here, "migrations");
const advisoryLockId = 87412026;
const migrationPattern = /^\d{4}_[a-z0-9_]+\.sql$/;

/**
 * Read the PostgreSQL schema version without applying anything.
 *
 * This exists because the SQLite provider refuses to boot against a database
 * whose `api_schema_migrations` table is behind the checked-in migrations, so a
 * stale local database fails loudly at startup. PostgreSQL had no such guard:
 * it booted happily and then answered 500 on whichever endpoint happened to
 * touch the missing table — a missing `featured_articles` table surfaced as an
 * unexplained `/api/v1/featured` 500 while every other route kept working,
 * which is very hard to read from an access log.
 *
 * `to_regclass` resolves through the connection's `search_path`, which is the
 * same resolution `runMigrations` gets when it runs an unqualified
 * `CREATE TABLE api_schema_migrations`; qualifying the table as
 * `public.api_schema_migrations` here would disagree with a database that
 * applies migrations under a different search path.
 */
export async function getPostgresMigrationStatus(sql, { directory = defaultDirectory } = {}) {
  const files = (await readdir(directory)).filter((name) => migrationPattern.test(name)).sort();
  if (files.length === 0) throw new Error("No versioned SQL migrations were found.");
  const [table] = await sql.unsafe("SELECT to_regclass('api_schema_migrations') IS NOT NULL AS present");
  const rows = table?.present ? await sql.unsafe("SELECT version FROM api_schema_migrations") : [];
  const appliedVersions = new Set(rows.map((row) => row.version));
  return {
    discovered: files.length,
    applied: files.filter((file) => appliedVersions.has(file.slice(0, -".sql".length))),
    pending: files.filter((file) => !appliedVersions.has(file.slice(0, -".sql".length))),
  };
}

export async function runMigrations(sql, { directory = defaultDirectory } = {}) {
  const files = (await readdir(directory)).filter((name) => migrationPattern.test(name)).sort();
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
