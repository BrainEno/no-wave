import { DatabaseSync } from "node:sqlite";
import type { PgDatabase, PgExecutor } from "./postgres-driver.ts";

type Provider = "sqlite" | "postgres";
type ComparisonErrorCode = "INVALID_OPTIONS" | "INVALID_DATA" | "ROW_LIMIT_EXCEEDED" | "TIME_LIMIT_EXCEEDED" | "DATABASE_READ_FAILED";

const errorMessages: Record<ComparisonErrorCode, string> = {
  INVALID_OPTIONS: "Invalid media comparison options.",
  INVALID_DATA: "Media comparison encountered unsupported or oversized data.",
  ROW_LIMIT_EXCEEDED: "Media comparison exceeded its per-table row limit.",
  TIME_LIMIT_EXCEEDED: "Media comparison exceeded its time limit.",
  DATABASE_READ_FAILED: "Media comparison could not read both databases.",
};

/** Deliberately contains no database error, cause, row, path, or query parameters. */
export class ProviderMediaComparisonError extends Error {
  readonly code: ComparisonErrorCode;
  constructor(code: ComparisonErrorCode) {
    super(errorMessages[code]);
    this.name = "ProviderMediaComparisonError";
    this.code = code;
  }
}

type Table = "assets" | "articleReferences" | "avatars";
/** Internal fixed query set shared with the opt-in, single-provider audit. */
export type MediaSnapshotTable = Table | "auditAssets" | "auditTranslations" | "auditReferences" | "auditAvatars";
type Field = { name: string; sqlite: string; postgres: string; text: boolean };
type TableSpec = { table: string; keys: readonly Field[]; values: readonly Field[]; filter?: string };

const text = (name: string, sqlite = name, postgres = name): Field => ({ name, sqlite, postgres, text: true });
const integer = (name: string): Field => ({ name, sqlite: name, postgres: name, text: false });
const tables: Record<MediaSnapshotTable, TableSpec> = {
  assets: {
    table: "media_assets",
    keys: [text("id")],
    values: [
      text("owner_id"), text("storage_key"), text("content_type"), integer("byte_size"),
      integer("width"), integer("height"), text("sha256"),
      // Preserve PostgreSQL's microseconds rather than allowing the driver's
      // Date conversion to silently truncate them. Reject BC/out-of-range dates.
      text("created_at", "created_at", `CASE WHEN created_at >= '0001-01-01 00:00:00+00'::timestamptz AND created_at < '10000-01-01 00:00:00+00'::timestamptz THEN to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') ELSE NULL END`),
    ],
  },
  articleReferences: {
    table: "article_media_refs",
    keys: [text("asset_id"), text("article_id", "article_id", "article_id::text"), text("locale")],
    values: [],
  },
  avatars: {
    table: "user_profiles",
    keys: [text("user_id")],
    values: [text("avatar_url"), text("avatar_media_id")],
    // A profile with no URL and no associated asset is outside this comparison.
    filter: "(avatar_url IS NOT NULL OR avatar_media_id IS NOT NULL)",
  },
  auditAssets: { table: "media_assets", keys: [text("id")], values: [] },
  auditTranslations: {
    table: "article_translations",
    keys: [text("article_id", "article_id", "article_id::text"), text("locale")],
    // PostgreSQL JSONB is selected as text so both the SQL-side size guard and
    // one-document-at-a-time client memory limit apply before parsing.
    values: [text("content_blocks", "content_blocks", "content_blocks::text")],
  },
  auditReferences: {
    table: "article_media_refs",
    keys: [text("article_id", "article_id", "article_id::text"), text("locale"), text("asset_id")],
    values: [],
  },
  auditAvatars: {
    table: "user_profiles",
    keys: [text("user_id")],
    values: [text("avatar_url"), text("avatar_media_id")],
    filter: "(avatar_url IS NOT NULL OR avatar_media_id IS NOT NULL)",
  },
};

