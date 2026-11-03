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
import { requiredText } from "../domain/validation.ts";
import { createPostgresProviderMigrationCapture, type CapturedChange } from "./postgres-provider-migration-capture.ts";

export function requestHash(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
export function parseJsonValue(value) {
  if (typeof value !== "string") return value;
  try { return JSON.parse(value); } catch { return value; }
}
export function mapMessage(row, duplicate = false) {
  const createdAt = row.created_at instanceof Date ? row.created_at.toISOString() : new Date(row.created_at).toISOString();
  return { id: row.id, conversationId: row.conversation_id, senderId: row.sender_id, body: row.body, createdAt, duplicate };
}
export function isoDate(value) {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
export function mapConversation(row) {
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
                   AND (membership.last_read_at IS NULL OR unread.created_at > membership.last_read_at)) AS unread_count
         FROM conversation_participants AS membership
         JOIN conversations AS c ON c.id = membership.conversation_id
         LEFT JOIN LATERAL (
           SELECT m.id, m.conversation_id, m.sender_id, m.body, m.created_at
           FROM messages AS m
           WHERE m.conversation_id = c.id
           ORDER BY m.created_at DESC, m.id DESC
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
export async function readArticleForAuthor(executor, { articleId, locale }) {
  const rows = await executor.unsafe(
    `SELECT a.id, a.author_id, a.slug, a.work_type, a.status, a.created_at, a.updated_at, a.published_at,
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

export async function findConversationForMember(executor, { conversationId, actorId }) {
  const rows = await executor.unsafe(CONVERSATION_FOR_MEMBER_SQL, [actorId, conversationId]);
  return rows[0] ? mapConversation(rows[0]) : null;
}

export function mapArticleComment(row) {
  const iso = (value) => value instanceof Date ? value.toISOString() : new Date(value).toISOString();
  return {
    id: row.id,
    articleId: row.article_id,
    authorId: row.author_id,
    parentCommentId: row.parent_comment_id,
    content: row.content,
    contentBlocks: row.content_blocks == null ? null : parseJsonValue(row.content_blocks),
    contentBlocksVersion: Number(row.content_blocks_version ?? 0),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    locale: row.locale,
    replies: [],
  };
}

export function mapTaxonomy(row) {
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
export function mapArticle(row) {
  const iso = (value) => value == null ? null : (value instanceof Date ? value.toISOString() : new Date(value).toISOString());
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
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    publishedAt: iso(row.published_at),
  };
}
export async function listTaxonomiesFrom(executor, { kind, locale = "zh-CN", query = "", limit = 100, offset = 0 }) {
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
export async function replaceArticleTaxonomyKind(tx, articleId, kind, ids) {
  if (ids === undefined) return;
  validateTaxonomyKind(kind);
  if (ids.length > 0) {
    const placeholders = ids.map((_, index) => "$" + (index + 2)).join(", ");
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
export function mapAuthorProfile(row) {
  const iso = (value) => value instanceof Date ? value.toISOString() : new Date(value).toISOString();
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
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}
/**
 * The featured shelf, in the order the editors put it in. Defined outside the
 * returned object so the writer can re-read it after its transaction commits
 * without re-entering the transaction — a read inside the open transaction would
 * either take a second connection or see its own uncommitted rows only.
 */
export async function readFeaturedArticles(executor, { locale = "zh-CN", limit = 20, offset = 0 } = {}) {
  validateArticleLocale(locale);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new ArticleInputError("limit must be an integer between 1 and 100.");
  if (!Number.isInteger(offset) || offset < 0 || offset > 100000) throw new ArticleInputError("offset must be an integer between 0 and 100000.");
  const rows = await executor.unsafe(
    `SELECT a.id, a.author_id, a.slug, a.work_type, a.status, a.created_at, a.updated_at, a.published_at,
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

export async function findAuthorProfile(executor, { userId, locale = "zh-CN", viewerId = null }) {
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
export async function listRelatedProfiles(executor, { relationship, userId, locale = "zh-CN", viewerId = null, limit = 50 }) {
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
export async function findMessage(tx, senderId, idempotencyKey) {
  const rows = await tx.unsafe(
    "SELECT id, conversation_id, sender_id, body, request_hash, created_at FROM messages WHERE sender_id = $1 AND idempotency_key = $2",
    [senderId, idempotencyKey],
  );
  return rows[0] ?? null;
}
export function assertSameRequest(existing, hash) {
  if (existing.request_hash !== hash) throw new IdempotencyConflictError();
  return mapMessage(existing, true);
}
export async function readArticleLikeInfo(executor, { slug, locale = "zh-CN", actorId = null }) {
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
 * pool and `captureChanges` writes row snapshots into the provider-migration
 * journal inside the caller's transaction (a no-op when no session records).
 *
 * `any` here is deliberately narrow and driver-shaped: postgres.js returns
 * dynamically typed rows and is loaded through a dynamic import in
 * `createPostgresClient`. Deriving its tagged-template generics would spread
 * driver types through every domain slice; the *port* boundary is fully typed
 * in persistence-ports.ts, which is where callers need the guarantees.
 */
export type PostgresStoreContext = {
  readonly sql: any;
  captureChanges(tx: any, transactionId: string, changes: readonly CapturedChange[]): Promise<void>;
};

export function createPostgresStoreContext(sql: any): PostgresStoreContext {
  const migrationCapture = createPostgresProviderMigrationCapture(sql);
  return {
    sql,
    async captureChanges(tx, transactionId, changes) {
      await migrationCapture.captureInTransaction(tx, transactionId, changes);
    },
  };
}
