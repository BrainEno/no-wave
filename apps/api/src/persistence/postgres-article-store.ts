/**
 * PostgreSQL persistence slice: Article content, publication, author desks and the featured shelf.
 *
 * Composed by postgres.ts. Row mapping and shared SQL helpers live in
 * postgres-shared.ts so every slice reads rows the same way.
 */
import { randomUUID } from "node:crypto";
import { articleIdempotencyFingerprint, articleIdempotencyKeyHash, articleIdempotencyReplayMatches } from "../application/article-idempotency.ts";
import { MAX_FEATURED_ARTICLES, normalizeArticleInput, normalizeTaxonomyIds, resolveArticleCursor, validateArticleLocale, validateArticleSlug } from "../domain/article.ts";
import { ArticleAuthorizationError, ArticleInputError, ArticleNotFoundError, ArticleSlugConflictError, IdempotencyConflictError } from "../domain/errors.ts";
import { isUuid, requiredText } from "../domain/validation.ts";
import { migrationEntityKey } from "./postgres-provider-migration-capture.ts";
import { isoDate, mapArticle, readArticleForAuthor, readFeaturedArticles, replaceArticleMediaReferences, replaceArticleTaxonomyKind } from "./postgres-shared.ts";
import { createMigrationTransactionId } from "./provider-migration-journal.ts";
import type { PostgresStoreContext } from "./postgres-shared.ts";
import type { TypedPersistenceAdapterContract } from "../application/persistence-ports.ts";

