import { createHash } from "node:crypto";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { ARTICLE_MEDIA_REFS_SNAPSHOT, canonicalJson } from "./provider-migration-journal.ts";
import {
  getMigrationEntitySpec,
  getSupportedMigrationEntityTypes,
  prepareMigrationRowPayload,
  type MigrationEntitySpec,
} from "./provider-migration-row-applier.ts";
import type { PgDatabase, PgExecutor } from "./postgres-driver.ts";
import type { SqliteRow } from "./sqlite.ts";

/**
 * A one-shot copy of a live database into an empty one (#247).
 *
 * The journal machinery in this directory replays *changes*. It assumes a
 * coordinated snapshot already exists on the target and refuses to guess: an old
 * target is rejected rather than repaired (ADR 0010). Nothing produced that
 * snapshot — which is why moving a local SQLite site to PostgreSQL meant writing
 * INSERT statements by hand and hoping.
 *
 * This module is that missing first half, and deliberately only that half:
 *
 * - The source is read inside one snapshot (SQLite `BEGIN`; PostgreSQL
 *   REPEATABLE READ, READ ONLY), so a writer that is still running cannot make
 *   the copy internally inconsistent. It still cannot make it *current*: the
 *   operator stops the API, or accepts that the copy ends where the snapshot
 *   began. That is why the runbook is "quiesce, copy, verify, switch".
 * - The target must be empty. Merging into a database that already holds rows is
 *   the reconciliation problem the journal protocol has not solved yet, and
 *   silently upserting over it would hide exactly the conflicts that need a
 *   human. The refusal names the first table that is not empty.
 * - Rows go through `prepareMigrationRowPayload`, the same allowlist, JSON
 *   normalisation and field validation the journal replayer uses. A copied
 *   database is therefore the shape a replayed one would have, and a row the
 *   replayer would reject cannot sneak in through the copy path instead.
 * - Everything is one target transaction: all rows or none. A half-copied
 *   database is worse than no copy, because it looks finished.
 * - The copy ends with a reconciliation pass — per table, the same row count and
 *   a digest of every portable column, computed the same way on both sides — and
 *   rolls back if anything disagrees. Row counts alone would pass a copy that
 *   dropped a column or wrote a timestamp in another shape.
 *
 * What it does not do, and the runbook says so in the same words: media bytes
 * (the storage backend is a separate system — the rows are copied, the objects
 * are not), live change capture, cutover fencing, or rollback after the target
 * has accepted writes.
 */

export type TransferProvider = "sqlite" | "postgres";

/** One end of a transfer: a database this module can read and write rows in. */
export type TransferEndpoint =
  | { provider: "sqlite"; db: DatabaseSync }
  | { provider: "postgres"; sql: PgDatabase };

type TransferErrorCode =
  | "UNSUPPORTED_PROVIDER"
  | "TARGET_NOT_EMPTY"
  | "SOURCE_READ_FAILED"
  | "RECONCILIATION_MISMATCH"
  | "INVALID_OPTIONS";

const errorMessages: Record<TransferErrorCode, string> = {
  UNSUPPORTED_PROVIDER: "The transfer supports SQLite and PostgreSQL only.",
  TARGET_NOT_EMPTY: "The target database already contains application rows.",
  SOURCE_READ_FAILED: "The source database could not be read consistently.",
  RECONCILIATION_MISMATCH: "The copied data does not match the source it was read from.",
  INVALID_OPTIONS: "Invalid transfer options.",
};

/**
 * Carries a stable code; the message names at most a table or a column, never a
 * row value and never a connection string.
 */
export class ProviderTransferError extends Error {
  readonly code: TransferErrorCode;
  constructor(code: TransferErrorCode, message = errorMessages[code]) {
    super(message);
    this.name = "ProviderTransferError";
    this.code = code;
  }
}

/**
 * The order rows are written in: every row's foreign keys already exist.
 *
 * The list is not decorative. `media_assets.owner_id` references
 * `auth_accounts`, so assets come second; `user_profiles.avatar_media_id`
 * references `media_assets`, so profiles come third; `article_media_refs`
 * references both an asset and an article, which is why it is written with the
 * translation that owns it. `article_comments` is the one self-reference and is
 * ordered topologically at write time.
 *
 * A test asserts this list covers exactly the entities the journal can replay,
 * so adding an entity to the applier without adding it here fails the suite
 * instead of quietly leaving a table out of every copy.
 */
