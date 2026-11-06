import { performance } from "node:perf_hooks";
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

type RowCounts = { equal: number; different: number; sourceOnly: number; targetOnly: number };
type ReferenceCounts = Omit<RowCounts, "different">;

/** Counts are sensitive operational data, but never contain private row values or IDs. */
export type ProviderMediaComparison = {
  kind: "media-comparison-diagnostic";
  sourceProvider: Provider;
  targetProvider: Provider;
  assets: RowCounts;
  articleReferences: ReferenceCounts;
  avatars: RowCounts;
};

type ComparisonOptions = {
  /** A dedicated read-only SQLite connection is opened from this existing file. */
  sqliteFilename: string;
  /** A pool whose transaction has permission to read the three selected tables. */
  postgres: PgDatabase;
  sourceProvider: Provider;
  pageSize?: number;
  maxRowsPerTable?: number;
  maxDurationMs?: number;
};

type Table = "assets" | "articleReferences" | "avatars";
type Field = { name: string; sqlite: string; postgres: string; text: boolean };
type TableSpec = { table: string; keys: readonly Field[]; values: readonly Field[]; filter?: string };

const text = (name: string, sqlite = name, postgres = name): Field => ({ name, sqlite, postgres, text: true });
const integer = (name: string): Field => ({ name, sqlite: name, postgres: name, text: false });
const tables: Record<Table, TableSpec> = {
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
};

const maxTextBytes = 16_384;
const defaultPageSize = 100;
const maxPageSize = 500;
const defaultMaxRows = 100_000;
const maxRows = 100_000;
const defaultMaxDurationMs = 30_000;

type NormalizedRow = { key: string[]; values: readonly (string | number | null)[] };
type SqliteRow = Record<string, unknown>;

function boundedInteger(value: number | undefined, fallback: number, maximum: number): number {
  const result = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(result) || result < 1 || result > maximum) throw new ProviderMediaComparisonError("INVALID_OPTIONS");
  return result;
}

// SQLite can hold malformed UTF-8 despite a TEXT affinity. Read it as bytes
// and reject invalid sequences rather than comparing replacement characters.
// ignoreBOM preserves a real leading U+FEFF as part of an identifier or URL.
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
function keyText(value: unknown): string {
  if (value instanceof Uint8Array) {
    try { value = utf8.decode(value); } catch { throw new ProviderMediaComparisonError("INVALID_DATA"); }
  }
  if (typeof value !== "string" || value.includes("\0") || Buffer.byteLength(value, "utf8") > maxTextBytes) {
    throw new ProviderMediaComparisonError("INVALID_DATA");
  }
  return value;
}

function valueText(value: unknown, nullable = false): string | null {
  if (nullable && value === null) return null;
  return keyText(value);
}

function positiveInteger(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) throw new ProviderMediaComparisonError("INVALID_DATA");
  return value;
}

/** Normalize an ISO timestamp with an explicit offset to an exact integer microsecond. */
function timestampMicros(value: unknown): string {
  if (typeof value !== "string") throw new ProviderMediaComparisonError("INVALID_DATA");
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(?:Z|[+-]\d{2}:\d{2})$/i.exec(value);
  const milliseconds = Date.parse(value);
  if (!match || !Number.isFinite(milliseconds)) throw new ProviderMediaComparisonError("INVALID_DATA");
  const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > days[month - 1]! ||
      Number(match[4]) > 23 || Number(match[5]) > 59 || Number(match[6]) > 59 ||
      milliseconds < Date.parse("0001-01-01T00:00:00Z") || milliseconds >= Date.parse("+010000-01-01T00:00:00Z")) {
    throw new ProviderMediaComparisonError("INVALID_DATA");
  }
  const fraction = (match[7] ?? "").padEnd(6, "0");
  return (BigInt(milliseconds) * 1_000n + BigInt(fraction.slice(3))).toString();
}

function normalizeRow(table: Table, raw: SqliteRow): NormalizedRow {
  if (Number(raw._oversized) !== 0 || Number(raw._invalid_type) !== 0) throw new ProviderMediaComparisonError("INVALID_DATA");
  switch (table) {
    case "assets":
      return {
        key: [keyText(raw.id)],
        values: [
          valueText(raw.owner_id), valueText(raw.storage_key), valueText(raw.content_type),
          positiveInteger(raw.byte_size), positiveInteger(raw.width), positiveInteger(raw.height),
          valueText(raw.sha256), timestampMicros(valueText(raw.created_at)),
        ],
      };
    case "articleReferences":
      return { key: [keyText(raw.asset_id), keyText(raw.article_id), keyText(raw.locale)], values: [] };
    case "avatars":
      return { key: [keyText(raw.user_id)], values: [valueText(raw.avatar_url, true), valueText(raw.avatar_media_id, true)] };
  }
}

/**
 * All identifiers and expressions are static. Text is capped on the server
 * before it reaches the client; an oversized value fails the whole diagnostic.
 * SQLite text is returned as bytes so invalid UTF-8 cannot compare equal after
 * lossy decoding. No private row values are sent back as query parameters.
 */
