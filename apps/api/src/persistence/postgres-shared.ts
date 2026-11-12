/**
 * Shared row mappers, SQL helpers and the migration-capture context for the
 * PostgreSQL domain slices. Keeping these in one module is what lets
 * postgres-*-store.ts stay single-purpose while every slice answers with the
 * same domain-shaped records.
 */
import { createHash } from "node:crypto";
import { validateArticleLocale, validateArticleSlug } from "../domain/article.ts";
import { ArticleInputError, IdempotencyConflictError, ProfileInputError } from "../domain/errors.ts";
import { normalizeStoredRole } from "../domain/profile.ts";
import { validateTaxonomyKind } from "../domain/taxonomy.ts";
import { MEDIA_SRC_PATTERN } from "../application/media-assets.ts";
import { requiredText } from "../domain/validation.ts";
import { createPostgresProviderMigrationCapture, type CapturedChange } from "./postgres-provider-migration-capture.ts";
import type { PgDatabase, PgExecutor, PgRow } from "./postgres-driver.ts";

/**
 * PostgreSQL's unique-violation class, read off an `unknown` catch binding.
 *
 * `23505` is the one driver detail a slice is allowed to branch on — the same
 * check the SQLite slices make against its own constraint message — so it lives
 * here rather than as an `any` cast in every writer.
 */
export function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "23505";
}

export function requestHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
export function parseJsonValue(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try { return JSON.parse(value); } catch { return value; }
}
export function mapMessage(row: PgRow, duplicate = false): {
  id: string; conversationId: string; senderId: string; body: string; createdAt: string; duplicate: boolean;
} {
  const createdAt = isoDate(row.created_at);
  return { id: row.id, conversationId: row.conversation_id, senderId: row.sender_id, body: row.body, createdAt, duplicate };
}
/** A driver timestamp as ISO-8601; `DATE`/`TIMESTAMPTZ` arrive as `Date`. */
export function isoDate(value: unknown): string {
  if (value instanceof Date || typeof value === "string" || typeof value === "number") {
    return new Date(value).toISOString();
  }
  throw new TypeError("A PostgreSQL timestamp column returned a value that is not a date.");
}
/** The nullable form: a `NULL` timestamp stays `null`. */
export function isoDateOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : isoDate(value);
}
export function mapConversation(row: PgRow) {
  return {
    id: row.id,
    createdBy: row.created_by ?? null,
    participantIds: row.participant_ids ?? [],
    createdAt: isoDate(row.created_at),
    lastActivityAt: isoDate(row.last_activity_at ?? row.created_at),
    unreadCount: Number(row.unread_count ?? 0),
    lastMessage: row.latest_message_id ? mapMessage({
      id: row.latest_message_id,
      conversation_id: row.latest_message_conversation_id,
      sender_id: row.latest_message_sender_id,
      body: row.latest_message_body,
      created_at: row.latest_message_created_at,
    }) : null,
  };
}

/**
 * One conversation as one of its active members sees it.
 *
 * The executor is a parameter so the same statement can run on the pool (a plain
 * read) and inside a `sql.begin` transaction (the replay path of
 * `createConversation`, which must see the row the competing writer committed).
 */
export const CONVERSATION_FOR_MEMBER_SQL = `SELECT c.id, c.created_by, c.created_at,
                COALESCE(latest.created_at, c.created_at) AS last_activity_at,
                participants.user_ids AS participant_ids,
                latest.id AS latest_message_id,
                latest.conversation_id AS latest_message_conversation_id,
                latest.sender_id AS latest_message_sender_id,
                latest.body AS latest_message_body,
                latest.created_at AS latest_message_created_at,
                (SELECT count(*)::int FROM messages AS unread
                 WHERE unread.conversation_id = c.id
                   AND unread.sender_id <> $1
                   AND unread.conversation_sequence > membership.last_read_sequence) AS unread_count
         FROM conversation_participants AS membership
         JOIN conversations AS c ON c.id = membership.conversation_id
         LEFT JOIN LATERAL (
           SELECT m.id, m.conversation_id, m.sender_id, m.body, m.created_at
           FROM messages AS m
           WHERE m.conversation_id = c.id
           ORDER BY m.conversation_sequence DESC
           LIMIT 1
         ) AS latest ON true
         LEFT JOIN LATERAL (
           SELECT array_agg(cp.user_id ORDER BY cp.user_id) AS user_ids
           FROM conversation_participants AS cp
           WHERE cp.conversation_id = c.id AND cp.left_at IS NULL
         ) AS participants ON true
         WHERE membership.user_id = $1 AND membership.conversation_id = $2 AND membership.left_at IS NULL
         LIMIT 1`;

