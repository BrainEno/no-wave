import { DatabaseSync } from "node:sqlite";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const defaultDirectory = join(here, "migrations", "sqlite");
const migrationPattern = /^\d{4}_[a-z0-9_]+\.sql$/;

/**
 * Open a local SQLite database with API safety defaults. The full adapter is
 * composed by sqlite-store.ts and registered in persistence-runtime.ts.
 */
export function createSqliteClient({
  filename,
  timeoutMs = 5000,
  enableWal = true,
}: { filename?: string; timeoutMs?: number; enableWal?: boolean } = {}) {
  if (typeof filename !== "string" || filename.trim().length === 0) {
    throw new TypeError("A non-empty SQLite filename is required.");
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0) {
    throw new TypeError("SQLite timeoutMs must be a non-negative safe integer.");
  }

  const db = new DatabaseSync(filename);
  try {
    db.exec("PRAGMA foreign_keys = ON");
    db.exec(`PRAGMA busy_timeout = ${timeoutMs}`);
    if (enableWal && filename !== ":memory:") {
      db.exec("PRAGMA journal_mode = WAL");
      db.exec("PRAGMA synchronous = NORMAL");
    }
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

/**
 * Report pending/applied schema files without changing the database. An
 * uninitialized DB reports every migration pending, allowing runtime startup
 * to fail with an actionable instruction rather than serve a half-built schema.
 */
export async function getSqliteMigrationStatus(db, { directory = defaultDirectory } = {}) {
  if (!db || typeof db.exec !== "function" || typeof db.prepare !== "function") {
    throw new TypeError("A SQLite database connection is required.");
  }
  const files = (await readdir(directory)).filter((name) => migrationPattern.test(name)).sort();
  if (files.length === 0) throw new Error("No versioned SQLite migrations were found.");
  const table = db.prepare(
    "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'api_schema_migrations'",
  ).get();
  const appliedVersions = new Set(table
    ? db.prepare("SELECT version FROM api_schema_migrations").all().map((row) => row.version)
    : []);
  const applied = files.filter((file) => appliedVersions.has(file.slice(0, -".sql".length)));
  const pending = files.filter((file) => !appliedVersions.has(file.slice(0, -".sql".length)));
  return { discovered: files.length, applied, pending };
}

/**
 * Apply SQLite-specific migrations in lexical/version order. Each migration
 * and its version record commit atomically; BEGIN IMMEDIATE serializes runners.
 */
export async function runSqliteMigrations(db, { directory = defaultDirectory } = {}) {
  if (!db || typeof db.exec !== "function" || typeof db.prepare !== "function") {
    throw new TypeError("A SQLite database connection is required.");
  }

  const files = (await readdir(directory))
    .filter((name) => migrationPattern.test(name))
    .sort();
  if (files.length === 0) throw new Error("No versioned SQLite migrations were found.");

  db.exec(
    "CREATE TABLE IF NOT EXISTS api_schema_migrations (" +
    "version TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))" +
    ")",
  );
  const hasVersion = db.prepare(
    "SELECT 1 AS applied FROM api_schema_migrations WHERE version = ?",
  );
  const recordVersion = db.prepare(
    "INSERT INTO api_schema_migrations (version) VALUES (?)",
  );
  const applied = [];

  for (const file of files) {
    const version = file.slice(0, -".sql".length);
    if (hasVersion.get(version)) continue;
    const source = await readFile(join(directory, file), "utf8");

    db.exec("BEGIN IMMEDIATE");
    try {
      // Re-check after acquiring the write lock: another process may have
      // applied this migration while this runner was waiting.
      if (!hasVersion.get(version)) {
        db.exec(source);
        recordVersion.run(version);
        applied.push(version);
      }
      db.exec("COMMIT");
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // Preserve the original migration error if rollback itself fails.
      }
      throw new Error(`SQLite migration ${version} failed: ${error.message}`, { cause: error });
    }
  }

  return applied;
}