function selectQuery(table: Table, provider: Provider): string {
  const spec = tables[table];
  const fields = [...spec.keys, ...spec.values];
  const expression = (field: Field) => field[provider];
  const size = (field: Field) => provider === "sqlite"
    ? `length(CAST((${expression(field)}) AS BLOB))`
    : `octet_length((${expression(field)})::text)`;
  const textFields = fields.filter((field) => field.text);
  const tooLarge = textFields.map((field) => `COALESCE(${size(field)}, 0) > ${maxTextBytes}`).join(" OR ");
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
    return `CASE WHEN ${size(field)} > ${maxTextBytes} THEN NULL ELSE ${value} END AS ${field.name}`;
  });
  select.push(`CASE WHEN ${tooLarge} THEN 1 ELSE 0 END AS _oversized`);
  select.push(`CASE WHEN ${invalidType} THEN 1 ELSE 0 END AS _invalid_type`);
  const collation = provider === "sqlite" ? "BINARY" : '"C"';
  const keys = spec.keys.map((field) => `(${expression(field)}) COLLATE ${collation}`);
  return `SELECT ${select.join(", ")} FROM ${spec.table}${spec.filter ? ` WHERE ${spec.filter}` : ""} ORDER BY ${keys.join(", ")}`;
}

function compareKeys(left: readonly string[], right: readonly string[]): number {
  for (let i = 0; i < left.length; i++) {
    const result = Buffer.compare(Buffer.from(left[i]!, "utf8"), Buffer.from(right[i]!, "utf8"));
    if (result !== 0) return result;
  }
  return 0;
}