/**
 * One work as its author sees it, used to answer a replayed create with the work
 * it already made rather than with a frozen copy of the first response.
 */
export async function readArticleForAuthor(
  executor: PgExecutor,
  { articleId, locale }: { articleId: string; locale: string },
) {
  const rows = await executor.unsafe(
    `SELECT a.id, a.author_id, a.slug, a.work_type, a.status, a.created_at, a.updated_at, a.published_at, a.view_count, a.import_revision::text AS revision,
            t.locale, t.title, t.summary, t.content_blocks, t.content_blocks_version
     FROM articles AS a
     JOIN article_translations AS t ON t.article_id = a.id
     WHERE a.id = $1
     ORDER BY (t.locale = $2) DESC, t.created_at
     LIMIT 1`,
    [articleId, locale],
  );
  return rows[0] ? mapArticle(rows[0]) : null;
}

/**
 * The writer's read-back of a work it just committed (or just found a replay
 * of). A missing row here is an invariant violation, not a not-found answer.
 */
export async function readArticleForAuthorOrThrow(
  executor: PgExecutor,
  input: { articleId: string; locale: string },
) {
  const article = await readArticleForAuthor(executor, input);
  if (!article) throw new ArticleInputError("The article could not be read back after it was written.");
  return article;
}

export async function findConversationForMember(
  executor: PgExecutor,
  { conversationId, actorId }: { conversationId: string; actorId: string },
) {
  const rows = await executor.unsafe(CONVERSATION_FOR_MEMBER_SQL, [actorId, conversationId]);
  return rows[0] ? mapConversation(rows[0]) : null;
}

export function mapArticleComment(row: PgRow) {
  return {
    id: row.id,
    articleId: row.article_id,
    authorId: row.author_id,
    parentCommentId: row.parent_comment_id,
    content: row.content,
    contentBlocks: row.content_blocks == null ? null : parseJsonValue(row.content_blocks),
    contentBlocksVersion: Number(row.content_blocks_version ?? 0),
    createdAt: isoDate(row.created_at),
    updatedAt: isoDate(row.updated_at),
    editedAt: isoDateOrNull(row.edited_at),
    locale: row.locale,
    replies: [],
  };
}

export function mapTaxonomy(row: PgRow) {
  return {
    id: row.id,
    kind: row.kind,
    slug: row.slug,
    name: row.name,
    description: row.description ?? "",
    locale: row.locale,
    createdBy: row.created_by,
    articleCount: Number(row.article_count ?? 0),
  };
}
export function mapArticle(row: PgRow) {
  return {
    id: row.id,
    authorId: row.author_id,
    slug: row.slug,
    workType: row.work_type ?? "other",
    status: row.status,
    locale: row.locale,
    title: row.title,
    summary: row.summary,
    contentBlocks: parseJsonValue(row.content_blocks),
    contentBlocksVersion: Number(row.content_blocks_version ?? 0),
    createdAt: isoDateOrNull(row.created_at),
    updatedAt: isoDateOrNull(row.updated_at),
    publishedAt: isoDateOrNull(row.published_at),
    viewCount: Number(row.view_count ?? 0),
    ...(row.revision !== undefined || row.import_revision !== undefined ? { revision: String(row.revision ?? row.import_revision) } : {}),
  };
}
export async function listTaxonomiesFrom(
  executor: PgExecutor,
  { kind, locale = "zh-CN", query = "", limit = 100, offset = 0 }: {
    kind: string;
    locale?: string;
    query?: string;
    limit?: number;
    offset?: number;
  },
) {
  validateTaxonomyKind(kind);
  validateArticleLocale(locale);
  if (typeof query !== "string" || query.length > 200) throw new ArticleInputError("query must be a string no longer than 200 characters.");
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new ArticleInputError("limit must be an integer between 1 and 100.");
  if (!Number.isInteger(offset) || offset < 0 || offset > 1000000) throw new ArticleInputError("offset must be an integer between 0 and 1000000.");
  const normalizedQuery = query.trim() ? query.trim().toLocaleLowerCase(locale) : null;
  const rows = await executor.unsafe(
    `SELECT tax.id, tax.kind, tax.slug, tax.created_by,
            COALESCE(requested.name, fallback.name) AS name,
            COALESCE(requested.description, fallback.description, '') AS description,
            $2::text AS locale,
            (SELECT count(DISTINCT a.id)::int
             FROM article_taxonomies AS link
             JOIN articles AS a ON a.id = link.article_id AND a.status = 'published'
             JOIN article_translations AS at ON at.article_id = a.id AND at.locale = $2
             WHERE link.taxonomy_id = tax.id) AS article_count
     FROM taxonomies AS tax
     LEFT JOIN taxonomy_translations AS requested ON requested.taxonomy_id = tax.id AND requested.locale = $2
     LEFT JOIN taxonomy_translations AS fallback ON fallback.taxonomy_id = tax.id AND fallback.locale = 'zh-TW'
     WHERE tax.kind = $1 AND COALESCE(requested.name, fallback.name) IS NOT NULL
       AND ($3::text IS NULL OR position($3 in lower(COALESCE(requested.name, fallback.name))) > 0)
     ORDER BY lower(COALESCE(requested.name, fallback.name)), tax.id
     LIMIT $4 OFFSET $5`,
    [kind, locale, normalizedQuery, limit, offset],
  );
  return rows.map(mapTaxonomy);
}
/**
 * Keep `article_media_refs` equal to what this translation now says (#163).
 *
 * The PostgreSQL counterpart of the SQLite helper, inside the caller's
 * transaction for the same reason: the reference table and the body it describes
 * must commit together, or a saved image looks unreferenced in between.
 *
 * The extraction rule is the application layer's `MEDIA_SRC_PATTERN`, not a
 * second regex — a reference means the same thing on both providers.
 */
