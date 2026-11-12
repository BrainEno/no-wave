import { DatabaseSync } from "node:sqlite";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const defaultDirectory = join(here, "migrations", "sqlite");
const migrationPattern = /^\d{4}_[a-z0-9_]+\.sql$/;

type SqliteStatement = ReturnType<DatabaseSync["prepare"]>;

/**
 * A row as the SQLite driver returns it.
 *
 * Column *values* are dynamic by nature: the driver answers text, integers,
 * reals, blobs and null for the same `SELECT *`, and every slice's mapper converts
 * them into the declared domain record. This type is the SQLite counterpart of
 * `postgres.Row` — the PostgreSQL slices have used the driver's own dynamic row
 * type all along, and pretending otherwise here would only move the same cast into
 * two hundred call sites.
 *
 * It is the single dynamic boundary in this package, named once so that
 * `typed-boundaries.test.ts` can exempt it and nothing else: `any` anywhere outside
 * this alias still fails the build.
 */
export type SqliteRow = { [column: string]: any };

/** Statement accessors as the slices use them: dynamic rows in, bindings out. */
export type SqliteRunner = {
  readonly isTransaction?: boolean;
  exec(sql: string): void;
  close(): void;
  prepare(sql: string): {
    run(...values: unknown[]): { changes: number | bigint };
    get(...values: unknown[]): SqliteRow | undefined;
    all(...values: unknown[]): SqliteRow[];
  };
};
/**
 * A timestamp column as an ISO-8601 string.
 *
 * SQLite has no date type: the same column can answer text from `strftime`, text
 * from a `TEXT` default, or a number from a writer that bound epoch
 * milliseconds, and every mapper in every slice has to turn all three into the
 * one representation the domain contract declares. That conversion lives here so
 * the maps do not each re-decide it — and so none of them needs a cast to satisfy
 * `new Date(...)`. A `NULL` reaches this function as `null`, which is a caller
 * decision, not a timestamp: use `isoDateOrNull` for a nullable column.
 */
export function isoDate(value: unknown): string {
  if (value instanceof Date || typeof value === "string" || typeof value === "number") {
    return new Date(value).toISOString();
  }
  throw new TypeError("A SQLite timestamp column returned a value that is not a date.");
}

/** The nullable form: a `NULL` column stays `null`. */
export function isoDateOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : isoDate(value);
}

type UnknownFunction = (...args: unknown[]) => unknown;

/**
 * Named-parameter objects are plain records; binary blobs and arrays must stay
 * untouched. Node 24 minors disagree on whether a JavaScript boolean may be
 * bound at all, and a newer minor would coerce it to a REAL/INTEGER depending
 * on its implementation. Normalize at this boundary instead: booleans become
 * SQLite INTEGER 0/1 (bigint bindings keep INTEGER, not REAL, storage).
 */
function isNamedParameterObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  if (Array.isArray(value) || ArrayBuffer.isView(value)) return false;
  const prototype = Object.getPrototypeOf(value) as object | null;
  return prototype === Object.prototype || prototype === null;
}

function normalizeSqliteBinding(value: unknown): unknown {
  if (typeof value === "boolean") return value ? 1n : 0n;
  if (isNamedParameterObject(value)) {
    const normalized: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) normalized[key] = normalizeSqliteBinding(nested);
    return normalized;
  }
  return value;
}

function normalizeSqliteBindings(args: readonly unknown[]): unknown[] {
  return args.map(normalizeSqliteBinding);
}

function wrapSqliteStatement(statement: SqliteStatement): SqliteStatement {
  for (const method of ["get", "all", "run", "iterate"] as const) {
    const original = statement[method] as unknown as UnknownFunction;
    Object.defineProperty(statement, method, {
      configurable: true,
      writable: true,
      value: (...args: unknown[]): unknown =>
        Reflect.apply(original, statement, normalizeSqliteBindings(args)) as unknown,
    });
  }
  return statement;
}

/**
 * The Unicode case fold the SQLite queries use instead of `lower()` (#245).
 *
 * SQLite's `lower()` folds exactly `A`–`Z`: the function is built for a database
 * that predates Unicode, and it cannot be told a collation. A reader searching
 * `éclair` therefore never matched `Éclair`, and every language with case-marked
 * letters above ASCII had a silent half of its vocabulary. JavaScript's
 * `toLowerCase` is the Unicode simple case mapping, so registering it as an SQL
 * function gives the scans a fold that agrees with the one the store applies to
 * the needle in JavaScript.
 *
 * The name is exported because the query has to spell it: a function that exists
 * on the connection but is not in the SQL is dead code, and one in the SQL that
 * is not on the connection is a runtime error on the first search.
 */
export const SQLITE_FOLD_SQL_FUNCTION = "nw_fold";

/**
 * Register the SQL helpers every prepared statement may rely on.
 *
 * It runs at open time on the one connection the runtime composes, so no caller
 * has to remember it — a store created from a bare `DatabaseSync` would fail on
 * the first search rather than quietly searching less.
 */
function registerSqliteFunctions(db: DatabaseSync): void {
  db.function(SQLITE_FOLD_SQL_FUNCTION, { deterministic: true }, (value) =>
    typeof value === "string" ? value.toLowerCase() : "");
}

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
    registerSqliteFunctions(db);
    db.exec("PRAGMA foreign_keys = ON");
    db.exec(`PRAGMA busy_timeout = ${timeoutMs}`);
    if (enableWal && filename !== ":memory:") {
      db.exec("PRAGMA journal_mode = WAL");
      db.exec("PRAGMA synchronous = NORMAL");
    }
    const originalPrepare = db.prepare.bind(db) as (sql: string) => SqliteStatement;
    Object.defineProperty(db, "prepare", {
      configurable: true,
      writable: true,
      value: (sql: string): SqliteStatement => wrapSqliteStatement(originalPrepare(sql)),
    });
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
export async function getSqliteMigrationStatus(
  db: SqliteRunner,
  { directory = defaultDirectory }: { directory?: string } = {},
): Promise<{ discovered: number; applied: string[]; pending: string[] }> {
  if (!db || typeof db.exec !== "function" || typeof db.prepare !== "function") {
    throw new TypeError("A SQLite database connection is required.");
  }
  const files = (await readdir(directory)).filter((name) => migrationPattern.test(name)).sort();
  if (files.length === 0) throw new Error("No versioned SQLite migrations were found.");
  const table = db.prepare(
    "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'api_schema_migrations'",
  ).get();
  const appliedVersions = new Set<string>(table
    ? db.prepare("SELECT version FROM api_schema_migrations").all().map((row) => String(row.version))
    : []);
  const applied = files.filter((file) => appliedVersions.has(file.slice(0, -".sql".length)));
  const pending = files.filter((file) => !appliedVersions.has(file.slice(0, -".sql".length)));
  return { discovered: files.length, applied, pending };
}

/**
 * Apply SQLite-specific migrations in lexical/version order. Each migration
 * and its version record commit atomically; BEGIN IMMEDIATE serializes runners.
 */
export async function runSqliteMigrations(
  db: SqliteRunner,
  { directory = defaultDirectory }: { directory?: string } = {},
): Promise<string[]> {
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
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`SQLite migration ${version} failed: ${detail}`, { cause: error });
    }
  }

  return applied;
}