function equalValues(left: readonly (string | number | null)[], right: readonly (string | number | null)[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

type RowReader = { nextPage(): Promise<SqliteRow[]>; close(): Promise<void> };
type Snapshot = { open(table: Table, pageSize: number): Promise<RowReader> };

async function* rows(snapshot: Snapshot, table: Table, pageSize: number, limit: number, checkTime: () => void): AsyncGenerator<NormalizedRow> {
  checkTime();
  const reader = await snapshot.open(table, pageSize);
  let previous: string[] | undefined;
  let count = 0;
  try {
    for (;;) {
      checkTime();
      const page = await reader.nextPage();
      checkTime();
      if (page.length === 0) return;
      for (const raw of page) {
        if (++count > limit) throw new ProviderMediaComparisonError("ROW_LIMIT_EXCEEDED");
        const row = normalizeRow(table, raw);
        if (previous && compareKeys(row.key, previous) <= 0) throw new ProviderMediaComparisonError("INVALID_DATA");
        previous = row.key;
        yield row;
      }
      if (page.length < pageSize) return;
    }
  } finally {
    await reader.close();
  }
}

async function compareRows(source: Snapshot, target: Snapshot, table: Table, pageSize: number, limit: number, checkTime: () => void): Promise<RowCounts> {
  const result: RowCounts = { equal: 0, different: 0, sourceOnly: 0, targetOnly: 0 };
  const sourceRows = rows(source, table, pageSize, limit, checkTime);
  const targetRows = rows(target, table, pageSize, limit, checkTime);
  let failure: unknown;
  try {
    let a = await sourceRows.next(), b = await targetRows.next();
    while (!a.done || !b.done) {
      checkTime();
      const order = a.done ? 1 : b.done ? -1 : compareKeys(a.value.key, b.value.key);
      if (order < 0) {
        result.sourceOnly++;
        a = await sourceRows.next();
      } else if (order > 0) {
        result.targetOnly++;
        b = await targetRows.next();
      } else {
        if (equalValues(a.value!.values, b.value!.values)) result.equal++;
        else result.different++;
        a = await sourceRows.next();
        b = await targetRows.next();
      }
    }
    return result;
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    // A row limit, timeout, or error may interrupt either reader mid-page.
    // Always release both, even if one close fails or its transaction aborted.
    const closed = await Promise.allSettled([sourceRows.return(undefined), targetRows.return(undefined)]);
    if (!failure && closed.some((item) => item.status === "rejected")) throw new ProviderMediaComparisonError("DATABASE_READ_FAILED");
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

/**
 * Compare materialized media rows only. This has no endpoint, repair operation,
 * watermark, writer fence, initial snapshot importer, or cutover authority.
 * Each database has its own read-only snapshot, not one global point in time.
 */
export async function compareProviderMedia(options: ComparisonOptions): Promise<ProviderMediaComparison> {
  if (!options || typeof options.sqliteFilename !== "string" || !options.sqliteFilename.trim() || options.sqliteFilename === ":memory:" || options.sqliteFilename.startsWith("file:") ||
      !options.postgres || typeof options.postgres.begin !== "function" ||
      (options.sourceProvider !== "sqlite" && options.sourceProvider !== "postgres")) {
    throw new ProviderMediaComparisonError("INVALID_OPTIONS");
  }
  const pageSize = boundedInteger(options.pageSize, defaultPageSize, maxPageSize);
  const limit = boundedInteger(options.maxRowsPerTable, defaultMaxRows, maxRows);
  const duration = boundedInteger(options.maxDurationMs, defaultMaxDurationMs, defaultMaxDurationMs);
  const deadline = performance.now() + duration;
  const checkTime = () => { if (performance.now() >= deadline) throw new ProviderMediaComparisonError("TIME_LIMIT_EXCEEDED"); };
  let sqlite: DatabaseSync | undefined;
  let begun = false;
  try {
    // A private connection avoids borrowing or changing an application writer's
    // transaction. readOnly prevents creating a missing file or writing rows.
    sqlite = new DatabaseSync(options.sqliteFilename, { readOnly: true, timeout: 2_000 });
    sqlite.exec("PRAGMA query_only = ON");
    const encoding = sqlite.prepare("PRAGMA encoding").get() as SqliteRow | undefined;
    if (encoding?.encoding !== "UTF-8") throw new ProviderMediaComparisonError("INVALID_DATA");
    sqlite.exec("BEGIN");
    begun = true;
    // BEGIN alone is deferred: a real table read pins the SQLite snapshot now.
    sqlite.prepare("SELECT 1 FROM media_assets LIMIT 1").get();
    checkTime();
    const db = sqlite;
    return await options.postgres.begin(async (tx: PgExecutor) => {
      await tx.unsafe("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
      // Do not silently compare a role-filtered subset. Without BYPASSRLS or
      // ownership, PostgreSQL fails a query that would be filtered by RLS.
      await tx.unsafe("SET LOCAL row_security = off");
      const [timeoutRow] = await tx.unsafe<{ statement_timeout: string }>("SHOW statement_timeout");
      const existingTimeout = timeoutMilliseconds(timeoutRow?.statement_timeout);
      // Cap slow PostgreSQL statements without weakening a stricter caller limit.
      if (existingTimeout === 0 || existingTimeout > 10_000) await tx.unsafe("SET LOCAL statement_timeout = '10s'");
      const [serverEncoding] = await tx.unsafe<{ server_encoding: string }>("SHOW server_encoding");
      const [clientEncoding] = await tx.unsafe<{ client_encoding: string }>("SHOW client_encoding");
      if (serverEncoding?.server_encoding !== "UTF8" || clientEncoding?.client_encoding !== "UTF8") {
        throw new ProviderMediaComparisonError("INVALID_DATA");
      }
      // TRUNCATE is not MVCC-safe for tables first read after it commits. Hold
      // read-compatible table locks on all three before pinning the snapshot so
      // later DDL/TRUNCATE cannot replace an as-yet-unread part of the scan.
      await tx.unsafe("LOCK TABLE media_assets, article_media_refs, user_profiles IN ACCESS SHARE MODE");
      // First table read pins this independently timed PostgreSQL snapshot.
      await tx.unsafe("SELECT 1 FROM media_assets LIMIT 1");
      checkTime();
      const sqliteSnapshot: Snapshot = {
        async open(table, size) {
          const iterator = db.prepare(selectQuery(table, "sqlite")).iterate();
          return {
            async nextPage() {
              const page: SqliteRow[] = [];
              while (page.length < size) {
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
      const postgresSnapshot: Snapshot = {
        async open(table, size) {
          // Names are a static table enum, and size was validated as a small
          // integer. A forward-only transaction cursor avoids private IDs as
          // keyset parameters and avoids repeatedly sorting the whole table.
          const name = `nw_media_comparison_${table}`;
          await tx.unsafe(`DECLARE ${name} NO SCROLL CURSOR FOR ${selectQuery(table, "postgres")}`);
          return {
            async nextPage() { return tx.unsafe<SqliteRow>(`FETCH FORWARD ${size} FROM ${name}`); },
            async close() { await tx.unsafe(`CLOSE ${name}`); },
          };
        },
      };
      const source = options.sourceProvider === "sqlite" ? sqliteSnapshot : postgresSnapshot;
      const target = options.sourceProvider === "sqlite" ? postgresSnapshot : sqliteSnapshot;
      const assets = await compareRows(source, target, "assets", pageSize, limit, checkTime);
      const referenceRows = await compareRows(source, target, "articleReferences", pageSize, limit, checkTime);
      const avatars = await compareRows(source, target, "avatars", pageSize, limit, checkTime);
      checkTime();
      // Reference keys have no non-key values, so there is no 'different' case.
      const articleReferences: ReferenceCounts = { equal: referenceRows.equal, sourceOnly: referenceRows.sourceOnly, targetOnly: referenceRows.targetOnly };
      return {
        kind: "media-comparison-diagnostic" as const,
        sourceProvider: options.sourceProvider,
        targetProvider: options.sourceProvider === "sqlite" ? "postgres" as const : "sqlite" as const,
        assets, articleReferences, avatars,
      };
    });
  } catch (error) {
    if (error instanceof ProviderMediaComparisonError) throw error;
    // Database drivers may attach SQL, parameters, database paths or URLs to
    // errors. Do not preserve the original message, stack, or cause.
    throw new ProviderMediaComparisonError("DATABASE_READ_FAILED");
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
