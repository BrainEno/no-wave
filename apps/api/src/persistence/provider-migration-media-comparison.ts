import { performance } from "node:perf_hooks";
import type { PgDatabase } from "./postgres-driver.ts";
import {
  ProviderMediaComparisonError,
  boundedMediaInteger,
  compareMediaKeys,
  mediaSnapshotRows,
  mediaSnapshotText,
  withPostgresMediaSnapshot,
  withSqliteMediaSnapshot,
  type MediaSnapshot,
  type MediaSnapshotRow,
} from "./provider-migration-media-snapshot.ts";

// Preserve the existing diagnostic's error export while sharing the private
// read-only snapshot machinery with the separate materialization audit.
export { ProviderMediaComparisonError } from "./provider-migration-media-snapshot.ts";

type Provider = "sqlite" | "postgres";
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
type NormalizedRow = { key: string[]; values: readonly (string | number | null)[] };
type SqliteRow = MediaSnapshotRow;
type Snapshot = MediaSnapshot;
const defaultPageSize = 100;
const maxPageSize = 500;
const defaultMaxRows = 100_000;
const maxRows = 100_000;
const defaultMaxDurationMs = 30_000;

function keyText(value: unknown): string { return mediaSnapshotText(value); }

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

function equalValues(left: readonly (string | number | null)[], right: readonly (string | number | null)[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

async function* rows(snapshot: Snapshot, table: Table, pageSize: number, limit: number, checkTime: () => void): AsyncGenerator<NormalizedRow> {
  let previous: string[] | undefined;
  for await (const raw of mediaSnapshotRows(snapshot, table, pageSize, limit, checkTime)) {
    const row = normalizeRow(table, raw);
    if (previous && compareMediaKeys(row.key, previous) <= 0) throw new ProviderMediaComparisonError("INVALID_DATA");
    previous = row.key;
    yield row;
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
      const order = a.done ? 1 : b.done ? -1 : compareMediaKeys(a.value.key, b.value.key);
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
  const pageSize = boundedMediaInteger(options.pageSize, defaultPageSize, maxPageSize);
  const limit = boundedMediaInteger(options.maxRowsPerTable, defaultMaxRows, maxRows);
  const duration = boundedMediaInteger(options.maxDurationMs, defaultMaxDurationMs, defaultMaxDurationMs);
  const deadline = performance.now() + duration;
  const checkTime = () => { if (performance.now() >= deadline) throw new ProviderMediaComparisonError("TIME_LIMIT_EXCEEDED"); };
  try {
    return await withSqliteMediaSnapshot(options.sqliteFilename, "comparison", checkTime, (sqliteSnapshot) =>
      withPostgresMediaSnapshot(options.postgres, "comparison", checkTime, async (postgresSnapshot) => {
        const source = options.sourceProvider === "sqlite" ? sqliteSnapshot : postgresSnapshot;
        const target = options.sourceProvider === "sqlite" ? postgresSnapshot : sqliteSnapshot;
        const assets = await compareRows(source, target, "assets", pageSize, limit, checkTime);
        const referenceRows = await compareRows(source, target, "articleReferences", pageSize, limit, checkTime);
        const avatars = await compareRows(source, target, "avatars", pageSize, limit, checkTime);
        checkTime();
        const articleReferences: ReferenceCounts = { equal: referenceRows.equal, sourceOnly: referenceRows.sourceOnly, targetOnly: referenceRows.targetOnly };
        return {
          kind: "media-comparison-diagnostic" as const,
          sourceProvider: options.sourceProvider,
          targetProvider: options.sourceProvider === "sqlite" ? "postgres" as const : "sqlite" as const,
          assets, articleReferences, avatars,
        };
      }));
  } catch (error) {
    if (error instanceof ProviderMediaComparisonError) throw error;
    // Do not preserve database messages, stacks, causes, paths or parameters.
    throw new ProviderMediaComparisonError("DATABASE_READ_FAILED");
  }
}
