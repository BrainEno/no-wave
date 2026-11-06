import { performance } from "node:perf_hooks";
import { MEDIA_SRC_PATTERN } from "../application/media-reference-pattern.ts";
import type { PgDatabase } from "./postgres-driver.ts";
import {
  MEDIA_AUDIT_MAX_BODY_BYTES,
  ProviderMediaComparisonError,
  boundedMediaInteger,
  compareMediaKeys,
  mediaSnapshotRows,
  mediaSnapshotText,
  withPostgresMediaSnapshot,
  withSqliteMediaSnapshot,
  type MediaSnapshot,
} from "./provider-migration-media-snapshot.ts";

type Provider = "sqlite" | "postgres";
type AuditErrorCode = "INVALID_OPTIONS" | "INVALID_DATA" | "ROW_LIMIT_EXCEEDED" | "REFERENCE_LIMIT_EXCEEDED" | "TIME_LIMIT_EXCEEDED" | "DATABASE_READ_FAILED";
const errorMessages: Record<AuditErrorCode, string> = {
  INVALID_OPTIONS: "Invalid media materialization audit options.",
  INVALID_DATA: "Media materialization audit encountered unsupported or oversized data.",
  ROW_LIMIT_EXCEEDED: "Media materialization audit exceeded its per-table row limit.",
  REFERENCE_LIMIT_EXCEEDED: "Media materialization audit exceeded its per-document reference limit.",
  TIME_LIMIT_EXCEEDED: "Media materialization audit exceeded its time limit.",
  DATABASE_READ_FAILED: "Media materialization audit could not read the database.",
};

/** Does not retain a database error, cause, raw row, content, path or parameters. */
export class ProviderMediaAuditError extends Error {
  readonly code: AuditErrorCode;
  constructor(code: AuditErrorCode) {
    super(errorMessages[code]);
    this.name = "ProviderMediaAuditError";
    this.code = code;
  }
}

type AuditLimits = {
  pageSize?: number;
  maxRowsPerTable?: number;
  maxDurationMs?: number;
  maxReferencesPerDocument?: number;
  maxBodyBytes?: number;
};
type AuditOptions = AuditLimits & (
  | { provider: "sqlite"; sqliteFilename: string }
  | { provider: "postgres"; postgres: PgDatabase }
);

/** Counts are sensitive operational data, but contain no IDs or source content. */
export type ProviderMediaMaterializationAudit = {
  kind: "media-materialization-audit";
  provider: Provider;
  scanned: { assets: number; translations: number; articleReferences: number; profiles: number };
  articles: {
    missingReferences: number;
    unexpectedReferences: number;
    referencesWithoutTranslation: number;
    missingAssets: number;
    danglingAssets: number;
  };
  avatars: { missingReferences: number; unexpectedLinks: number; missingAssets: number; danglingAssets: number };
};

type AuditState = {
  pageSize: number;
  rowLimit: number;
  bodyLimit: number;
  referenceLimit: number;
  checkTime(): void;
};
type Translation = { key: [string, string]; content: unknown };
type Reference = { key: [string, string, string] };

// The application creates lowercase UUIDs and resolves the scan pattern to
// lowercase IDs. Use that shared pattern, anchored, rather than duplicating its
// UUID rules. Unsupported historical IDs fail instead of being silently skipped.
const canonicalAssetPath = new RegExp(`^(?:${MEDIA_SRC_PATTERN.source})$`, MEDIA_SRC_PATTERN.flags.replace("g", ""));
function isCanonicalAssetId(id: string): boolean {
  return id.length === 36 && id === id.toLowerCase() && canonicalAssetPath.test(`/media/${id}`);
}

function mediaIds(text: string, state: AuditState): Set<string> {
  // Cloning the shared application regex avoids relying on its mutable
  // lastIndex while retaining exactly the reader/writer's matching rule.
  const pattern = new RegExp(MEDIA_SRC_PATTERN.source, MEDIA_SRC_PATTERN.flags);
  const ids = new Set<string>();
  let matches = 0;
  for (const match of text.matchAll(pattern)) {
    if (++matches % 256 === 0) state.checkTime();
    ids.add(match[1]!.toLowerCase());
    if (ids.size > state.referenceLimit) throw new ProviderMediaAuditError("REFERENCE_LIMIT_EXCEEDED");
  }
  return ids;
}