export async function replaceArticleMediaReferences(tx: PgExecutor, articleId: string, locale: string, contentBlocks: unknown) {
  await tx.unsafe("DELETE FROM article_media_refs WHERE article_id = $1 AND locale = $2", [articleId, locale]);
  const text = typeof contentBlocks === "string" ? contentBlocks : JSON.stringify(contentBlocks ?? "");
  const ids = new Set<string>();
  for (const match of text.matchAll(MEDIA_SRC_PATTERN)) ids.add(String(match[1]).toLowerCase());
  if (ids.size === 0) return;
  // `FROM media_assets` rather than a plain VALUES list: a body may name an id
  // that was never uploaded here, and a foreign-key failure must not fail the
  // article save. The join simply drops it.
  await tx.unsafe(
    `INSERT INTO article_media_refs (asset_id, article_id, locale)
     SELECT m.id, $2::uuid, $3 FROM media_assets m WHERE m.id = ANY($1::text[])
     ON CONFLICT DO NOTHING`,
    [[...ids], articleId, locale],
  );
}
export async function replaceArticleTaxonomyKind(tx: PgExecutor, articleId: string, kind: string, ids: string[] | undefined) {
  if (ids === undefined) return;
  validateTaxonomyKind(kind);
  if (ids.length > 0) {
    const placeholders = ids.map((_id, index) => "$" + (index + 2)).join(", ");
    const rows = await tx.unsafe(
      `SELECT id FROM taxonomies WHERE kind = $1 AND id IN (${placeholders})`,
      [kind, ...ids],
    );
    if (rows.length !== ids.length) throw new ArticleInputError(`All selected ${kind} IDs must reference existing ${kind} taxonomies.`);
  }
  await tx.unsafe(
    "DELETE FROM article_taxonomies WHERE article_id = $1 AND taxonomy_id IN (SELECT id FROM taxonomies WHERE kind = $2)",
    [articleId, kind],
  );
  for (const taxonomyId of ids) {
    await tx.unsafe(
      "INSERT INTO article_taxonomies (article_id, taxonomy_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
      [articleId, taxonomyId],
    );
  }
}
export function mapAuthorProfile(row: PgRow) {
  return {
    userId: row.user_id,
    role: normalizeStoredRole(row.role),
    displayName: row.display_name,
    bio: row.bio,
    avatarUrl: row.avatar_url,
    websiteUrl: row.website_url,
    locale: row.locale,
    followerCount: Number(row.follower_count ?? 0),
    followingCount: Number(row.following_count ?? 0),
    isFollowing: Boolean(row.is_following_viewer ?? false),
    createdAt: isoDate(row.created_at),
    updatedAt: isoDate(row.updated_at),
  };
}
/**
 * The featured shelf, in the order the editors put it in. Defined outside the
 * returned object so the writer can re-read it after its transaction commits
 * without re-entering the transaction — a read inside the open transaction would
 * either take a second connection or see its own uncommitted rows only.
 */