const maxTextBytes = 16_384;
/** Maximum permitted UTF-8 bytes for an explicitly requested body audit. */
export const MEDIA_AUDIT_MAX_BODY_BYTES = 4_194_304;
const defaultPageSize = 100;
const maxPageSize = 500;
type SnapshotScope = "comparison" | "materialization";
const allowedTables: Record<SnapshotScope, ReadonlySet<MediaSnapshotTable>> = {
  comparison: new Set(["assets", "articleReferences", "avatars"]),
  materialization: new Set(["auditAssets", "auditTranslations", "auditReferences", "auditAvatars"]),
};

export type MediaSnapshotRow = Record<string, unknown>;
type SqliteRow = MediaSnapshotRow;

/** Internal common bound validation; its errors are translated by each diagnostic. */
export function boundedMediaInteger(value: number | undefined, fallback: number, maximum: number): number {
  const result = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(result) || result < 1 || result > maximum) throw new ProviderMediaComparisonError("INVALID_OPTIONS");
  return result;
}

// SQLite can hold malformed UTF-8 despite a TEXT affinity. Read it as bytes
// and reject invalid sequences rather than comparing replacement characters.
// ignoreBOM preserves a real leading U+FEFF as part of an identifier or URL.
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
/** Decode strict UTF-8 without ever including the failing value in an error. */
export function mediaSnapshotText(value: unknown, limit = maxTextBytes): string {
  if (value instanceof Uint8Array) {
    try { value = utf8.decode(value); } catch { throw new ProviderMediaComparisonError("INVALID_DATA"); }
  }
  if (typeof value !== "string" || value.includes("\0") || Buffer.byteLength(value, "utf8") > limit) {
    throw new ProviderMediaComparisonError("INVALID_DATA");
  }
  return value;
}
/**
 * All identifiers and expressions are static. Text is capped on the server
 * before it reaches the client; an oversized value fails the whole diagnostic.
 * SQLite text is returned as bytes so invalid UTF-8 cannot compare equal after
 * lossy decoding. No private row values are sent back as query parameters.
 */
function selectQuery(table: MediaSnapshotTable, provider: Provider, bodyLimit: number): string {
  const spec = tables[table];
  const fields = [...spec.keys, ...spec.values];
  const expression = (field: Field) => field[provider];
  const size = (field: Field) => provider === "sqlite"
    ? `length(CAST((${expression(field)}) AS BLOB))`
    : `octet_length((${expression(field)})::text)`;
  const textFields = fields.filter((field) => field.text);
  const fieldLimit = (field: Field) => table === "auditTranslations" && field.name === "content_blocks" ? bodyLimit : maxTextBytes;
  const tooLarge = textFields.map((field) => `COALESCE(${size(field)}, 0) > ${fieldLimit(field)}`).join(" OR ");
  const invalidInteger = (field: Field) => `(typeof(${expression(field)}) <> 'integer' OR ${expression(field)} <= 0 OR ${expression(field)} > 9007199254740991)`;
  const invalidType = provider === "sqlite"
    ? fields.map((field) => field.text
      ? `typeof(${expression(field)}) NOT IN ('text', 'null')`
      : invalidInteger(field)).join(" OR ")
    : "FALSE";
  const select = fields.map((field) => {
    if (!field.text) return provider === "sqlite"
      ? `CASE WHEN ${invalidInteger(field)} THEN NULL ELSE ${expression(field)} END AS ${field.name}`
      : `${expression(field)} AS ${field.name}`;
    const value = provider === "sqlite" ? `CAST((${expression(field)}) AS BLOB)` : `(${expression(field)})`;
    return `CASE WHEN ${size(field)} > ${fieldLimit(field)} THEN NULL ELSE ${value} END AS ${field.name}`;
  });
  select.push(`CASE WHEN ${tooLarge} THEN 1 ELSE 0 END AS _oversized`);
  select.push(`CASE WHEN ${invalidType} THEN 1 ELSE 0 END AS _invalid_type`);
  const collation = provider === "sqlite" ? "BINARY" : '"C"';
  const keys = spec.keys.map((field) => `(${expression(field)}) COLLATE ${collation}`);
  return `SELECT ${select.join(", ")} FROM ${spec.table}${spec.filter ? ` WHERE ${spec.filter}` : ""} ORDER BY ${keys.join(", ")}`;
}