export function createPostgresArticleStore(ctx: PostgresStoreContext) {
  const { sql, captureChanges } = ctx;
  return Object.freeze({
    async listPublishedArticles({ locale = "zh-CN", query = "", authorId = null, sort = "latest", limit = 20, offset = 0, cursor = null } = {}) {
      validateArticleLocale(locale);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new ArticleInputError("limit must be an integer between 1 and 100.");
      if (!Number.isInteger(offset) || offset < 0 || offset > 100000) {
        throw new ArticleInputError("offset must be an integer between 0 and 100000.");
      }
      if (typeof query !== "string" || query.length > 200) throw new ArticleInputError("query must be a string no longer than 200 characters.");
      if (authorId !== null) requiredText("authorId", authorId, 300);
      if (sort !== "latest" && sort !== "popular") throw new ArticleInputError("sort must be 'latest' or 'popular'.");
      const search = query.trim() ? query.trim() : null;
      // Escape LIKE metacharacters to preserve literal substring semantics.
      // The pg_trgm GIN indexes make non-empty title/summary searches indexable.
      const searchPattern = search === null
        ? null
        : "%" + search.replace(/[\\%_]/g, "\\$&") + "%";
      // `popular` counts every save the work has ever had — see the SQLite
      // counterpart, which must answer the same question the same way.
      const popular = sort === "popular";
      // See the SQLite counterpart for why a cursor only walks the newest-first
      // order. The placeholders are numbered as the parameters are pushed, so
      // adding the keyset cannot leave `LIMIT`/`OFFSET` pointing at the wrong one.
      const keyset = resolveArticleCursor({ cursor, sort, offset });
      const params: unknown[] = [locale, searchPattern, authorId];
      // A cursor is a millisecond ISO string. Truncating the *parameter* keeps
      // the raw indexed column on the left of the comparison, so the existing
      // articles_published_idx still answers the keyset without a function index.
      const cursorAtParam = keyset ? params.push(keyset.publishedAt) : 0;
      const keysetClause = keyset
        ? `AND (a.published_at < date_trunc('milliseconds', $${cursorAtParam}::timestamptz)
              OR (a.published_at = date_trunc('milliseconds', $${cursorAtParam}::timestamptz) AND a.id < $${params.push(keyset.id)}::uuid))`
        : "";
      params.push(limit, offset);
      const rows = await sql.unsafe(
        `SELECT a.id, a.author_id, a.slug, a.work_type, a.status, a.created_at, a.updated_at, a.published_at,
                t.locale, t.title, t.summary, t.content_blocks, t.content_blocks_version,
                ${popular ? "(SELECT count(*)::int FROM article_likes l WHERE l.article_id = a.id)" : "0"} AS like_count
         FROM articles AS a
         JOIN article_translations AS t ON t.article_id = a.id
         WHERE a.status = 'published' AND t.locale = $1
           AND ($2::text IS NULL OR t.title ILIKE $2 ESCAPE E'\\\\' OR t.summary ILIKE $2 ESCAPE E'\\\\'
             OR EXISTS (
               SELECT 1 FROM jsonb_array_elements(t.content_blocks) AS block(value)
               WHERE jsonb_typeof(block.value) = 'object' AND (block.value->>'text') ILIKE $2 ESCAPE E'\\\\'
             ))
           AND ($3::text IS NULL OR a.author_id = $3)
           ${keysetClause}
         ORDER BY ${popular ? "like_count DESC, a.published_at DESC, a.id DESC" : "a.published_at DESC, a.id DESC"}
         LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params,
      );
      return rows.map(mapArticle);
    },

    async getPublishedArticle({ slug, locale = "zh-CN" }) {
      const normalizedSlug = validateArticleSlug(slug);
      validateArticleLocale(locale);
      const rows = await sql.unsafe(
        `SELECT a.id, a.author_id, a.slug, a.work_type, a.status, a.created_at, a.updated_at, a.published_at,
                t.locale, t.title, t.summary, t.content_blocks, t.content_blocks_version
         FROM articles AS a
         JOIN article_translations AS t ON t.article_id = a.id
         WHERE a.slug = $1 AND a.status = 'published' AND t.locale = $2
         LIMIT 1`,
        [normalizedSlug, locale],
      );
      return rows[0] ? mapArticle(rows[0]) : null;
    },

    async listMyArticles({ actorId, locale = "zh-CN", limit = 50 }: { actorId: string; locale?: string; limit?: number } = { actorId: "" }) {
      requiredText("actorId", actorId, 300);
      validateArticleLocale(locale);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new ArticleInputError("limit must be an integer between 1 and 100.");
      const rows = await sql.unsafe(
        `SELECT a.id, a.author_id, a.slug, a.work_type, a.status, a.created_at, a.updated_at, a.published_at,
                t.locale, t.title, t.summary, t.content_blocks, t.content_blocks_version
         FROM articles AS a
         JOIN article_translations AS t ON t.article_id = a.id
         WHERE a.author_id = $1 AND t.locale = $2 AND a.deleted_at IS NULL
         ORDER BY a.updated_at DESC, a.id DESC
         LIMIT $3`,
        [actorId, locale, limit],
      );
      return rows.map(mapArticle);
    },

    /**
     * The author's own tombstones, newest deletion first (see the SQLite slice
     * for why the desk needs them). `purgesAt` is added by the service layer,
     * which owns the retention window; a store returns the timestamp it has.
     */
    async listMyDeletedArticles({ actorId, locale = "zh-CN", limit = 50 }: { actorId: string; locale?: string; limit?: number } = { actorId: "" }) {
      requiredText("actorId", actorId, 300);
      validateArticleLocale(locale);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new ArticleInputError("limit must be an integer between 1 and 100.");
      const rows = await sql.unsafe(
        `SELECT a.id, a.author_id, a.slug, a.work_type, a.status, a.created_at, a.updated_at, a.published_at, a.deleted_at,
                t.locale, t.title, t.summary, t.content_blocks, t.content_blocks_version,
                (SELECT count(*) FROM article_comments AS c WHERE c.article_id = a.id) AS comment_count
         FROM articles AS a
         JOIN article_translations AS t ON t.article_id = a.id
         WHERE a.author_id = $1 AND t.locale = $2 AND a.deleted_at IS NOT NULL
         ORDER BY a.deleted_at DESC, a.id DESC
         LIMIT $3`,
        [actorId, locale, limit],
      );
      return rows.map((row) => ({
        ...mapArticle(row),
        deletedAt: isoDate(row.deleted_at),
        commentCount: Number(row.comment_count ?? 0),
      }));
    },

    async createArticle({ authorId, slug, title, summary = "", locale = "zh-CN", contentBlocks, contentBlocksVersion = 0, publish = false, workType = "other", categoryIds = [], tagIds = [], idempotencyKey = null, requestedSlug }) {
      requiredText("authorId", authorId, 300);
      const input = normalizeArticleInput({ slug, title, summary, locale, contentBlocks, contentBlocksVersion, publish, workType });
      const selectedCategories = normalizeTaxonomyIds("categoryIds", categoryIds, 20);
      const selectedTags = normalizeTaxonomyIds("tagIds", tagIds, 50);
      if (idempotencyKey !== null && (typeof idempotencyKey !== "string" || idempotencyKey.length === 0 ||
          idempotencyKey.length > 300 || idempotencyKey.trim() !== idempotencyKey)) {
        throw new ArticleInputError("Idempotency-Key must be a non-empty trimmed string no longer than 300 characters.");
      }
      const keyHash = idempotencyKey === null ? null : articleIdempotencyKeyHash(authorId, idempotencyKey);
      // `requestedSlug` is undefined only for direct store callers that predate
      // the route contract; treat their explicit slug as client-supplied.
      const fingerprintSlug = requestedSlug === undefined ? input.slug : (requestedSlug ?? null);
      const fingerprintBase = {
        authorId, title: input.title, summary: input.summary, locale: input.locale,
        contentBlocks: input.contentBlocks, contentBlocksVersion: input.contentBlocksVersion,
        publish: input.publish, workType: input.workType ?? "other",
        categoryIds: [...(selectedCategories ?? [])].sort(), tagIds: [...(selectedTags ?? [])].sort(),
      };
      const fingerprintForSlug = (value: string | null) => articleIdempotencyFingerprint({ ...fingerprintBase, slug: value });
      const fingerprint = fingerprintForSlug(fingerprintSlug);
      const replayMatches = (row) => articleIdempotencyReplayMatches(
        row.request_hash,
        fingerprint,
        fingerprintSlug === null
          ? [fingerprintForSlug(input.slug), fingerprintForSlug(row.slug)]
          : [],
      );
      try {
        return await sql.begin(async (tx) => {
          const transactionId = createMigrationTransactionId();
          // A retried publish is a replay, not a second work — and it is decided
          // here rather than in the catch, because an insert that conflicts on
          // both the key and the slug raises one unique violation and PostgreSQL
          // does not promise which index reports it. Measured before this check:
          // eight of forty concurrent retries came back as a slug collision and
          // were sent to the uniquifier to be published a second time.
          if (keyHash !== null) {
            const [existing] = await tx.unsafe(
              "SELECT id, slug, request_hash FROM articles WHERE author_id = $1 AND idempotency_key_hash = $2",
              [authorId, keyHash],
            );
            if (existing) {
              if (!replayMatches(existing)) {
                throw new IdempotencyConflictError("The idempotency key was already used for a different article request.");
              }
              return readArticleForAuthor(tx, { articleId: existing.id, locale: input.locale });
            }
          }
          const rows = await tx.unsafe(
            "INSERT INTO articles (id, author_id, slug, work_type, status, idempotency_key_hash, request_hash, published_at) " +
            "VALUES ($1, $2, $3, $4, $5, $6, $7, CASE WHEN $8 THEN date_trunc('milliseconds', now()) ELSE NULL END) " +
            "ON CONFLICT (author_id, idempotency_key_hash) WHERE idempotency_key_hash IS NOT NULL DO NOTHING " +
            "RETURNING id, author_id, slug, work_type, status, created_at, updated_at, published_at",
            [randomUUID(), authorId, input.slug, input.workType ?? "other", input.publish ? "published" : "draft",
              keyHash, keyHash === null ? null : fingerprint, input.publish],
          );
          if (rows.length === 0) {
            const [existing] = await tx.unsafe(
              "SELECT id, slug, request_hash FROM articles WHERE author_id = $1 AND idempotency_key_hash = $2",
              [authorId, keyHash],
            );
            if (!existing) throw new ArticleInputError("The article could not be created; retry the request.");
            if (!replayMatches(existing)) {
              throw new IdempotencyConflictError("The idempotency key was already used for a different article request.");
            }
            return readArticleForAuthor(tx, { articleId: existing.id, locale: input.locale });
          }
          const article = rows[0];
          const translations = await tx.unsafe(
            "INSERT INTO article_translations (article_id, locale, title, summary, content_blocks, content_blocks_version) VALUES ($1, $2, $3, $4, $5::jsonb, $6) RETURNING locale, title, summary, content_blocks, content_blocks_version",
            [article.id, input.locale, input.title, input.summary, input.contentBlocks, input.contentBlocksVersion],
          );
          await replaceArticleMediaReferences(tx, article.id, input.locale, input.contentBlocks);
          await replaceArticleTaxonomyKind(tx, article.id, "category", selectedCategories);
          await replaceArticleTaxonomyKind(tx, article.id, "tag", selectedTags);
          const [articleSnapshot, translationSnapshot, links] = await Promise.all([
            tx.unsafe("SELECT * FROM articles WHERE id = $1", [article.id]),
            tx.unsafe("SELECT * FROM article_translations WHERE article_id = $1 AND locale = $2", [article.id, input.locale]),
            tx.unsafe("SELECT * FROM article_taxonomies WHERE article_id = $1", [article.id]),
          ]);
          await captureChanges(tx, transactionId, [
            { entityType: "articles", entityId: article.id, operation: "upsert", payload: articleSnapshot[0] },
            { entityType: "article_translations", entityId: migrationEntityKey(article.id, input.locale), operation: "upsert", payload: translationSnapshot[0] },
            ...links.map((link) => ({ entityType: "article_taxonomies", entityId: migrationEntityKey(link.article_id, link.taxonomy_id), operation: "upsert" as const, payload: link })),
          ]);
          return mapArticle({ ...article, ...translations[0] });
        });
      } catch (error) {
        if (error?.code !== "23505") throw error;
        // Two writers raced on the same key and the slug index reported the
        // collision first: the work exists now, so answer with it rather than
        // sending the author back to the slug uniquifier for a second copy.
        if (keyHash !== null) {
          const [existing] = await sql.unsafe(
            "SELECT id, slug, request_hash FROM articles WHERE author_id = $1 AND idempotency_key_hash = $2",
            [authorId, keyHash],
          );
          if (existing) {
            if (!replayMatches(existing)) {
              throw new IdempotencyConflictError("The idempotency key was already used for a different article request.");
            }
            return readArticleForAuthor(sql, { articleId: existing.id, locale: input.locale });
          }
        }
        throw new ArticleSlugConflictError();
      }
    },

    async updateArticle({ articleId, actorId, slug, title, summary = "", locale = "zh-CN", contentBlocks, contentBlocksVersion = 0, publish = false, workType = undefined, categoryIds = undefined, tagIds = undefined }) {

      if (!isUuid(articleId)) throw new ArticleInputError("articleId must be a valid article ID.");
      requiredText("actorId", actorId, 300);
      const input = normalizeArticleInput({ slug, title, summary, locale, contentBlocks, contentBlocksVersion, publish, workType });
      const selectedCategories = normalizeTaxonomyIds("categoryIds", categoryIds, 20);
      const selectedTags = normalizeTaxonomyIds("tagIds", tagIds, 50);
      try {
        return await sql.begin(async (tx) => {
          const transactionId = createMigrationTransactionId();
          const ownership = await tx.unsafe("SELECT author_id, deleted_at FROM articles WHERE id = $1 FOR UPDATE", [articleId]);
          if (!ownership[0] || ownership[0].deleted_at) throw new ArticleNotFoundError();
          if (ownership[0].author_id !== actorId) throw new ArticleAuthorizationError();
          const previousLinks = await tx.unsafe("SELECT * FROM article_taxonomies WHERE article_id = $1", [articleId]);
          const rows = await tx.unsafe(
            "UPDATE articles SET slug = $2, work_type = COALESCE($6, work_type), status = $3, published_at = CASE WHEN $4 THEN date_trunc('milliseconds', COALESCE(published_at, now())) ELSE NULL END, updated_at = now() WHERE id = $1 AND author_id = $5 RETURNING id, author_id, slug, work_type, status, created_at, updated_at, published_at",
            [articleId, input.slug, input.publish ? "published" : "draft", input.publish, actorId, input.workType ?? null],
          );
          if (!rows[0]) throw new ArticleNotFoundError();
          const translations = await tx.unsafe(
            "INSERT INTO article_translations (article_id, locale, title, summary, content_blocks, content_blocks_version) VALUES ($1, $2, $3, $4, $5::jsonb, $6) ON CONFLICT (article_id, locale) DO UPDATE SET title = EXCLUDED.title, summary = EXCLUDED.summary, content_blocks = EXCLUDED.content_blocks, content_blocks_version = EXCLUDED.content_blocks_version, updated_at = now() RETURNING locale, title, summary, content_blocks, content_blocks_version",
            [articleId, input.locale, input.title, input.summary, input.contentBlocks, input.contentBlocksVersion],
          );
          await replaceArticleMediaReferences(tx, articleId, input.locale, input.contentBlocks);
          await replaceArticleTaxonomyKind(tx, articleId, "category", selectedCategories);
          await replaceArticleTaxonomyKind(tx, articleId, "tag", selectedTags);
          const [articleSnapshot, translationSnapshot, currentLinks] = await Promise.all([
            tx.unsafe("SELECT * FROM articles WHERE id = $1", [articleId]),
            tx.unsafe("SELECT * FROM article_translations WHERE article_id = $1 AND locale = $2", [articleId, input.locale]),
            tx.unsafe("SELECT * FROM article_taxonomies WHERE article_id = $1", [articleId]),
          ]);
          const currentIds = new Set(currentLinks.map((link) => migrationEntityKey(link.article_id, link.taxonomy_id)));
          await captureChanges(tx, transactionId, [
            { entityType: "articles", entityId: articleId, operation: "upsert", payload: articleSnapshot[0] },
            { entityType: "article_translations", entityId: migrationEntityKey(articleId, input.locale), operation: "upsert", payload: translationSnapshot[0] },
            ...currentLinks.map((link) => ({ entityType: "article_taxonomies", entityId: migrationEntityKey(link.article_id, link.taxonomy_id), operation: "upsert" as const, payload: link })),
            ...previousLinks.filter((link) => !currentIds.has(migrationEntityKey(link.article_id, link.taxonomy_id))).map((link) => ({ entityType: "article_taxonomies", entityId: migrationEntityKey(link.article_id, link.taxonomy_id), operation: "delete" as const, payload: null })),
          ]);
          return mapArticle({ ...rows[0], ...translations[0] });
        });
      } catch (error) {
        if (error?.code === "23505") throw new ArticleSlugConflictError();
        throw error;
      }
    },

    /**
     * Delete one of the author's own works (see the SQLite slice for the
     * reasoning): the row becomes a tombstone, the status returns to 'draft' so
     * every published read hides it, and the slug is released so rewriting the
     * same title cannot collide with the tombstone.
     */
    async deleteArticle({ articleId, actorId }) {
      if (!isUuid(articleId)) throw new ArticleInputError("articleId must be a valid article ID.");
      requiredText("actorId", actorId, 300);
      return await sql.begin(async (tx) => {
        const transactionId = createMigrationTransactionId();
        const existing = await tx.unsafe("SELECT author_id, slug, deleted_at FROM articles WHERE id = $1 FOR UPDATE", [articleId]);
        if (!existing[0] || existing[0].deleted_at) throw new ArticleNotFoundError("The article was not found.");
        if (existing[0].author_id !== actorId) throw new ArticleAuthorizationError("Only the article author can delete it.");
        const releasedSlug = `${existing[0].slug}-deleted-${articleId.slice(0, 8)}`;
        const rows = await tx.unsafe(
          "UPDATE articles SET status = 'draft', deleted_at = now(), slug = $2, updated_at = now() WHERE id = $1 RETURNING id, deleted_at",
          [articleId, releasedSlug],
        );
        if (!rows[0]) throw new ArticleNotFoundError("The article was not found.");
        const snapshot = await tx.unsafe("SELECT * FROM articles WHERE id = $1", [articleId]);
        await captureChanges(tx, transactionId, [
          { entityType: "articles", entityId: articleId, operation: "upsert", payload: snapshot[0] },
        ]);
        return { id: articleId, deletedAt: isoDate(rows[0].deleted_at) };
      });
    },

    /**
     * Bring one of the author's own tombstones back, as a draft.
     *
     * Restoring must never republish: deleting withdrew the work from the public
     * site, and putting a public address back is the author's decision to make
     * again, not a side effect of undoing a mistake.
     *
     * The released address is reclaimed inside the UPDATE and only while nothing
     * else holds it, so a restore cannot fail with a conflict over a slug the
     * author cannot see and cannot clear.
     */
    async restoreArticle({ articleId, actorId, locale = "zh-CN" }) {
      if (!isUuid(articleId)) throw new ArticleInputError("articleId must be a valid article ID.");
      requiredText("actorId", actorId, 300);
      validateArticleLocale(locale);
      return await sql.begin(async (tx) => {
        const transactionId = createMigrationTransactionId();
        const existing = await tx.unsafe("SELECT author_id, slug, deleted_at FROM articles WHERE id = $1 FOR UPDATE", [articleId]);
        if (!existing[0] || !existing[0].deleted_at) throw new ArticleNotFoundError("The article was not found.");
        if (existing[0].author_id !== actorId) throw new ArticleAuthorizationError("Only the article author can restore it.");
        const translation = await tx.unsafe("SELECT locale FROM article_translations WHERE article_id = $1 AND locale = $2", [articleId, locale]);
        if (!translation[0]) throw new ArticleNotFoundError(`The article has no ${locale} translation.`);
        const suffix = `-deleted-${articleId.slice(0, 8)}`;
        const current = existing[0].slug;
        const preferred = current.endsWith(suffix) ? current.slice(0, -suffix.length) : current;
        const rows = await tx.unsafe(
          `UPDATE articles SET deleted_at = NULL, status = 'draft', updated_at = now(),
             slug = CASE WHEN EXISTS (SELECT 1 FROM articles AS o WHERE o.slug = $2 AND o.id <> $1) THEN articles.slug ELSE $2 END
           WHERE id = $1 RETURNING id, author_id, slug, work_type, status, created_at, updated_at, published_at`,
          [articleId, preferred],
        );
        if (!rows[0]) throw new ArticleNotFoundError("The article was not found.");
        const translations = await tx.unsafe(
          "SELECT locale, title, summary, content_blocks, content_blocks_version FROM article_translations WHERE article_id = $1 AND locale = $2",
          [articleId, locale],
        );
        const snapshot = await tx.unsafe("SELECT * FROM articles WHERE id = $1", [articleId]);
        await captureChanges(tx, transactionId, [
          { entityType: "articles", entityId: articleId, operation: "upsert", payload: snapshot[0] },
        ]);
        return mapArticle({ ...rows[0], ...translations[0] });
      });
    },

    /**
     * Hard-delete tombstones past the retention window.
     *
     * The only irreversible step in this slice, and therefore unreachable from
     * the desk: the author has no "delete forever" button, and the window is
     * what turns "you can undo this" into a promise with an expiry date.
     *
     * Children are captured before the delete rather than left to the foreign
     * keys, because the migration journal — not the cascade — is what a replica
     * replays. Bounded and awaitable, like `pruneExpiredIdentityState`: the
     * sweep never outlives the request that triggered it.
     */
    async purgeExpiredArticles({ retentionDays = 30, now = new Date(), limit = 100 }: { retentionDays?: number; now?: Date | string; limit?: number } = {}) {
      if (!Number.isInteger(retentionDays) || retentionDays < 1 || retentionDays > 3650) {
        throw new ArticleInputError("retentionDays must be an integer between 1 and 3650.");
      }
      if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new ArticleInputError("limit must be an integer between 1 and 500.");
      const at = now instanceof Date ? now : new Date(now);
      if (Number.isNaN(at.getTime())) throw new ArticleInputError("now must be a valid date.");
      const cutoff = new Date(at.getTime() - retentionDays * 86_400_000).toISOString();
      return await sql.begin(async (tx) => {
        const transactionId = createMigrationTransactionId();
        // Claim each candidate before inspecting its children. A restore holds
        // this same row lock: an ordinary MVCC read could otherwise see its old
        // tombstone and later delete the successfully restored work by ID.
        // Skipped rows remain eligible for a later sweep, while concurrent
        // sweepers can progress without counting or journaling the same row.
        const expired = (await tx.unsafe(
          "SELECT id FROM articles WHERE deleted_at IS NOT NULL AND deleted_at < $1 ORDER BY deleted_at, id LIMIT $2 FOR UPDATE SKIP LOCKED",
          [cutoff, limit],
        )).map((row) => row.id);
        if (expired.length === 0) return { purged: 0 };
        const [translations, likes, comments, links] = await Promise.all([
          tx.unsafe("SELECT article_id, locale FROM article_translations WHERE article_id = ANY($1::uuid[])", [expired]),
          tx.unsafe("SELECT article_id, user_id FROM article_likes WHERE article_id = ANY($1::uuid[])", [expired]),
          tx.unsafe("SELECT id FROM article_comments WHERE article_id = ANY($1::uuid[])", [expired]),
          tx.unsafe("SELECT article_id, taxonomy_id FROM article_taxonomies WHERE article_id = ANY($1::uuid[])", [expired]),
        ]);
        await tx.unsafe("DELETE FROM articles WHERE id = ANY($1::uuid[])", [expired]);
        await captureChanges(tx, transactionId, [
          ...expired.map((id) => ({ entityType: "articles", entityId: id, operation: "delete" as const, payload: null })),
          ...translations.map((row) => ({ entityType: "article_translations", entityId: migrationEntityKey(row.article_id, row.locale), operation: "delete" as const, payload: null })),
          ...likes.map((row) => ({ entityType: "article_likes", entityId: migrationEntityKey(row.article_id, row.user_id), operation: "delete" as const, payload: null })),
          ...comments.map((row) => ({ entityType: "article_comments", entityId: row.id, operation: "delete" as const, payload: null })),
          ...links.map((row) => ({ entityType: "article_taxonomies", entityId: migrationEntityKey(row.article_id, row.taxonomy_id), operation: "delete" as const, payload: null })),
        ]);
        return { purged: expired.length };
      });
    },

    async listLikedArticles({ actorId, locale = "zh-CN", limit = 50 }: { actorId: string; locale?: string; limit?: number } = { actorId: "" }) {
      requiredText("actorId", actorId, 300);
      validateArticleLocale(locale);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
        throw new ArticleInputError("limit must be an integer between 1 and 100.");
      }
      const rows = await sql.unsafe(
        `SELECT a.id, a.author_id, a.slug, a.work_type, a.status, a.created_at, a.updated_at, a.published_at,
                t.locale, t.title, t.summary, t.content_blocks, t.content_blocks_version
         FROM article_likes AS likes
         JOIN articles AS a ON a.id = likes.article_id AND a.status = 'published'
         JOIN article_translations AS t ON t.article_id = a.id AND t.locale = $2
         WHERE likes.user_id = $1
         ORDER BY likes.created_at DESC, a.id DESC
         LIMIT $3`,
        [actorId, locale, limit],
      );
      return rows.map(mapArticle);
    },

    async listRelatedArticles({ slug, locale = "zh-CN", limit = 6 }: { slug: string; locale?: string; limit?: number } = { slug: "" }) {
      validateArticleSlug(slug);
      validateArticleLocale(locale);
      if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
        throw new ArticleInputError("limit must be an integer between 1 and 50.");
      }
      const rows = await sql.unsafe(
        `WITH target AS (
          SELECT a.id, a.author_id
          FROM articles AS a
          JOIN article_translations AS t ON t.article_id = a.id AND t.locale = $2
          WHERE a.slug = $1 AND a.status = 'published'
          LIMIT 1
        ),
        candidates AS (
          SELECT a.id, a.author_id, a.slug, a.work_type, a.status, a.created_at, a.updated_at, a.published_at,
                 t.locale, t.title, t.summary, t.content_blocks, t.content_blocks_version,
                 count(DISTINCT candidate_link.taxonomy_id)::int AS shared_taxonomy_count,
                 (a.author_id = target.author_id) AS same_author
          FROM target
          JOIN articles AS a ON a.status = 'published' AND a.id <> target.id
          JOIN article_translations AS t ON t.article_id = a.id AND t.locale = $2
          LEFT JOIN article_taxonomies AS target_link ON target_link.article_id = target.id
          LEFT JOIN article_taxonomies AS candidate_link
            ON candidate_link.article_id = a.id AND candidate_link.taxonomy_id = target_link.taxonomy_id
          GROUP BY a.id, a.author_id, a.slug, a.work_type, a.status, a.created_at, a.updated_at, a.published_at,
                   t.locale, t.title, t.summary, t.content_blocks, t.content_blocks_version, target.author_id
        )
        SELECT id, author_id, slug, status, created_at, updated_at, published_at, locale, title, summary, content_blocks, content_blocks_version
        FROM candidates
        ORDER BY shared_taxonomy_count DESC, same_author DESC, published_at DESC, id DESC
        LIMIT $3`,
        [slug, locale, limit],
      );
      return rows.map(mapArticle);
    },

    async listFollowingArticles({ actorId, locale = "zh-CN", limit = 20, offset = 0 }) {
      requiredText("actorId", actorId, 300);
      validateArticleLocale(locale);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new ArticleInputError("limit must be an integer between 1 and 100.");
      if (!Number.isInteger(offset) || offset < 0 || offset > 100000) {
        throw new ArticleInputError("offset must be an integer between 0 and 100000.");
      }
      const rows = await sql.unsafe(
        `SELECT a.id, a.author_id, a.slug, a.work_type, a.status, a.created_at, a.updated_at, a.published_at,
                t.locale, t.title, t.summary, t.content_blocks, t.content_blocks_version
         FROM articles AS a
         JOIN article_translations AS t ON t.article_id = a.id
         JOIN user_follows AS f ON f.followed_id = a.author_id
         WHERE a.status = 'published' AND t.locale = $1 AND f.follower_id = $2
         ORDER BY a.published_at DESC, a.id DESC
         LIMIT $3 OFFSET $4`,
        [locale, actorId, limit, offset],
      );
      return rows.map(mapArticle);
    },

    async listFeaturedArticles(args) {
      return readFeaturedArticles(sql, args);
    },

    /**
     * Replace the whole shelf.
     *
     * The write carries the entire ordered list rather than individual adds and
     * moves, because "move this one up" is indistinguishable from "reorder these
     * three" once two editors are working at once: a whole-list write is
     * idempotent, leaves no position gaps to reconcile, and cannot end in a state
     * neither editor asked for. The cost is one request carrying a dozen ids.
     */
    async setFeaturedArticles({ actorId, actorIsEditor = false, articleIds, locale = "zh-CN" }) {
      requiredText("actorId", actorId, 300);
      if (actorIsEditor !== true) throw new ArticleAuthorizationError("Only an editor can change the featured shelf.");
      if (!Array.isArray(articleIds)) throw new ArticleInputError("articleIds must be an array of article identifiers.");
      if (articleIds.length > MAX_FEATURED_ARTICLES) {
        throw new ArticleInputError(`The featured shelf holds at most ${MAX_FEATURED_ARTICLES} works.`);
      }
      if (!articleIds.every((id) => typeof id === "string" && isUuid(id))) {
        throw new ArticleInputError("articleIds must contain valid article identifiers.");
      }
      if (new Set(articleIds).size !== articleIds.length) {
        throw new ArticleInputError("The featured shelf cannot list the same work twice.");
      }
      await sql.begin(async (tx) => {
        const transactionId = createMigrationTransactionId();
        // A draft or a deleted work on the public shelf is a promise the reader
        // cannot collect, so the whole write is refused rather than half applied:
        // a shelf that silently dropped two of the editor's picks is worse than
        // one that said no.
        for (const id of articleIds) {
          const rows = await tx.unsafe("SELECT status FROM articles WHERE id = $1 LIMIT 1", [id]);
          if (!rows[0] || rows[0].status !== "published") {
            throw new ArticleInputError("The featured shelf can only contain published articles.");
          }
        }
        const previous = await tx.unsafe("SELECT article_id FROM featured_articles");
        await tx.unsafe("DELETE FROM featured_articles");
        for (const [index, id] of articleIds.entries()) {
          await tx.unsafe(
            "INSERT INTO featured_articles (article_id, position, created_by) VALUES ($1, $2, $3)",
            [id, index, actorId],
          );
        }
        const rows = await tx.unsafe("SELECT * FROM featured_articles");
        await captureChanges(tx, transactionId, [
          ...previous.map((row) => ({ entityType: "featured_articles", entityId: row.article_id, operation: "delete" as const, payload: null })),
          ...rows.map((row) => ({ entityType: "featured_articles", entityId: row.article_id, operation: "upsert" as const, payload: row })),
        ]);
      });
      return readFeaturedArticles(sql, { locale, limit: MAX_FEATURED_ARTICLES, offset: 0 });
    },

  }) satisfies Pick<TypedPersistenceAdapterContract, "listPublishedArticles" | "getPublishedArticle" | "listMyArticles" | "listMyDeletedArticles" | "createArticle" | "updateArticle" | "deleteArticle" | "restoreArticle" | "purgeExpiredArticles" | "listLikedArticles" | "listRelatedArticles" | "listFollowingArticles" | "listFeaturedArticles" | "setFeaturedArticles">;
}