export async function readFeaturedArticles(
  executor: PgExecutor,
  { locale = "zh-CN", limit = 20, offset = 0 }: { locale?: string; limit?: number; offset?: number } = {},
) {
  validateArticleLocale(locale);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new ArticleInputError("limit must be an integer between 1 and 100.");
  if (!Number.isInteger(offset) || offset < 0 || offset > 100000) throw new ArticleInputError("offset must be an integer between 0 and 100000.");
  const rows = await executor.unsafe(
    `SELECT a.id, a.author_id, a.slug, a.work_type, a.status, a.created_at, a.updated_at, a.published_at, a.view_count, a.import_revision::text AS revision,
            t.locale, t.title, t.summary, t.content_blocks, t.content_blocks_version
     FROM articles AS a
     JOIN article_translations AS t ON t.article_id = a.id
     JOIN featured_articles AS f ON f.article_id = a.id
     WHERE a.status = 'published' AND t.locale = $1
     ORDER BY f.position ASC, f.created_at ASC
     LIMIT $2 OFFSET $3`,
    [locale, limit, offset],
  );
  return rows.map(mapArticle);
}

export async function findAuthorProfile(
  executor: PgExecutor,
  { userId, locale = "zh-CN", viewerId = null }: { userId: string; locale?: string; viewerId?: string | null },
) {
  requiredText("userId", userId, 300);
  validateArticleLocale(locale);
  if (viewerId !== null) requiredText("viewerId", viewerId, 300);
  const rows = await executor.unsafe(
    `SELECT p.user_id, p.role, p.avatar_url, p.website_url, p.created_at,
            GREATEST(p.updated_at, translated.updated_at) AS updated_at,
            translated.display_name, translated.bio, translated.locale,
            (SELECT count(*)::int FROM user_follows f WHERE f.followed_id = p.user_id) AS follower_count,
            (SELECT count(*)::int FROM user_follows f WHERE f.follower_id = p.user_id) AS following_count,
            CASE WHEN $3::text IS NULL THEN false ELSE EXISTS(
              SELECT 1 FROM user_follows f WHERE f.follower_id = $3 AND f.followed_id = p.user_id
            ) END AS is_following_viewer
     FROM user_profiles AS p
     JOIN LATERAL (
       SELECT t.display_name, t.bio, t.locale, t.updated_at
       FROM user_profile_translations AS t
       WHERE t.user_id = p.user_id
       ORDER BY (t.locale = $2) DESC, (t.locale = 'zh-TW') DESC, t.locale
       LIMIT 1
     ) AS translated ON true
     WHERE p.user_id = $1
     LIMIT 1`,
    [userId, locale, viewerId],
  );
  return rows[0] ? mapAuthorProfile(rows[0]) : null;
}
/**
 * A page's author profiles in one statement (#162).
 *
 * The same `LATERAL` translation pick as `findAuthorProfile`, widened from one
 * id to the distinct id set. A list of twenty articles on a three-author site
 * names each author seven times; this answers each of them once.
 */