export const PROVIDER_TRANSFER_ORDER: readonly string[] = Object.freeze([
  "auth_accounts",
  "media_assets",
  "user_profiles",
  "user_profile_translations",
  "auth_sessions",
  "auth_access_tokens",
  "auth_refresh_tokens",
  "auth_identity_tokens",
  "auth_rate_limits",
  "revoked_sessions",
  "taxonomies",
  "taxonomy_translations",
  "articles",
  "article_translations",
  "article_likes",
  "article_comments",
  "article_taxonomies",
  "featured_articles",
  "user_follows",
  "conversations",
  "conversation_participants",
  "messages",
  "notifications",
  "outbox_events",
  // Provenance is data about where content came from, so a cutover that dropped
  // it would make the next Notion import create a second copy of every work
  // (ADR 0037). Last, because it references `articles` and nothing references it.
  "external_content_links",
]);

/**
 * Associations that are not entities but are still data.
 *
 * `article_media_refs` is written as part of the translation that owns it (the
 * journal carries it in `ARTICLE_MEDIA_REFS_SNAPSHOT`), so it is copied and
 * reconciled without appearing in the entity order.
 */
const ASSOCIATION_TABLES = Object.freeze(["article_media_refs"]);

export type TransferTableReport = {
  table: string;
  sourceRows: number;
  targetRows: number;
  sourceDigest: string;
  targetDigest: string;
  matched: boolean;
};

export type ProviderTransferReport = {
  source: TransferProvider;
  target: TransferProvider;
  applied: boolean;
  tables: TransferTableReport[];
  totalRows: number;
  mediaAssets: number;
  ok: boolean;
};

export type TransferOptions = {
  pageSize?: number;
  /** Validate and measure the source without opening a target transaction. */
  dryRun?: boolean;
  /** Called once per table, after that table's rows are written and checked. */
  onTable?: (report: TransferTableReport) => void;
};

const DEFAULT_PAGE_SIZE = 500;
const MAX_PAGE_SIZE = 5_000;

function validatePageSize(value: number | undefined): number {
  const pageSize = value ?? DEFAULT_PAGE_SIZE;
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > MAX_PAGE_SIZE) {
    throw new ProviderTransferError("INVALID_OPTIONS");
  }
  return pageSize;
}

/** A row as either driver returns it, before normalisation. */
type TransferRow = Record<string, unknown>;

/**
 * What the copy reads and writes.
 *
 * Both adapters are deliberately tiny: a counted select, a page of ordered rows,
 * and a single-statement insert. Everything interesting — which columns exist,
 * what a valid row is, how JSON is normalised — lives in
 * `provider-migration-row-applier.ts`, so the copy and the replay cannot drift.
 */
type RowSource = {
  provider: TransferProvider;
  rowCount(table: string): Promise<number>;
  page(table: string, columns: readonly string[], orderBy: readonly string[], offset: number, limit: number): Promise<TransferRow[]>;
};

type RowTarget = RowSource & {
  insert(table: string, columns: readonly string[], values: readonly unknown[], jsonColumns: ReadonlySet<string>): Promise<void>;
  deleteArticleMediaRefs(articleId: string, locale: string): Promise<void>;
  insertArticleMediaRef(assetId: string, articleId: string, locale: string): Promise<void>;
};

const identifier = /^[a-z_][a-z0-9_]*$/;

/** Table and column names come from our own specs — and are checked anyway. */
function assertIdentifier(value: string): string {
  if (!identifier.test(value)) throw new ProviderTransferError("INVALID_OPTIONS", "Unsupported identifier in the transfer plan.");
  return value;
}

function sqliteSource(db: DatabaseSync): RowSource {
  return {
    provider: "sqlite",
    async rowCount(table) {
      const row = db.prepare(`SELECT count(*) AS n FROM ${assertIdentifier(table)}`).get() as SqliteRow | undefined;
      return Number(row?.n ?? 0);
    },
    async page(table, columns, orderBy, offset, limit) {
      const sql = `SELECT ${columns.map(assertIdentifier).join(", ")} FROM ${assertIdentifier(table)}`
        + ` ORDER BY ${orderBy.map(assertIdentifier).join(", ")} LIMIT ? OFFSET ?`;
      return db.prepare(sql).all(limit, offset) as TransferRow[];
    },
  };
}