export function compareMediaKeys(left: readonly string[], right: readonly string[]): number {
  for (let i = 0; i < left.length; i++) {
    const result = Buffer.compare(Buffer.from(left[i]!, "utf8"), Buffer.from(right[i]!, "utf8"));
    if (result !== 0) return result;
  }
  return 0;
}

type RowReader = { nextPage(): Promise<SqliteRow[]>; close(): Promise<void> };
/** Internal read-only cursor interface; callers can only choose fixed query shapes. */
export type MediaSnapshot = { open(table: MediaSnapshotTable, pageSize: number, maxBodyBytes?: number): Promise<RowReader> };

/**
 * Read a bounded number of rows from a fixed query. No raw row is returned by
 * the public diagnostics; this iterator stays inside the server process.
 */
export async function* mediaSnapshotRows(snapshot: MediaSnapshot, table: MediaSnapshotTable, pageSize: number, limit: number, checkTime: () => void, maxBodyBytes?: number): AsyncGenerator<MediaSnapshotRow> {
  checkTime();
  const reader = await snapshot.open(table, pageSize, maxBodyBytes);
  let count = 0;
  try {
    for (;;) {
      checkTime();
      const page = await reader.nextPage();
      checkTime();
      if (page.length === 0) return;
      for (const raw of page) {
        if (++count > limit) throw new ProviderMediaComparisonError("ROW_LIMIT_EXCEEDED");
        if (Number(raw._oversized) !== 0 || Number(raw._invalid_type) !== 0) throw new ProviderMediaComparisonError("INVALID_DATA");
        yield raw;
      }
      if (page.length < pageSize) return;
    }
  } finally {
    await reader.close();
  }
}

/** PostgreSQL SHOW uses a numeric value and a time unit (or 0 for disabled). */
function timeoutMilliseconds(value: unknown): number {
  if (typeof value !== "string") throw new ProviderMediaComparisonError("INVALID_DATA");
  const match = /^(\d+(?:\.\d+)?)(ms|s|min|h|d)?$/.exec(value);
  if (!match) throw new ProviderMediaComparisonError("INVALID_DATA");
  const multiplier = { ms: 1, s: 1_000, min: 60_000, h: 3_600_000, d: 86_400_000 }[match[2] ?? "ms"];
  const result = Number(match[1]) * multiplier!;
  if (!Number.isFinite(result) || result < 0) throw new ProviderMediaComparisonError("INVALID_DATA");
  return result;
}

/** Internal helper: use only the fixed query shapes above, never caller SQL. */
export async function withSqliteMediaSnapshot<T>(filename: string, scope: SnapshotScope, checkTime: () => void, work: (snapshot: MediaSnapshot) => Promise<T>): Promise<T> {
  if (typeof filename !== "string" || !filename.trim() || filename === ":memory:" || filename.startsWith("file:") || !Object.hasOwn(allowedTables, scope)) {
    throw new ProviderMediaComparisonError("INVALID_OPTIONS");
  }
  let sqlite: DatabaseSync | undefined;
  let begun = false;
  try {
    // A private connection avoids borrowing or changing an application writer's
    // transaction. readOnly prevents creating a missing file or writing rows.
    sqlite = new DatabaseSync(filename, { readOnly: true, timeout: 2_000 });
    sqlite.exec("PRAGMA query_only = ON");
    const encoding = sqlite.prepare("PRAGMA encoding").get() as SqliteRow | undefined;
    if (encoding?.encoding !== "UTF-8") throw new ProviderMediaComparisonError("INVALID_DATA");
    sqlite.exec("BEGIN");
    begun = true;
    // BEGIN alone is deferred: a real table read pins the SQLite snapshot now.
    sqlite.prepare("SELECT 1 FROM media_assets LIMIT 1").get();
    checkTime();
    const db = sqlite;
    const snapshot: MediaSnapshot = {
      async open(table, size, requestedBodyLimit) {
        const pageSize = boundedMediaInteger(size, defaultPageSize, maxPageSize);
        const bodyLimit = boundedMediaInteger(requestedBodyLimit, MEDIA_AUDIT_MAX_BODY_BYTES, MEDIA_AUDIT_MAX_BODY_BYTES);
        if (!allowedTables[scope].has(table) || (table === "auditTranslations" && pageSize !== 1)) throw new ProviderMediaComparisonError("INVALID_OPTIONS");
        const iterator = db.prepare(selectQuery(table, "sqlite", bodyLimit)).iterate();
        return {
          async nextPage() {
            const page: SqliteRow[] = [];
            while (page.length < pageSize) {
              const next = iterator.next();
              if (next.done) break;
              page.push(next.value);
            }
            return page;
          },
          async close() { iterator.return?.(); },
        };
      },
    };
    return await work(snapshot);
  } finally {
    let cleanupFailed = false;
    if (sqlite && begun) {
      try { sqlite.exec("ROLLBACK"); } catch { cleanupFailed = true; }
    }
    if (sqlite) {
      try { sqlite.close(); } catch { cleanupFailed = true; }
    }
    if (cleanupFailed) throw new ProviderMediaComparisonError("DATABASE_READ_FAILED");
  }
}