export async function findAuthorProfilesByIds(
  executor: PgExecutor,
  { userIds, locale = "zh-CN", viewerId = null }: {
    userIds: string[];
    locale?: string;
    viewerId?: string | null;
  },
) {
  validateArticleLocale(locale);
  if (viewerId !== null) requiredText("viewerId", viewerId, 300);
  const distinct = [...new Set(userIds)];
  for (const userId of distinct) requiredText("userId", userId, 300);
  if (distinct.length === 0) return {};
  const rows = await executor.unsafe(
    `SELECT p.user_id, p.role, p.avatar_url, p.website_url, p.created_at,
            GREATEST(p.updated_at, translated.updated_at) AS updated_at,
            translated.display_name, translated.bio, translated.locale,
            (SELECT count(*)::int FROM user_follows f WHERE f.followed_id = p.user_id) AS follower_count,
            (SELECT count(*)::int FROM user_follows f WHERE f.follower_id = p.user_id) AS following_count,
            CASE WHEN $3::text IS NULL THEN false ELSE EXISTS(
              SELECT 1 FROM user_follows f WHERE f.follower_id = $3 AND f.followed_id = p.user_id
            ) END AS is_following_viewer
     FROM user_profiles AS p
     JOIN LATERAL (
       SELECT t.display_name, t.bio, t.locale, t.updated_at
       FROM user_profile_translations AS t
       WHERE t.user_id = p.user_id
       ORDER BY (t.locale = $2) DESC, (t.locale = 'zh-TW') DESC, t.locale
       LIMIT 1
     ) AS translated ON true
     WHERE p.user_id = ANY($1::text[])`,
    [distinct, locale, viewerId],
  );
  const profiles: Record<string, ReturnType<typeof mapAuthorProfile>> = {};
  for (const row of rows) profiles[row.user_id] = mapAuthorProfile(row);
  return profiles;
}
export async function listRelatedProfiles(
  executor: PgExecutor,
  { relationship, userId, locale = "zh-CN", viewerId = null, limit = 50 }: {
    relationship: "following" | "followers";
    userId: string;
    locale?: string;
    viewerId?: string | null;
    limit?: number;
  },
) {
  requiredText("userId", userId, 300);
  validateArticleLocale(locale);
  if (viewerId !== null) requiredText("viewerId", viewerId, 300);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new ProfileInputError("limit must be an integer between 1 and 100.");
  const join = relationship === "following"
    ? "relation.follower_id = $1 AND relation.followed_id = p.user_id"
    : "relation.followed_id = $1 AND relation.follower_id = p.user_id";
  const rows = await executor.unsafe(
    `SELECT p.user_id, p.role, p.avatar_url, p.website_url, p.created_at,
            GREATEST(p.updated_at, translated.updated_at) AS updated_at,
            translated.display_name, translated.bio, translated.locale,
            (SELECT count(*)::int FROM user_follows f WHERE f.followed_id = p.user_id) AS follower_count,
            (SELECT count(*)::int FROM user_follows f WHERE f.follower_id = p.user_id) AS following_count,
            CASE WHEN $3::text IS NULL THEN false ELSE EXISTS(
              SELECT 1 FROM user_follows f WHERE f.follower_id = $3 AND f.followed_id = p.user_id
            ) END AS is_following_viewer
     FROM user_follows AS relation
     JOIN user_profiles AS p ON ${join}
     JOIN LATERAL (
       SELECT t.display_name, t.bio, t.locale, t.updated_at
       FROM user_profile_translations AS t
       WHERE t.user_id = p.user_id
       ORDER BY (t.locale = $2) DESC, (t.locale = 'zh-TW') DESC, t.locale
       LIMIT 1
     ) AS translated ON true
     ORDER BY relation.created_at DESC, p.user_id
     LIMIT $4`,
    [userId, locale, viewerId, limit],
  );
  return rows.map(mapAuthorProfile);
}
export async function findMessage(tx: PgExecutor, senderId: string, idempotencyKey: string) {
  const rows = await tx.unsafe(
    "SELECT id, conversation_id, sender_id, body, request_hash, created_at FROM messages WHERE sender_id = $1 AND idempotency_key = $2",
    [senderId, idempotencyKey],
  );
  return rows[0] ?? null;
}
export function assertSameRequest(existing: PgRow, hash: string) {
  if (existing.request_hash !== hash) throw new IdempotencyConflictError();
  return mapMessage(existing, true);
}
export async function readArticleLikeInfo(
  executor: PgExecutor,
  { slug, locale = "zh-CN", actorId = null }: { slug: string; locale?: string; actorId?: string | null },
) {
  validateArticleSlug(slug);
  validateArticleLocale(locale);
  if (actorId !== null) requiredText("actorId", actorId, 300);
  const rows = await executor.unsafe(
    `SELECT a.id AS article_id, a.slug,
            count(l.user_id)::int AS like_count,
            COALESCE(bool_or(l.user_id = $3), false) AS liked_by_viewer
     FROM articles AS a
     JOIN article_translations AS t ON t.article_id = a.id
     LEFT JOIN article_likes AS l ON l.article_id = a.id
     WHERE a.slug = $1 AND a.status = 'published' AND t.locale = $2
     GROUP BY a.id, a.slug`,
    [slug, locale, actorId],
  );
  const row = rows[0];
  return row ? {
    articleId: row.article_id,
    slug: row.slug,
    likeCount: row.like_count,
    likedByViewer: row.liked_by_viewer,
  } : null;
}


/**
 * The executor surface a domain slice needs. `sql` is the shared postgres.js
 * pool (`PgDatabase`) and `captureChanges` writes row snapshots into the
 * provider-migration journal inside the caller's transaction (`PgExecutor`,
 * satisfied by both the pool and a `sql.begin` transaction).
 *
 * These are the typed driver interfaces from postgres-driver.ts (proved against
 * the real `postgres.Sql` at `createPostgresStore`), not an `any` escape hatch:
 * `satisfies Pick<TypedPersistenceAdapterContract, ...>` still checks every
 * slice's method results. Only column *values* stay dynamic (`postgres.Row`);
 * mapping them into typed domain records is each slice's job.
 */
export type PostgresStoreContext = {
  readonly sql: PgDatabase;
  captureChanges(tx: PgExecutor, transactionId: string, changes: readonly CapturedChange[]): Promise<void>;
};

export function createPostgresStoreContext(sql: PgDatabase): PostgresStoreContext {
  const migrationCapture = createPostgresProviderMigrationCapture(sql);
  return {
    sql,
    async captureChanges(tx, transactionId, changes) {
      await migrationCapture.captureInTransaction(tx, transactionId, changes);
    },
  };
}