function translationMediaIds(content: unknown, state: AuditState): Set<string> {
  const raw = mediaSnapshotText(content, state.bodyLimit);
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new ProviderMediaAuditError("INVALID_DATA"); }
  if (!Array.isArray(parsed)) throw new ProviderMediaAuditError("INVALID_DATA");
  // The media store's raw scan reads SQLite JSON text and PostgreSQL JSONB::text.
  // Scan exactly that representation, not a re-serialized parsed value.
  return mediaIds(raw, state);
}

function assertOrdered(key: readonly string[], previous: readonly string[] | undefined): void {
  if (previous && compareMediaKeys(key, previous) <= 0) throw new ProviderMediaAuditError("INVALID_DATA");
}

async function* translations(snapshot: MediaSnapshot, state: AuditState): AsyncGenerator<Translation> {
  let previous: string[] | undefined;
  // At most one bounded article body may be materialized by a cursor page.
  for await (const raw of mediaSnapshotRows(snapshot, "auditTranslations", 1, state.rowLimit, state.checkTime, state.bodyLimit)) {
    state.checkTime();
    const key: [string, string] = [mediaSnapshotText(raw.article_id), mediaSnapshotText(raw.locale)];
    assertOrdered(key, previous);
    previous = key;
    yield { key, content: raw.content_blocks };
  }
}

async function* references(snapshot: MediaSnapshot, state: AuditState): AsyncGenerator<Reference> {
  let previous: string[] | undefined;
  for await (const raw of mediaSnapshotRows(snapshot, "auditReferences", state.pageSize, state.rowLimit, state.checkTime)) {
    state.checkTime();
    const key: [string, string, string] = [mediaSnapshotText(raw.article_id), mediaSnapshotText(raw.locale), mediaSnapshotText(raw.asset_id)];
    assertOrdered(key, previous);
    previous = key;
    yield { key };
  }
}

async function inspectArticles(snapshot: MediaSnapshot, assets: ReadonlySet<string>, state: AuditState, result: ProviderMediaMaterializationAudit): Promise<void> {
  const bodies = translations(snapshot, state), refs = references(snapshot, state);
  let failure: unknown;
  try {
    let body = await bodies.next(), ref = await refs.next();
    while (!body.done || !ref.done) {
      state.checkTime();
      const order = body.done ? 1 : ref.done ? -1 : compareMediaKeys(body.value.key, ref.value.key.slice(0, 2));
      if (order > 0) {
        // article_media_refs has no FK to (article_id, locale), so an orphan
        // reference can exist even when its article row still exists.
        result.scanned.articleReferences++;
        result.articles.referencesWithoutTranslation++;
        if (!assets.has(ref.value!.key[2])) result.articles.danglingAssets++;
        ref = await refs.next();
        continue;
      }
      const translation = body.value!;
      result.scanned.translations++;
      const ids = translationMediaIds(translation.content, state);
      const missing = new Set<string>();
      for (const id of ids) {
        if (assets.has(id)) missing.add(id);
        else result.articles.missingAssets++;
      }
      while (!ref.done && compareMediaKeys(translation.key, ref.value.key.slice(0, 2)) === 0) {
        const assetId = ref.value.key[2];
        result.scanned.articleReferences++;
        if (!assets.has(assetId)) result.articles.danglingAssets++;
        if (!ids.has(assetId)) result.articles.unexpectedReferences++;
        missing.delete(assetId);
        ref = await refs.next();
      }
      result.articles.missingReferences += missing.size;
      body = await bodies.next();
    }
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    const closed = await Promise.allSettled([bodies.return(undefined), refs.return(undefined)]);
    if (!failure && closed.some((item) => item.status === "rejected")) throw new ProviderMediaAuditError("DATABASE_READ_FAILED");
  }
}

async function inspectAvatars(snapshot: MediaSnapshot, assets: ReadonlySet<string>, state: AuditState, result: ProviderMediaMaterializationAudit): Promise<void> {
  let previous: string[] | undefined;
  for await (const raw of mediaSnapshotRows(snapshot, "auditAvatars", state.pageSize, state.rowLimit, state.checkTime)) {
    state.checkTime();
    const key = [mediaSnapshotText(raw.user_id)];
    assertOrdered(key, previous);
    previous = key;
    const url = raw.avatar_url === null ? null : mediaSnapshotText(raw.avatar_url);
    const link = raw.avatar_media_id === null ? null : mediaSnapshotText(raw.avatar_media_id);
    const ids = url === null ? new Set<string>() : mediaIds(url, state);
    result.scanned.profiles++;
    for (const id of ids) {
      if (!assets.has(id)) result.avatars.missingAssets++;
      else if (id !== link) result.avatars.missingReferences++;
    }
    if (link !== null) {
      if (!assets.has(link)) result.avatars.danglingAssets++;
      if (!ids.has(link)) result.avatars.unexpectedLinks++;
    }
  }
}