/** Internal helper: one PostgreSQL read-only, repeatable-read snapshot. */
export async function withPostgresMediaSnapshot<T>(postgres: PgDatabase, scope: SnapshotScope, checkTime: () => void, work: (snapshot: MediaSnapshot) => Promise<T>): Promise<T> {
  if (!postgres || typeof postgres.begin !== "function" || (scope !== "comparison" && scope !== "materialization")) {
    throw new ProviderMediaComparisonError("INVALID_OPTIONS");
  }
  return postgres.begin(async (tx: PgExecutor) => {
    await tx.unsafe("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    // Do not silently compare a role-filtered subset. Without BYPASSRLS or
    // ownership, PostgreSQL fails a query that would be filtered by RLS.
    await tx.unsafe("SET LOCAL row_security = off");
    const [timeoutRow] = await tx.unsafe<{ statement_timeout: string }>("SHOW statement_timeout");
    const existingTimeout = timeoutMilliseconds(timeoutRow?.statement_timeout);
    if (existingTimeout === 0 || existingTimeout > 10_000) await tx.unsafe("SET LOCAL statement_timeout = '10s'");
    const [serverEncoding] = await tx.unsafe<{ server_encoding: string }>("SHOW server_encoding");
    const [clientEncoding] = await tx.unsafe<{ client_encoding: string }>("SHOW client_encoding");
    if (serverEncoding?.server_encoding !== "UTF8" || clientEncoding?.client_encoding !== "UTF8") {
      throw new ProviderMediaComparisonError("INVALID_DATA");
    }
    // TRUNCATE is not MVCC-safe for tables first read after it commits. Hold
    // read-compatible table locks before pinning all selected tables' snapshot.
    await tx.unsafe(scope === "materialization"
      ? "LOCK TABLE media_assets, article_media_refs, user_profiles, article_translations IN ACCESS SHARE MODE"
      : "LOCK TABLE media_assets, article_media_refs, user_profiles IN ACCESS SHARE MODE");
    await tx.unsafe("SELECT 1 FROM media_assets LIMIT 1");
    checkTime();
    const snapshot: MediaSnapshot = {
      async open(table, size, requestedBodyLimit) {
        const pageSize = boundedMediaInteger(size, defaultPageSize, maxPageSize);
        const bodyLimit = boundedMediaInteger(requestedBodyLimit, MEDIA_AUDIT_MAX_BODY_BYTES, MEDIA_AUDIT_MAX_BODY_BYTES);
        if (!allowedTables[scope].has(table) || (table === "auditTranslations" && pageSize !== 1)) throw new ProviderMediaComparisonError("INVALID_OPTIONS");
        // Names and SQL are fixed by the internal table enum; no private IDs or
        // content are supplied as SQL parameters for cursor positioning.
        const name = `nw_media_comparison_${table}`;
        await tx.unsafe(`DECLARE ${name} NO SCROLL CURSOR FOR ${selectQuery(table, "postgres", bodyLimit)}`);
        return {
          async nextPage() { return tx.unsafe<SqliteRow>(`FETCH FORWARD ${pageSize} FROM ${name}`); },
          async close() { await tx.unsafe(`CLOSE ${name}`); },
        };
      },
    };
    return work(snapshot);
  });
}