function postgresSource(sql: PgExecutor, provider: TransferProvider = "postgres"): RowSource {
  return {
    provider,
    async rowCount(table) {
      const rows = await sql.unsafe<{ n: string | number }>(`SELECT count(*) AS n FROM ${assertIdentifier(table)}`);
      return Number(rows[0]?.n ?? 0);
    },
    async page(table, columns, orderBy, offset, limit) {
      return sql.unsafe<TransferRow>(
        `SELECT ${columns.map(assertIdentifier).join(", ")} FROM ${assertIdentifier(table)}`
        + ` ORDER BY ${orderBy.map(assertIdentifier).join(", ")} LIMIT $1 OFFSET $2`,
        [limit, offset],
      );
    },
  };
}

function sqliteTarget(db: DatabaseSync, source: RowSource): RowTarget {
  return {
    ...source,
    async insert(table, columns, values) {
      const placeholders = columns.map(() => "?").join(", ");
      // The applier has already reduced every value to what this provider binds:
      // JSON became text, and the remaining values are strings, numbers or null.
      db.prepare(`INSERT INTO ${assertIdentifier(table)} (${columns.map(assertIdentifier).join(", ")}) VALUES (${placeholders})`)
        .run(...(values as readonly SQLInputValue[]));
    },
    async deleteArticleMediaRefs(articleId, locale) {
      db.prepare("DELETE FROM article_media_refs WHERE article_id = ? AND locale = ?").run(articleId, locale);
    },
    async insertArticleMediaRef(assetId, articleId, locale) {
      db.prepare("INSERT INTO article_media_refs (asset_id, article_id, locale) VALUES (?, ?, ?)").run(assetId, articleId, locale);
    },
  };
}

function postgresTarget(sql: PgExecutor, source: RowSource): RowTarget {
  return {
    ...source,
    async insert(table, columns, values, jsonColumns) {
      const placeholders = columns.map((column, index) => `$${index + 1}${jsonColumns.has(column) ? "::jsonb" : ""}`).join(", ");
      await sql.unsafe(`INSERT INTO ${assertIdentifier(table)} (${columns.map(assertIdentifier).join(", ")}) VALUES (${placeholders})`, values);
    },
    async deleteArticleMediaRefs(articleId, locale) {
      await sql.unsafe("DELETE FROM article_media_refs WHERE article_id = $1 AND locale = $2", [articleId, locale]);
    },
    async insertArticleMediaRef(assetId, articleId, locale) {
      await sql.unsafe("INSERT INTO article_media_refs (asset_id, article_id, locale) VALUES ($1, $2, $3)", [assetId, articleId, locale]);
    },
  };
}

/**
 * Run `work` inside a transaction that sees one consistent source database.
 *
 * SQLite gets a deferred `BEGIN`: the first read pins the WAL snapshot and every
 * later read in the transaction sees the same version. PostgreSQL is told
 * explicitly, because its default READ COMMITTED would let a long copy read two
 * different versions of the same table.
 */
async function withSourceSnapshot<T>(endpoint: TransferEndpoint, work: (reader: RowSource) => Promise<T>): Promise<T> {
  if (endpoint.provider === "sqlite") {
    endpoint.db.exec("BEGIN");
    try {
      const result = await work(sqliteSource(endpoint.db));
      endpoint.db.exec("COMMIT");
      return result;
    } catch (error) {
      endpoint.db.exec("ROLLBACK");
      throw error;
    }
  }
  return endpoint.sql.begin(async (tx) => {
    await tx.unsafe("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY");
    return work(postgresSource(tx));
  });
}

/** SQLite has no nested BEGIN, so the target transaction is its own statement. */
async function withTargetTransaction<T>(endpoint: TransferEndpoint, work: (target: RowTarget) => Promise<T>): Promise<T> {
  if (endpoint.provider === "sqlite") {
    const target = sqliteTarget(endpoint.db, sqliteSource(endpoint.db));
    endpoint.db.exec("BEGIN IMMEDIATE");
    try {
      const result = await work(target);
      endpoint.db.exec("COMMIT");
      return result;
    } catch (error) {
      endpoint.db.exec("ROLLBACK");
      throw error;
    }
  }
  return endpoint.sql.begin(async (tx) => work(postgresTarget(tx, postgresSource(tx))));
}

function targetFor(endpoint: TransferEndpoint): RowTarget {
  return endpoint.provider === "sqlite"
    ? sqliteTarget(endpoint.db, sqliteSource(endpoint.db))
    : postgresTarget(endpoint.sql, postgresSource(endpoint.sql));
}