async function inspectSnapshot(snapshot: MediaSnapshot, provider: Provider, state: AuditState): Promise<ProviderMediaMaterializationAudit> {
  const result: ProviderMediaMaterializationAudit = {
    kind: "media-materialization-audit",
    provider,
    scanned: { assets: 0, translations: 0, articleReferences: 0, profiles: 0 },
    articles: { missingReferences: 0, unexpectedReferences: 0, referencesWithoutTranslation: 0, missingAssets: 0, danglingAssets: 0 },
    avatars: { missingReferences: 0, unexpectedLinks: 0, missingAssets: 0, danglingAssets: 0 },
  };
  // IDs are limited to canonical 36-byte UUIDs, and the row limit bounds this
  // in-memory membership set. No storage keys or asset hashes are selected.
  const assets = new Set<string>();
  for await (const raw of mediaSnapshotRows(snapshot, "auditAssets", state.pageSize, state.rowLimit, state.checkTime)) {
    state.checkTime();
    const id = mediaSnapshotText(raw.id);
    if (!isCanonicalAssetId(id) || assets.has(id)) throw new ProviderMediaAuditError("INVALID_DATA");
    assets.add(id);
    result.scanned.assets++;
  }
  await inspectArticles(snapshot, assets, state, result);
  await inspectAvatars(snapshot, assets, state, result);
  state.checkTime();
  return result;
}

/**
 * Explicit opt-in local integrity diagnostic for ONE provider. It reads private
 * article bodies and avatar URLs into memory, but never returns them. It does
 * not establish a synchronized source/target snapshot, watermark, complete
 * migration, safe deletion, or authority to cut over.
 */
export async function auditProviderMediaMaterialization(options: AuditOptions): Promise<ProviderMediaMaterializationAudit> {
  try {
    if (!options || (options.provider !== "sqlite" && options.provider !== "postgres")) throw new ProviderMediaAuditError("INVALID_OPTIONS");
    if (options.provider === "sqlite" && (typeof options.sqliteFilename !== "string" || !options.sqliteFilename.trim() || options.sqliteFilename === ":memory:" || options.sqliteFilename.startsWith("file:"))) {
      throw new ProviderMediaAuditError("INVALID_OPTIONS");
    }
    if (options.provider === "postgres" && (!options.postgres || typeof options.postgres.begin !== "function")) throw new ProviderMediaAuditError("INVALID_OPTIONS");
    const pageSize = boundedMediaInteger(options.pageSize, 100, 500);
    const rowLimit = boundedMediaInteger(options.maxRowsPerTable, 100_000, 100_000);
    const duration = boundedMediaInteger(options.maxDurationMs, 30_000, 30_000);
    const referenceLimit = boundedMediaInteger(options.maxReferencesPerDocument, 5_000, 5_000);
    const bodyLimit = boundedMediaInteger(options.maxBodyBytes, MEDIA_AUDIT_MAX_BODY_BYTES, MEDIA_AUDIT_MAX_BODY_BYTES);
    const deadline = performance.now() + duration;
    const state: AuditState = {
      pageSize, rowLimit, referenceLimit, bodyLimit,
      checkTime() { if (performance.now() >= deadline) throw new ProviderMediaAuditError("TIME_LIMIT_EXCEEDED"); },
    };
    return await (options.provider === "sqlite"
      ? withSqliteMediaSnapshot(options.sqliteFilename, "materialization", state.checkTime, (snapshot) => inspectSnapshot(snapshot, options.provider, state))
      : withPostgresMediaSnapshot(options.postgres, "materialization", state.checkTime, (snapshot) => inspectSnapshot(snapshot, options.provider, state)));
  } catch (error) {
    if (error instanceof ProviderMediaAuditError) throw error;
    if (error instanceof ProviderMediaComparisonError) throw new ProviderMediaAuditError(error.code);
    // Database/parser errors may contain private content, parameters, or paths.
    throw new ProviderMediaAuditError("DATABASE_READ_FAILED");
  }
}
