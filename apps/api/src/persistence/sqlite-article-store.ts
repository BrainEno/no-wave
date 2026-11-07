import { randomUUID } from "node:crypto";
import {
  articleIdempotencyFingerprint,
  articleIdempotencyKeyHash,
  articleIdempotencyReplayMatches,
} from "../application/article-idempotency.ts";
import { MEDIA_SRC_PATTERN } from "../application/media-assets.ts";
import { ARTICLE_MEDIA_REFS_SNAPSHOT, createMigrationTransactionId } from "./provider-migration-journal.ts";
import { createSqliteProviderMigrationCapture, migrationEntityKey } from "./sqlite-provider-migration-capture.ts";
import {
  ArticleInputError,
  ArticleSlugConflictError,
  IdempotencyConflictError,
  ArticleAuthorizationError,
  ArticleNotFoundError,
} from "../domain/errors.ts";
import {
  validateArticleLocale,
  validateArticleSlug,
  normalizeArticleInput,
  normalizeTaxonomyIds,
  MAX_FEATURED_ARTICLES, maxArticleOffset, resolveArticleCursor,
} from "../domain/article.ts";
import { isUuid, requiredText } from "../domain/validation.ts";
import type { TypedPersistenceAdapterContract } from "../application/persistence-ports.ts";

/**
 * SQLite implementation of the article/content persistence slice.
 * This is a domain slice composed into the SQLite provider by sqlite-store.ts.
 */