/**
 * A value in the shape both engines agree on, for the reconciliation digest.
 *
 * The digest answers one question: did the target receive every value the source
 * held? Two drivers do not spell the same value identically and never will —
 * PostgreSQL returns `timestamptz` as a `Date` and its `bigint` columns as
 * strings, while SQLite returns the ISO text it stored and a number. Comparing
 * raw values would report a difference on every row of every table. So each
 * value is reduced to a representation both can produce: timestamps as UTC ISO
 * text, sequences as numbers, JSON as the parsed document, text as itself.
 */
function digestValue(spec: MigrationEntitySpec, column: string, value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if ((spec.jsonColumns ?? []).includes(column)) {
    if (typeof value !== "string") return value;
    try {
      return JSON.parse(value) as unknown;
    } catch {
      throw new ProviderTransferError("SOURCE_READ_FAILED", "A source row holds invalid JSON in " + column + ".");
    }
  }
  if (column.endsWith("_at")) {
    const date = value instanceof Date ? value : new Date(value as string | number);
    if (Number.isNaN(date.getTime())) throw new ProviderTransferError("SOURCE_READ_FAILED", "A source row holds an unparseable " + column + ".");
    return date.toISOString();
  }
  if (typeof value === "bigint") return Number(value);
  // The only `bigint` columns in the portable schema are the conversation
  // sequences; postgres.js renders those as strings and SQLite as numbers.
  if (typeof value === "string" && column.endsWith("_sequence") && /^-?\d+$/.test(value)) return Number(value);
  return value;
}

function rowDigestLine(spec: MigrationEntitySpec, row: TransferRow): string {
  const normalized: Record<string, unknown> = {};
  for (const column of spec.columns) normalized[column] = digestValue(spec, column, row[column]);
  return canonicalJson(normalized);
}

type Digest = { rows: number; hash: string };

/** SHA-256 over the canonical form of every row, in primary-key order. */
async function digestTable(reader: RowSource, table: string, spec: MigrationEntitySpec, pageSize: number): Promise<Digest> {
  const hash = createHash("sha256");
  let rows = 0;
  for (;;) {
    const page = await reader.page(table, spec.columns, spec.primaryKey, rows, pageSize);
    for (const row of page) {
      hash.update(rowDigestLine(spec, row));
      hash.update("\n");
    }
    rows += page.length;
    if (page.length < pageSize) break;
  }
  return { rows, hash: hash.digest("hex") };
}

const MEDIA_REFS_SPEC: MigrationEntitySpec = Object.freeze({
  table: "article_media_refs",
  primaryKey: ["article_id", "locale", "asset_id"],
  columns: ["article_id", "locale", "asset_id"],
});

/** The media references the translation entity carries, keyed by article+locale. */
async function readArticleMediaRefs(reader: RowSource, pageSize: number): Promise<Map<string, string[]>> {
  const refs = new Map<string, string[]>();
  const total = await reader.rowCount("article_media_refs");
  for (let offset = 0; offset < total; offset += pageSize) {
    for (const row of await reader.page("article_media_refs", MEDIA_REFS_SPEC.columns, MEDIA_REFS_SPEC.primaryKey, offset, pageSize)) {
      const key = String(row.article_id) + "\u0000" + String(row.locale);
      const list = refs.get(key) ?? [];
      list.push(String(row.asset_id));
      refs.set(key, list);
    }
  }
  return refs;
}

function entityIdFor(spec: MigrationEntitySpec, row: TransferRow): string {
  const values = spec.primaryKey.map((column) => row[column]);
  if (values.some((value) => typeof value !== "string" || value.length === 0)) {
    throw new ProviderTransferError("SOURCE_READ_FAILED", "A source row has no usable primary key.");
  }
  return spec.primaryKey.length === 1 ? (values[0] as string) : JSON.stringify(values);
}

/**
 * Comments before their replies.
 *
 * Every other table can be written in primary-key order, but a comment may
 * reference a parent that sorts after it. The order is computed from the rows
 * already in memory — a comment graph is small even on a busy site — and a broken
 * graph (a cycle, or a parent outside the copy) fails the transfer instead of
 * writing a reply whose parent never appears.
 */
function orderComments(rows: readonly TransferRow[]): TransferRow[] {
  const byId = new Map<string, TransferRow>();
  for (const row of rows) byId.set(String(row.id), row);
  const ordered: TransferRow[] = [];
  const placed = new Set<string>();
  const visiting = new Set<string>();
  const place = (row: TransferRow): void => {
    const id = String(row.id);
    if (placed.has(id)) return;
    if (visiting.has(id)) throw new ProviderTransferError("SOURCE_READ_FAILED", "The comment tree contains a cycle.");
    visiting.add(id);
    const parentId = row.parent_comment_id;
    if (parentId !== null && parentId !== undefined) {
      const parent = byId.get(String(parentId));
      if (!parent) throw new ProviderTransferError("SOURCE_READ_FAILED", "A comment references a parent that does not exist.");
      place(parent);
    }
    visiting.delete(id);
    placed.add(id);
    ordered.push(row);
  };
  // Sorting first keeps the report deterministic even though the walk does not
  // depend on it; a copy that reorders between runs is hard to read.
  for (const row of [...rows].sort((left, right) => String(left.id).localeCompare(String(right.id)))) place(row);
  return ordered;
}

function assertPlanCoversEntities(): void {
  const expected = getSupportedMigrationEntityTypes().slice().sort();
  const planned = [...PROVIDER_TRANSFER_ORDER].slice().sort();
  if (expected.length !== planned.length || expected.some((entity, index) => entity !== planned[index])) {
    throw new ProviderTransferError(
      "INVALID_OPTIONS",
      "The transfer plan does not match the replay entity allowlist; they must move together.",
    );
  }
}

async function assertTargetEmpty(target: RowSource): Promise<void> {
  for (const table of [...PROVIDER_TRANSFER_ORDER, ...ASSOCIATION_TABLES]) {
    if ((await target.rowCount(table)) > 0) {
      // A table name is not a row value and is the only detail that makes the
      // refusal actionable.
      throw new ProviderTransferError("TARGET_NOT_EMPTY", `The target database already contains application rows (${table}).`);
    }
  }
}

/**
 * Write one table, in primary-key order, with the two ordering exceptions the
 * schema needs: comments (parents first) and translations (which also own their
 * media reference rows).
 */
async function copyTable(
  source: RowSource,
  writer: RowTarget,
  spec: MigrationEntitySpec,
  table: string,
  mediaRefs: Map<string, string[]>,
  pageSize: number,
): Promise<number> {
  if (table === "article_comments") {
    const rows: TransferRow[] = [];
    for (;;) {
      const page = await source.page(table, spec.columns, spec.primaryKey, rows.length, pageSize);
      rows.push(...page);
      if (page.length < pageSize) break;
    }
    for (const row of orderComments(rows)) await writeRow(writer, spec, table, row, mediaRefs);
    return rows.length;
  }
  let written = 0;
  for (;;) {
    const page = await source.page(table, spec.columns, spec.primaryKey, written, pageSize);
    for (const row of page) await writeRow(writer, spec, table, row, mediaRefs);
    written += page.length;
    if (page.length < pageSize) break;
  }
  return written;
}

async function writeRow(
  writer: RowTarget,
  spec: MigrationEntitySpec,
  table: string,
  row: TransferRow,
  mediaRefs: Map<string, string[]>,
): Promise<void> {
  const entityId = entityIdFor(spec, row);
  const input: Record<string, unknown> = { ...row };
  if (table === "article_translations") {
    // The journal's reserved key: the applier validates that a translation
    // carries its *complete* reference snapshot, exactly as replay requires.
    input[ARTICLE_MEDIA_REFS_SNAPSHOT] = mediaRefs.get(String(row.article_id) + "\u0000" + String(row.locale)) ?? [];
  }
  const prepared = prepareMigrationRowPayload(writer.provider, table, entityId, input);
  await writer.insert(prepared.spec.table, prepared.columns, prepared.values, new Set(prepared.spec.jsonColumns ?? []));
  if (prepared.articleMediaRefs !== null) {
    const [articleId, locale] = prepared.primaryKeyValues;
    await writer.deleteArticleMediaRefs(articleId, locale);
    for (const assetId of prepared.articleMediaRefs) await writer.insertArticleMediaRef(assetId, articleId, locale);
  }
}

/**
 * Copy every portable row from `source` into an empty `target`.
 *
 * Reads happen inside one source snapshot; writes happen inside one target
 * transaction that is committed only if the reconciliation pass agrees with the
 * source it just read. A dry run validates the source the same way — every row
 * through the replay allowlist — and stops before touching the target.
 */