export function createSqliteArticleStore(db) {
  if (!db || typeof db.prepare !== "function" || typeof db.exec !== "function") {
    throw new TypeError("A node:sqlite DatabaseSync connection is required.");
  }

  const migrationCapture = createSqliteProviderMigrationCapture(db);

  const articleColumns = `a.id, a.author_id, a.slug, a.work_type, a.status, t.locale,
           t.title, t.summary, t.content_blocks, t.content_blocks_version, a.created_at, a.updated_at, a.published_at`;
  const articleSelect = `
    SELECT ${articleColumns}
    FROM articles a
    JOIN article_translations t ON t.article_id = a.id
  `;
  /** `sort=popular` is the only reader that needs a per-row like count. */
  const articleSelectWithLikeCount = `
    SELECT ${articleColumns},
           (SELECT count(*) FROM article_likes l WHERE l.article_id = a.id) AS like_count
    FROM articles a
    JOIN article_translations t ON t.article_id = a.id
  `;
  const mapArticle = (row) => row ? ({
    id: row.id,
    authorId: row.author_id,
    slug: row.slug,
    workType: row.work_type ?? "other",
    status: row.status,
    locale: row.locale,
    title: row.title,
    summary: row.summary,
    contentBlocks: JSON.parse(row.content_blocks),
    contentBlocksVersion: row.content_blocks_version ?? 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    publishedAt: row.published_at,
  }) : null;
  // The desk's recycle bin reads the same article shape plus the tombstone
  // timestamp and the number of comments that would die with it, so it gets its
  // own select rather than a flag on the shared one. The count is part of the
  // listing because the sweep's cost is other people's words, and a row that
  // says "will be removed" without saying "and their comments with it" hides
  // the only irreversible thing the slice can do to a third party.
  const deletedArticleSelect = `
    SELECT a.id, a.author_id, a.slug, a.work_type, a.status, t.locale,
           t.title, t.summary, t.content_blocks, t.content_blocks_version, a.created_at, a.updated_at, a.published_at, a.deleted_at,
           (SELECT count(*) FROM article_comments c WHERE c.article_id = a.id) AS comment_count
    FROM articles a
    JOIN article_translations t ON t.article_id = a.id
  `;
  const mapDeletedArticle = (row) => row ? ({
    ...mapArticle(row),
    deletedAt: row.deleted_at,
    commentCount: Number(row.comment_count ?? 0),
  }) : null;
  const statement = (sql) => db.prepare(sql);
  const featuredSelect = statement(articleSelect + `
    JOIN featured_articles AS f ON f.article_id = a.id
    WHERE a.status = 'published' AND t.locale = ?
    ORDER BY f.position ASC, f.created_at ASC
    LIMIT ? OFFSET ?
  `);
  /** Shared by the public read and by the writer's read-back after it commits. */
  const readFeaturedArticles = (locale, limit, offset) => featuredSelect.all(locale, limit, offset).map(mapArticle);
  const featuredStatus = statement("SELECT status FROM articles WHERE id = ?");
  const publishedArticleBySlug = statement(
    articleSelect + " WHERE a.slug = ? AND a.status = 'published' AND t.locale = ? LIMIT 1",
  );

  function transaction(work) {
    const transactionId = createMigrationTransactionId();
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = work(transactionId);
      db.exec("COMMIT");
      return result;
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch { /* preserve original failure */ }
      throw error;
    }
  }

  /**
   * Which media ids a body's text mentions (#163).
   *
   * The same `MEDIA_SRC_PATTERN` the old full-scan used, so the materialised
   * table and the rule it replaced cannot disagree about what counts as a
   * reference. Deduplicated because a body may show the same image twice and the
   * primary key is (asset, article, locale).
   */
  function mediaIdsIn(contentBlocks) {
    const text = typeof contentBlocks === "string" ? contentBlocks : JSON.stringify(contentBlocks ?? []);
    const ids = new Set();
    for (const match of text.matchAll(MEDIA_SRC_PATTERN)) ids.add(match[1].toLowerCase());
    return [...ids];
  }

  /**
   * Keep `article_media_refs` equal to what this translation now says.
   *
   * Called inside the writer's transaction, which is the whole point: the
   * reference table and the body it describes commit together or not at all, so
   * there is no window where a saved image looks unreferenced. Delete-then-insert
   * for this (article, locale) rather than a diff — an edit can add and remove
   * images in one go, and the row count per translation is tiny.
   *
   * The insert is guarded by the asset still existing: a body may name an id that
   * was never uploaded here (a hand-written URL, or one deleted before this
   * migration ran) and a foreign-key failure must not fail the article save.
   * `ON DELETE CASCADE` on the other side cleans up when an asset does go.
   */
  function replaceMediaReferences(articleId, locale, contentBlocks) {
    statement("DELETE FROM article_media_refs WHERE article_id = ? AND locale = ?").run(articleId, locale);
    const ids = mediaIdsIn(contentBlocks);
    if (ids.length === 0) return;
    const insert = statement(
      "INSERT INTO article_media_refs (asset_id, article_id, locale) SELECT id, ?, ? FROM media_assets WHERE id = ? ON CONFLICT DO NOTHING",
    );
    for (const assetId of ids) insert.run(articleId, locale, assetId);
  }

  function replaceTaxonomies(articleId, kind, ids) {
    if (ids === undefined) return;
    if (ids.length) {
      const placeholders = ids.map(() => "?").join(", ");
      const found = statement(
        `SELECT id FROM taxonomies WHERE kind = ? AND id IN (${placeholders})`,
      ).all(kind, ...ids);
      if (found.length !== ids.length) {
        throw new ArticleInputError(`All selected ${kind} IDs must reference existing ${kind} taxonomies.`);
      }
    }
    statement(`DELETE FROM article_taxonomies WHERE article_id = ? AND taxonomy_id IN (SELECT id FROM taxonomies WHERE kind = ?)`)
      .run(articleId, kind);
    const insert = statement("INSERT INTO article_taxonomies (article_id, taxonomy_id) VALUES (?, ?) ON CONFLICT DO NOTHING");
    for (const id of ids) insert.run(articleId, id);
  }


  /**
   * Capture only the `articles` row into the provider-migration journal.
   *
   * Deletion changes no translation and no taxonomy link, so this is the whole
   * change set — and capturing the row is what keeps a replica that is replaying
   * this journal from keeping a work the author just deleted.
   */
  function captureArticleRow(transactionId, articleId) {
    const article = statement("SELECT * FROM articles WHERE id = ?").get(articleId);
    if (!article) return;
    migrationCapture.captureInTransaction(db, transactionId, [
      { entityType: "articles", entityId: articleId, operation: "upsert", payload: article },
    ]);
  }

  function captureArticleState(transactionId, articleId, locale, previousLinks = []) {
    const article = statement("SELECT * FROM articles WHERE id = ?").get(articleId);
    const translation = statement("SELECT * FROM article_translations WHERE article_id = ? AND locale = ?").get(articleId, locale);
    const links = statement("SELECT article_id, taxonomy_id FROM article_taxonomies WHERE article_id = ?").all(articleId);
    const currentIds = new Set(links.map((link) => link.taxonomy_id));
    const changes = [];
    if (article) changes.push({ entityType: "articles", entityId: articleId, operation: "upsert", payload: article });
    if (translation) {
      // Capture the actual materialized set, including an explicit empty set,
      // while the article write still owns the source transaction.
      const mediaRefs = statement("SELECT asset_id FROM article_media_refs WHERE article_id = ? AND locale = ? ORDER BY asset_id").all(articleId, locale);
      changes.push({ entityType: "article_translations", entityId: migrationEntityKey(articleId, locale), operation: "upsert", payload: {
        ...translation, [ARTICLE_MEDIA_REFS_SNAPSHOT]: mediaRefs.map((row) => row.asset_id),
      } });
    }
    for (const link of links) changes.push({ entityType: "article_taxonomies", entityId: migrationEntityKey(articleId, link.taxonomy_id), operation: "upsert", payload: link });
    for (const link of previousLinks) if (!currentIds.has(link.taxonomy_id)) changes.push({ entityType: "article_taxonomies", entityId: migrationEntityKey(articleId, link.taxonomy_id), operation: "delete", payload: null });
    migrationCapture.captureInTransaction(db, transactionId, changes);
  }

  /**
   * Read back a work that a replayed create already made, in the locale the
   * caller asked for (falling back to the translation it was written in).
   */
  function readCreatedArticle(articleId, locale) {
    return mapArticle(statement(articleSelect + " WHERE a.id = ? AND t.locale = COALESCE((SELECT locale FROM article_translations WHERE article_id = ? AND locale = ?), (SELECT locale FROM article_translations WHERE article_id = ? ORDER BY created_at LIMIT 1))")
      .get(articleId, articleId, locale, articleId));
  }

  return Object.freeze({
  /**
   * Every article body, as raw JSON text, for the media reference scan (ADR 0022).
   *
   * This is the one query in the codebase that reads all of the content, and it
   * is worth saying why it is allowed to: knowing whether an image is still used
   * means looking at everything that could use it. Drafts are in because a draft
   * is published eventually; tombstones are in because one can be restored, and
   * restoring a work into broken images is worse than keeping a few bytes.
   *
   * The cost is one pass over the content per library read. If that ever
   * matters, the answer is a `media_references` table maintained on save — not a
   * narrower scan, which would silently decide that some references do not
   * count.
   */
    listPublishedArticles({ locale = "zh-CN", query = "", authorId = null, sort = "latest", limit = 20, offset = 0, cursor = null } = {}) {
      validateArticleLocale(locale);
      if (typeof query !== "string" || query.length > 200) throw new ArticleInputError("query must be a string no longer than 200 characters.");
      if (authorId !== null) requiredText("authorId", authorId, 300);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new ArticleInputError("limit must be an integer between 1 and 100.");
      if (sort !== "latest" && sort !== "popular") throw new ArticleInputError("sort must be 'latest' or 'popular'.");
      // Same ceiling as PostgreSQL, and the same reason it depends on the order.
      if (!Number.isInteger(offset) || offset < 0 || offset > maxArticleOffset(sort)) {
        throw new ArticleInputError(`offset must be an integer between 0 and ${maxArticleOffset(sort)}${sort === "popular" ? " with sort=popular" : ""}.`);
      }
      const needle = query.trim().toLocaleLowerCase(locale);
      // `popular` counts every save the work has ever had: the tab is "most
      // saved", not "trending", and a work that collected its likes two years
      // ago is still one of the most-saved works on the site. Keeping a window
      // here would make two tabs that only differ in how slowly they change.
      const popular = sort === "popular";
      // The body is searched too, one block at a time rather than as the JSON it
      // is stored as: matching the raw text would let a reader find every work by
      // searching "paragraph", which is a word no reader ever typed on purpose.
      //
      // This stays a scan by design: a single-host SQLite file has no trigram
      // operator class to lean on, and an FTS5 side table would have to be kept in
      // step with every write path for a search whose cost here is bounded by one
      // machine's content. PostgreSQL carries the index instead (migration 0027),
      // where the scan was over a shared database.
      // A cursor is only meaningful against the newest-first order. "Most saved"
      // is ranked by a count that changes while you read it, so a page boundary
      // drawn through it would move under the reader: they would meet a work
      // again after it was liked, and never meet one that was liked past them.
      const keyset = resolveArticleCursor({ cursor, sort, offset });
      const rows = statement((popular ? articleSelectWithLikeCount : articleSelect) + `
        WHERE a.status = 'published' AND t.locale = ?
          AND (? = '' OR instr(lower(t.title), lower(?)) > 0 OR instr(lower(t.summary), lower(?)) > 0
            OR EXISTS (
              SELECT 1 FROM json_each(t.content_blocks) AS block
              WHERE instr(lower(COALESCE(json_extract(block.value, '$.text'), '')), lower(?)) > 0
            ))
          AND (? IS NULL OR a.author_id = ?)
          ${keyset ? "AND (a.published_at < ? OR (a.published_at = ? AND a.id < ?))" : ""}
        ORDER BY ${popular ? "like_count DESC, a.published_at DESC, a.id DESC" : "a.published_at DESC, a.id DESC"}
        LIMIT ? OFFSET ?
      `).all(locale, needle, needle, needle, needle, authorId, authorId,
        ...(keyset ? [keyset.publishedAt, keyset.publishedAt, keyset.id] : []), limit, offset);
      return rows.map(mapArticle);
    },

    /**
     * The featured shelf, in the order the editors put it in.
     *
     * Only published work is listed: a soft-deleted article keeps its featured
     * row — so restoring it puts it back where the editors had it — but must not
     * be offered to a reader while it is in the bin.
     */
    listFeaturedArticles({ locale = "zh-CN", limit = 20, offset = 0 } = {}) {
      validateArticleLocale(locale);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new ArticleInputError("limit must be an integer between 1 and 100.");
      if (!Number.isInteger(offset) || offset < 0 || offset > 100000) throw new ArticleInputError("offset must be an integer between 0 and 100000.");
      return readFeaturedArticles(locale, limit, offset);
    },

    /**
     * Replace the whole shelf.
     *
     * The write is the entire ordered list, not individual adds and moves, because
     * "move this one up" is indistinguishable from "reorder these three" once two
     * editors are working at once: a whole-list write is idempotent, has no
     * position gaps to reconcile, and cannot leave the shelf in a state neither
     * editor asked for. The cost is one request carrying a dozen ids.
     */
    setFeaturedArticles({ actorId, actorIsEditor = false, articleIds, locale = "zh-CN" }) {
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
      transaction((transactionId) => {
        // A draft or a deleted work on the public shelf is a promise the reader
        // cannot collect, so the whole write is refused rather than partially
        // applied: a shelf that silently dropped two of the editor's picks is
        // worse than one that said no.
        for (const id of articleIds) {
          const article = featuredStatus.get(id);
          if (!article || article.status !== "published") {
            throw new ArticleInputError("The featured shelf can only contain published articles.");
          }
        }
        const previous = statement("SELECT article_id FROM featured_articles").all();
        statement("DELETE FROM featured_articles").run();
        articleIds.forEach((id, index) => {
          statement("INSERT INTO featured_articles (article_id, position, created_by) VALUES (?, ?, ?)").run(id, index, actorId);
        });
        const rows = statement("SELECT * FROM featured_articles").all();
        migrationCapture.captureInTransaction(db, transactionId, [
          ...previous.map((row) => ({ entityType: "featured_articles", entityId: row.article_id, operation: "delete", payload: null })),
          ...rows.map((row) => ({ entityType: "featured_articles", entityId: row.article_id, operation: "upsert", payload: row })),
        ]);
      });
      return readFeaturedArticles(locale, MAX_FEATURED_ARTICLES, 0);
    },

    /**
     * The reading feed: what the accounts `actorId` follows have published,
     * newest first, across all followed authors.
     *
     * One join against `user_follows` instead of a per-author query followed by
     * an in-memory merge, because the merge is where offset pagination quietly
     * breaks: a page boundary computed over merged per-author pages repeats and
     * drops rows as soon as authors publish at different rates.
     */
    listFollowingArticles({ actorId, locale = "zh-CN", limit = 20, offset = 0 }) {
      requiredText("actorId", actorId, 300);
      validateArticleLocale(locale);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new ArticleInputError("limit must be an integer between 1 and 100.");
      if (!Number.isInteger(offset) || offset < 0 || offset > 100000) throw new ArticleInputError("offset must be an integer between 0 and 100000.");
      const rows = statement(articleSelect + `
        JOIN user_follows AS f ON f.followed_id = a.author_id
        WHERE a.status = 'published' AND t.locale = ? AND f.follower_id = ?
        ORDER BY a.published_at DESC, a.id DESC
        LIMIT ? OFFSET ?
      `).all(locale, actorId, limit, offset);
      return rows.map(mapArticle);
    },

    getPublishedArticle({ slug, locale = "zh-CN" }) {
      validateArticleSlug(slug);
      validateArticleLocale(locale);
      return mapArticle(publishedArticleBySlug.get(slug, locale));
    },

    listMyArticles({ actorId, locale = "zh-CN", limit = 50 }) {
      requiredText("actorId", actorId, 300);
      validateArticleLocale(locale);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new ArticleInputError("limit must be an integer between 1 and 100.");
      // A deleted work is a tombstone the author cannot act on any more, so the
      // desk must not list it — deletion would otherwise be invisible.
      return statement(articleSelect + " WHERE a.author_id = ? AND t.locale = ? AND a.deleted_at IS NULL ORDER BY a.updated_at DESC, a.id LIMIT ?")
        .all(actorId, locale, limit).map(mapArticle);
    },

    /**
     * The author's own tombstones, newest deletion first.
     *
     * This is the list that makes a soft delete honest: without it, a deleted
     * work is invisible and unrecoverable, which is the one thing an author
     * cannot tell apart from a bug. `purgesAt` is deliberately *not* computed
     * here — the retention window is policy the service layer owns, so a store
     * test never has to fake an environment to read a timestamp.
     */
    listMyDeletedArticles({ actorId, locale = "zh-CN", limit = 50 }) {
      requiredText("actorId", actorId, 300);
      validateArticleLocale(locale);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new ArticleInputError("limit must be an integer between 1 and 100.");
      return statement(deletedArticleSelect + " WHERE a.author_id = ? AND t.locale = ? AND a.deleted_at IS NOT NULL ORDER BY a.deleted_at DESC, a.id DESC LIMIT ?")
        .all(actorId, locale, limit).map(mapDeletedArticle);
    },

    listLikedArticles({ actorId, locale = "zh-CN", limit = 50 }) {
      requiredText("actorId", actorId, 300);
      validateArticleLocale(locale);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new ArticleInputError("limit must be an integer between 1 and 100.");
      return statement(articleSelect + `
        JOIN article_likes l ON l.article_id = a.id
        WHERE l.user_id = ? AND a.status = 'published' AND t.locale = ?
        ORDER BY l.created_at DESC, a.id DESC LIMIT ?
      `).all(actorId, locale, limit).map(mapArticle);
    },

    listRelatedArticles({ slug, locale = "zh-CN", limit = 6 }) {
      validateArticleSlug(slug);
      validateArticleLocale(locale);
      if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new ArticleInputError("limit must be an integer between 1 and 50.");
      const current = statement("SELECT a.id, a.author_id FROM articles a JOIN article_translations t ON t.article_id = a.id AND t.locale = ? WHERE a.slug = ? AND a.status = 'published' LIMIT 1").get(locale, slug);
      if (!current) return [];
      return statement(articleSelect + `
        LEFT JOIN article_taxonomies target_link ON target_link.article_id = ?
        LEFT JOIN article_taxonomies candidate_link ON candidate_link.article_id = a.id AND candidate_link.taxonomy_id = target_link.taxonomy_id
        WHERE a.status = 'published' AND a.id <> ? AND t.locale = ?
        GROUP BY a.id, a.author_id, a.slug, a.work_type, a.status, t.locale, t.title, t.summary, t.content_blocks, t.content_blocks_version, a.created_at, a.updated_at, a.published_at
        ORDER BY count(DISTINCT candidate_link.taxonomy_id) DESC, (a.author_id = ?) DESC, a.published_at DESC, a.id DESC LIMIT ?
      `).all(current.id, current.id, locale, current.author_id, limit).map(mapArticle);
    },

    createArticle({ authorId, slug, title, summary = "", locale = "zh-CN", contentBlocks, contentBlocksVersion = 0, publish = false, workType = "other", categoryIds = [], tagIds = [], idempotencyKey = null, requestedSlug }) {
      requiredText("authorId", authorId, 300);
      const input = normalizeArticleInput({ slug, title, summary, locale, contentBlocks, contentBlocksVersion, publish, workType });
      const categories = normalizeTaxonomyIds("categoryIds", categoryIds, 20) ?? [];
      const tags = normalizeTaxonomyIds("tagIds", tagIds, 50) ?? [];
      if (idempotencyKey !== null && (typeof idempotencyKey !== "string" || idempotencyKey.length === 0 ||
          idempotencyKey.length > 300 || idempotencyKey.trim() !== idempotencyKey)) {
        throw new ArticleInputError("Idempotency-Key must be a non-empty trimmed string no longer than 300 characters.");
      }
      const id = randomUUID();
      const keyHash = idempotencyKey === null ? null : articleIdempotencyKeyHash(authorId, idempotencyKey);
      // `requestedSlug` is undefined only for direct store callers that predate
      // the route contract; treat their explicit slug as client-supplied.
      const fingerprintSlug = requestedSlug === undefined ? input.slug : (requestedSlug ?? null);
      const fingerprintBase = {
        authorId, title: input.title, summary: input.summary, locale: input.locale,
        contentBlocks: input.contentBlocks, contentBlocksVersion: input.contentBlocksVersion,
        publish: input.publish, workType: input.workType ?? "other",
        categoryIds: [...categories].sort(), tagIds: [...tags].sort(),
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
        return transaction((transactionId) => {
          // A retried publish is a replay, not a second work: without this the
          // slug uniquifier in the route would hand the retry a new address and
          // the author would end up with two copies of the same text.
          if (keyHash !== null) {
            const existing = db.prepare("SELECT id, slug, request_hash FROM articles WHERE author_id = ? AND idempotency_key_hash = ?").get(authorId, keyHash);
            if (existing) {
              if (!replayMatches(existing)) throw new IdempotencyConflictError();
              return readCreatedArticle(existing.id, input.locale);
            }
          }
          const now = new Date().toISOString();
          db.prepare("INSERT INTO articles (id, author_id, slug, status, work_type, idempotency_key_hash, request_hash, created_at, updated_at, published_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
            .run(id, authorId, input.slug, input.publish ? "published" : "draft", input.workType ?? "other",
              keyHash, keyHash === null ? null : fingerprint, now, now, input.publish ? now : null);
          db.prepare("INSERT INTO article_translations (article_id, locale, title, summary, content_blocks, content_blocks_version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
            .run(id, input.locale, input.title, input.summary, JSON.stringify(input.contentBlocks), input.contentBlocksVersion, now, now);
          replaceMediaReferences(id, input.locale, input.contentBlocks);
          replaceTaxonomies(id, "category", categories);
          replaceTaxonomies(id, "tag", tags);
          captureArticleState(transactionId, id, input.locale);
          return mapArticle(statement(articleSelect + " WHERE a.id = ? AND t.locale = ?").get(id, input.locale));
        });
      } catch (error) {
        if (/UNIQUE constraint failed: articles\.slug/i.test(error.message)) throw new ArticleSlugConflictError();
        // Another writer took the same key between the replay check and the
        // insert: the work exists now, so answer with it rather than a 500.
        if (keyHash !== null && /articles_author_idempotency_key_idx|articles\.idempotency_key_hash/i.test(error.message)) {
          const existing = db.prepare("SELECT id, slug, request_hash FROM articles WHERE author_id = ? AND idempotency_key_hash = ?").get(authorId, keyHash);
          if (existing) {
            if (!replayMatches(existing)) throw new IdempotencyConflictError();
            return readCreatedArticle(existing.id, input.locale);
          }
        }
        throw error;
      }
    },

    updateArticle({ articleId, actorId, slug, title, summary = "", locale = "zh-CN", contentBlocks, contentBlocksVersion = 0, publish = false, workType, categoryIds, tagIds }) {
      if (!isUuid(articleId)) throw new ArticleInputError("articleId must be a valid article ID.");
      requiredText("actorId", actorId, 300);
      const input = normalizeArticleInput({ slug, title, summary, locale, contentBlocks, contentBlocksVersion, publish, workType });
      const categories = normalizeTaxonomyIds("categoryIds", categoryIds, 100);
      const tags = normalizeTaxonomyIds("tagIds", tagIds, 100);
      try {
        return transaction((transactionId) => {
          const existing = statement("SELECT id, author_id, created_at, deleted_at FROM articles WHERE id = ?").get(articleId);
          if (!existing || existing.deleted_at) throw new ArticleNotFoundError("The article was not found.");
          if (existing.author_id !== actorId) throw new ArticleAuthorizationError("Only the article author can update it.");
          const previousLinks = statement("SELECT taxonomy_id FROM article_taxonomies WHERE article_id = ?").all(articleId);
          const now = new Date().toISOString();
          db.prepare("UPDATE articles SET slug = ?, status = ?, work_type = COALESCE(?, work_type), updated_at = ?, published_at = CASE WHEN ? = 1 THEN COALESCE(published_at, ?) ELSE NULL END WHERE id = ?")
            .run(input.slug, input.publish ? "published" : "draft", input.workType ?? null, now, input.publish ? 1 : 0, now, articleId);
          db.prepare(`INSERT INTO article_translations (article_id, locale, title, summary, content_blocks, content_blocks_version, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(article_id, locale) DO UPDATE SET title = excluded.title, summary = excluded.summary,
              content_blocks = excluded.content_blocks, content_blocks_version = excluded.content_blocks_version, updated_at = excluded.updated_at`)
            .run(articleId, input.locale, input.title, input.summary, JSON.stringify(input.contentBlocks), input.contentBlocksVersion, now, now);
          replaceMediaReferences(articleId, input.locale, input.contentBlocks);
          replaceTaxonomies(articleId, "category", categories);
          replaceTaxonomies(articleId, "tag", tags);
          captureArticleState(transactionId, articleId, input.locale, previousLinks);
          return mapArticle(statement(articleSelect + " WHERE a.id = ? AND t.locale = ?").get(articleId, input.locale));
        });
      } catch (error) {
        if (/UNIQUE constraint failed: articles\.slug/i.test(error.message)) throw new ArticleSlugConflictError();
        throw error;
      }
    },

    /**
     * Delete one of the author's own works.
     *
     * The row stays: comments, likes, taxonomy links and the provider-migration
     * journal all refer to it, and a tombstone is recoverable by hand in a way a
     * cascading delete is not. Concretely — the status goes back to 'draft', so
     * every `status = 'published'` read (public page, search, feeds, related,
     * liked lists) already hides the work, and `deleted_at` hides it from the
     * author's own desk.
     *
     * The slug is released, because it is the one thing an author would notice:
     * without this, rewriting the same title after deleting it would collide with
     * the tombstone forever and fail with a 409 the author cannot resolve.
     */
    deleteArticle({ articleId, actorId }) {
      if (!isUuid(articleId)) throw new ArticleInputError("articleId must be a valid article ID.");
      requiredText("actorId", actorId, 300);
      return transaction((transactionId) => {
        const existing = statement("SELECT id, author_id, slug, deleted_at FROM articles WHERE id = ?").get(articleId);
        // A tombstone is not in the author's desk, so a second delete is a 404
        // rather than a silent second tombstone over the first.
        if (!existing || existing.deleted_at) throw new ArticleNotFoundError("The article was not found.");
        if (existing.author_id !== actorId) throw new ArticleAuthorizationError("Only the article author can delete it.");
        const now = new Date().toISOString();
        const releasedSlug = `${existing.slug}-deleted-${articleId.slice(0, 8)}`;
        db.prepare("UPDATE articles SET status = 'draft', deleted_at = ?, slug = ?, updated_at = ? WHERE id = ?")
          .run(now, releasedSlug, now, articleId);
        captureArticleRow(transactionId, articleId);
        return { id: articleId, deletedAt: now };
      });
    },

    /**
     * Bring one of the author's own tombstones back.
     *
     * A restored work returns as a **draft**, never as published: deleting it
     * withdrew it from the public site, and restoring must not quietly put a
     * public address back that the author may have decided against. Republishing
     * is one deliberate press of a button.
     *
     * The address the tombstone released is reclaimed when it is still free, so
     * the author does not carry `-deleted-…` around; when something else has
     * taken it since, the tombstone's own slug stays and the restore still
     * succeeds — a restore must never fail over a slug the author cannot see.
     */
    restoreArticle({ articleId, actorId, locale = "zh-CN" }) {
      if (!isUuid(articleId)) throw new ArticleInputError("articleId must be a valid article ID.");
      requiredText("actorId", actorId, 300);
      validateArticleLocale(locale);
      return transaction((transactionId) => {
        const existing = statement("SELECT author_id, slug, deleted_at FROM articles WHERE id = ?").get(articleId);
        // Not a tombstone: an unknown id, a live work and a second restore are
        // all the same answer, so this cannot be used to probe what exists.
        if (!existing || !existing.deleted_at) throw new ArticleNotFoundError("The article was not found.");
        if (existing.author_id !== actorId) throw new ArticleAuthorizationError("Only the article author can restore it.");
        const translation = statement("SELECT locale FROM article_translations WHERE article_id = ? AND locale = ?").get(articleId, locale);
        if (!translation) throw new ArticleNotFoundError(`The article has no ${locale} translation.`);
        const now = new Date().toISOString();
        const suffix = `-deleted-${articleId.slice(0, 8)}`;
        const preferred = existing.slug.endsWith(suffix) ? existing.slug.slice(0, -suffix.length) : existing.slug;
        const taken = preferred === existing.slug
          ? undefined
          : statement("SELECT 1 AS found FROM articles WHERE slug = ? AND id <> ?").get(preferred, articleId);
        db.prepare("UPDATE articles SET deleted_at = NULL, status = 'draft', slug = ?, updated_at = ? WHERE id = ?")
          .run(taken ? existing.slug : preferred, now, articleId);
        captureArticleRow(transactionId, articleId);
        return mapArticle(statement(articleSelect + " WHERE a.id = ? AND t.locale = ?").get(articleId, locale));
      });
    },

    /**
     * Hard-delete tombstones that have outlived the retention window.
     *
     * This is the only irreversible step in the slice, so it is deliberately
     * unreachable from the desk: the author has no "delete forever" button, and
     * the window is what gives "you can undo this" an expiry date. Rows go, and
     * the foreign keys take the translations, likes, comments and taxonomy links
     * with them — which is why those children are captured one by one *before*
     * the delete, the way `deleteConversation` does it: a replica replaying this
     * journal must not keep orphaned comments behind.
     *
     * Bounded and awaitable, like `pruneExpiredIdentityState`: the sweep never
     * outlives the request that triggered it.
     */
    purgeExpiredArticles({ retentionDays = 30, now = new Date(), limit = 100 } = {}) {
      if (!Number.isInteger(retentionDays) || retentionDays < 1 || retentionDays > 3650) {
        throw new ArticleInputError("retentionDays must be an integer between 1 and 3650.");
      }
      if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new ArticleInputError("limit must be an integer between 1 and 500.");
      const at = now instanceof Date ? now : new Date(now);
      if (Number.isNaN(at.getTime())) throw new ArticleInputError("now must be a valid date.");
      const cutoff = new Date(at.getTime() - retentionDays * 86_400_000).toISOString();
      return transaction((transactionId) => {
        const expired = statement("SELECT id FROM articles WHERE deleted_at IS NOT NULL AND deleted_at < ? ORDER BY deleted_at, id LIMIT ?")
          .all(cutoff, limit).map((row) => row.id);
        const changes = [];
        for (const id of expired) {
          changes.push({ entityType: "articles", entityId: id, operation: "delete", payload: null });
          for (const row of statement("SELECT locale FROM article_translations WHERE article_id = ?").all(id)) {
            changes.push({ entityType: "article_translations", entityId: migrationEntityKey(id, row.locale), operation: "delete", payload: null });
          }
          for (const row of statement("SELECT user_id FROM article_likes WHERE article_id = ?").all(id)) {
            changes.push({ entityType: "article_likes", entityId: migrationEntityKey(id, row.user_id), operation: "delete", payload: null });
          }
          for (const row of statement("SELECT id FROM article_comments WHERE article_id = ?").all(id)) {
            changes.push({ entityType: "article_comments", entityId: row.id, operation: "delete", payload: null });
          }
          for (const row of statement("SELECT taxonomy_id FROM article_taxonomies WHERE article_id = ?").all(id)) {
            changes.push({ entityType: "article_taxonomies", entityId: migrationEntityKey(id, row.taxonomy_id), operation: "delete", payload: null });
          }
        }
        const remove = statement("DELETE FROM articles WHERE id = ?");
        for (const id of expired) remove.run(id);
        if (changes.length) migrationCapture.captureInTransaction(db, transactionId, changes);
        return { purged: expired.length };
      });
    },
  }) satisfies Pick<TypedPersistenceAdapterContract, "listPublishedArticles" | "listFeaturedArticles" | "setFeaturedArticles" | "listFollowingArticles" | "getPublishedArticle" | "listMyArticles" | "listMyDeletedArticles" | "listLikedArticles" | "listRelatedArticles" | "createArticle" | "updateArticle" | "deleteArticle" | "restoreArticle" | "purgeExpiredArticles">;
}