export async function transferProviderData(
  input: { source: TransferEndpoint; target: TransferEndpoint } & TransferOptions,
): Promise<ProviderTransferReport> {
  assertPlanCoversEntities();
  const pageSize = validatePageSize(input.pageSize);

  return withSourceSnapshot(input.source, async (source) => {
    const mediaRefs = await readArticleMediaRefs(source, pageSize);

    if (input.dryRun) {
      const tables: TransferTableReport[] = [];
      let totalRows = 0;
      for (const table of [...PROVIDER_TRANSFER_ORDER, ...ASSOCIATION_TABLES]) {
        const spec = table === "article_media_refs" ? MEDIA_REFS_SPEC : getMigrationEntitySpec(table);
        const measured = await digestTable(source, table, spec, pageSize);
        totalRows += measured.rows;
        // Validate every row through the same allowlist the target will apply,
        // so a dry run fails on data the real run would reject.
        for (let offset = 0; offset < measured.rows; offset += pageSize) {
          for (const row of await source.page(table, spec.columns, spec.primaryKey, offset, pageSize)) {
            if (table === "article_media_refs") continue;
            prepareMigrationRowPayload(input.target.provider, table, entityIdFor(spec, row), table === "article_translations"
              ? { ...row, [ARTICLE_MEDIA_REFS_SNAPSHOT]: mediaRefs.get(String(row.article_id) + "\u0000" + String(row.locale)) ?? [] }
              : row);
          }
        }
        const report: TransferTableReport = {
          table, sourceRows: measured.rows, targetRows: 0,
          sourceDigest: measured.hash, targetDigest: "", matched: false,
        };
        tables.push(report);
        input.onTable?.(report);
      }
      return {
        source: source.provider,
        target: input.target.provider,
        applied: false,
        tables,
        totalRows,
        mediaAssets: await source.rowCount("media_assets"),
        ok: true,
      };
    }

    const tables = await withTargetTransaction(input.target, async (writer) => {
      await assertTargetEmpty(writer);
      const produced: TransferTableReport[] = [];
      for (const table of PROVIDER_TRANSFER_ORDER) {
        const spec = getMigrationEntitySpec(table);
        const measured = await digestTable(source, table, spec, pageSize);
        const inserted = await copyTable(source, writer, spec, table, mediaRefs, pageSize);
        if (inserted !== measured.rows) {
          throw new ProviderTransferError("SOURCE_READ_FAILED", "The source changed while it was being copied.");
        }
        produced.push(await compareTable(writer, table, spec, measured, pageSize));
        input.onTable?.(produced[produced.length - 1]!);
      }
      const sourceRefs = await digestTable(source, "article_media_refs", MEDIA_REFS_SPEC, pageSize);
      produced.push(await compareTable(writer, "article_media_refs", MEDIA_REFS_SPEC, sourceRefs, pageSize));
      input.onTable?.(produced[produced.length - 1]!);
      const mismatched = produced.filter((report) => !report.matched);
      if (mismatched.length > 0) {
        // Roll back: a target holding most of the data is the most dangerous
        // outcome of all, because it looks like a finished migration.
        throw new ProviderTransferError(
          "RECONCILIATION_MISMATCH",
          "The copied data does not match the source (tables: " + mismatched.map((report) => report.table).join(", ") + ").",
        );
      }
      return produced;
    });

    const target = targetFor(input.target);
    return {
      source: source.provider,
      target: input.target.provider,
      applied: true,
      tables,
      totalRows: tables.reduce((total, report) => total + report.sourceRows, 0),
      mediaAssets: await target.rowCount("media_assets"),
      ok: tables.every((report) => report.matched),
    };
  });
}

async function compareTable(
  target: RowSource,
  table: string,
  spec: MigrationEntitySpec,
  source: Digest,
  pageSize: number,
): Promise<TransferTableReport> {
  const copied = await digestTable(target, table, spec, pageSize);
  return {
    table,
    sourceRows: source.rows,
    targetRows: copied.rows,
    sourceDigest: source.hash,
    targetDigest: copied.hash,
    matched: source.rows === copied.rows && source.hash === copied.hash,
  };
}

/**
 * The tables a transfer covers, for callers that want to explain the plan before
 * running it (the CLI's `--help`, the runbook, tests).
 */
export function getTransferTables(): { entities: readonly string[]; associations: readonly string[] } {
  return { entities: PROVIDER_TRANSFER_ORDER, associations: ASSOCIATION_TABLES };
}
