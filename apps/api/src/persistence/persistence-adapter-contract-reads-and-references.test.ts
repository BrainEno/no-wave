/**
 * Cursor paging, batch reads, comment edits, media references, import links and exports.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { encodeArticleCursor } from "../domain/article.ts";
import { ArticleInputError, ImportConflictError, ArticleAuthorizationError, ProfileInputError, ProfileNotFoundError } from "../domain/errors.ts";
import { registerForEngines, registerPostgresStore } from "./test-support/persistence-adapter-contract-fixtures.ts";

registerPostgresStore();

function registerReadAndReferenceContracts(adapterName, fixture, options = {}) {
  test(`${adapterName}: a cursor walks the newest works once, even if one is published mid-scroll`, options, async () => {
    const runtime = await fixture();
    const suffix = randomUUID();
    const authorId = `cursor-author-${suffix}`;
    const blocks = [{ id: "p1", type: "paragraph", text: "Cursor contract body." }];
    const now = new Date("2026-06-01T00:00:00.000Z");
    const daysAgo = (days) => new Date(now.getTime() - days * 86400000).toISOString();
    const publish = async (slug, days) => {
      await runtime.store.createArticle({ authorId, slug, title: `${slug}`, summary: "", locale: "zh-CN", contentBlocks: blocks, publish: true });
      await runtime.setArticlePublishedAt(slug, daysAgo(days));
    };
    const list = (extra) => runtime.store.listPublishedArticles({ locale: "zh-CN", query: suffix, ...extra });
    const slugs = (rows) => rows.map((article) => article.slug);
    const cursorAfter = (rows) => encodeArticleCursor(rows[rows.length - 1].publishedAt, rows[rows.length - 1].id);
    try {
      await runtime.store.upsertAuthorProfile({ userId: authorId, displayName: "Cursor Author", locale: "zh-CN" });
      for (let index = 1; index <= 5; index += 1) await publish(`cursor-work-${index}-${suffix}`, index);

      const first = await list({ limit: 2 });
      assert.deepEqual(slugs(first), [`cursor-work-1-${suffix}`, `cursor-work-2-${suffix}`]);

      // Mid-scroll: the newest work on the site appears above where the reader is.
      await publish(`cursor-intruder-${suffix}`, 0);

      const second = await list({ limit: 2, cursor: cursorAfter(first) });
      assert.deepEqual(slugs(second), [`cursor-work-3-${suffix}`, `cursor-work-4-${suffix}`], "no repeat, nothing skipped");
      const third = await list({ limit: 2, cursor: cursorAfter(second) });
      assert.deepEqual(slugs(third), [`cursor-work-5-${suffix}`]);
      // The end of a list is an empty page, not a special field to parse.
      assert.deepEqual(slugs(await list({ limit: 2, cursor: cursorAfter(third) })), []);

      // The same two rows by offset: the intruder has pushed work 2 into them.
      assert.deepEqual(slugs(await list({ limit: 2, offset: 2 })), [`cursor-work-2-${suffix}`, `cursor-work-3-${suffix}`]);

      // A cursor is a place in a particular order, not a token to wave around.
      const cursor = cursorAfter(first);
      await assert.rejects(Promise.resolve().then(() => list({ limit: 2, cursor, sort: "popular" })), ArticleInputError);
      await assert.rejects(Promise.resolve().then(() => list({ limit: 2, cursor, offset: 2 })), ArticleInputError);
      await assert.rejects(Promise.resolve().then(() => list({ limit: 2, cursor: "not-a-cursor" })), ArticleInputError);
      await assert.rejects(Promise.resolve().then(() => list({ limit: 2, cursor: "" })), ArticleInputError);
    } finally {
      await runtime.cleanup(undefined, suffix);
    }
  });

  test(`${adapterName}: account roles default to member, ride on the profile, and cannot be self-assigned`, options, async () => {
    const runtime = await fixture();
    const suffix = randomUUID();
    const editorId = `role-editor-${suffix}`;
    const targetId = `role-target-${suffix}`;
    const missingId = `role-missing-${suffix}`;
    try {
      // Absence of a record is absence of privilege, not an error: a brand-new
      // instance must not fail open just because the column is empty.
      assert.equal(await runtime.store.getUserRole({ userId: missingId }), "member");
      await runtime.store.upsertAuthorProfile({ userId: editorId, displayName: "Editor", locale: "zh-CN" });
      await runtime.store.upsertAuthorProfile({ userId: targetId, displayName: "Target", locale: "zh-CN" });
      assert.equal(await runtime.store.getUserRole({ userId: targetId }), "member");
      assert.equal((await runtime.store.getAuthorProfile({ userId: targetId, locale: "zh-CN" })).role, "member");

      assert.equal(await runtime.store.setUserRole({ actorId: editorId, userId: targetId, role: "editor" }), "editor");
      assert.equal(await runtime.store.getUserRole({ userId: targetId }), "editor");
      // The role rides along on the profile the client already fetches, so no
      // endpoint has to be added just to ask "may I show editorial controls?".
      assert.equal((await runtime.store.getAuthorProfile({ userId: targetId, locale: "zh-CN" })).role, "editor");

      // Assigning the same role again is a no-op, and promoting someone does not
      // quietly promote the actor.
      assert.equal(await runtime.store.setUserRole({ actorId: editorId, userId: targetId, role: "editor" }), "editor");
      assert.equal(await runtime.store.getUserRole({ userId: editorId }), "member");
      assert.equal(await runtime.store.setUserRole({ actorId: editorId, userId: targetId, role: "member" }), "member");
      assert.equal(await runtime.store.getUserRole({ userId: targetId }), "member");

      // ADR 0016, decision 3: nobody edits their own role, in either direction.
      await assert.rejects(Promise.resolve().then(() => runtime.store.setUserRole({ actorId: editorId, userId: editorId, role: "editor" })), ProfileInputError);
      await assert.rejects(Promise.resolve().then(() => runtime.store.setUserRole({ actorId: editorId, userId: editorId, role: "member" })), ProfileInputError);
      assert.equal(await runtime.store.getUserRole({ userId: editorId }), "member");

      // An unknown role is refused before it can reach the CHECK constraint, and
      // so is a role for an account that has no profile.
      await assert.rejects(Promise.resolve().then(() => runtime.store.setUserRole({ actorId: editorId, userId: targetId, role: "admin" })), ProfileInputError);
      await assert.rejects(Promise.resolve().then(() => runtime.store.setUserRole({ actorId: editorId, userId: targetId, role: "EDITOR" })), ProfileInputError);
      await assert.rejects(Promise.resolve().then(() => runtime.store.setUserRole({ actorId: editorId, userId: missingId, role: "editor" })), ProfileNotFoundError);
      await assert.rejects(Promise.resolve().then(() => runtime.store.setUserRole({ actorId: "  ", userId: targetId, role: "editor" })), ArticleInputError);
      await assert.rejects(Promise.resolve().then(() => runtime.store.setUserRole({ actorId: editorId, userId: "  ", role: "editor" })), ArticleInputError);
    } finally {
      await runtime.cleanup(undefined, suffix);
    }
  });

  test(`${adapterName}: the featured shelf is ordered, published-only, and editor-arranged`, options, async () => {
    const runtime = await fixture();
    const suffix = randomUUID();
    const editorId = `featured-editor-${suffix}`;
    const memberId = `featured-member-${suffix}`;
    const blocks = [{ id: "p1", type: "paragraph", text: "Featured body." }];
    const publish = (slug, title) => runtime.store.createArticle({
      authorId: editorId, slug, title, summary: "", locale: "zh-CN", contentBlocks: blocks, publish: true,
    });
    const slugs = (articles) => articles.map((article) => article.slug);
    const shelf = () => runtime.store.listFeaturedArticles({ locale: "zh-CN" });
    const arrange = (actorId, articleIds) => runtime.store.setFeaturedArticles({ actorId, actorIsEditor: true, articleIds });
    try {
      await runtime.store.upsertAuthorProfile({ userId: editorId, displayName: "Editor", locale: "zh-CN" });
      const first = await publish(`featured-first-${suffix}`, "第一篇");
      const second = await publish(`featured-second-${suffix}`, "第二篇");
      const draft = await runtime.store.createArticle({
        authorId: editorId, slug: `featured-draft-${suffix}`, title: "草稿", summary: "",
        locale: "zh-CN", contentBlocks: blocks, publish: false,
      });

      // An empty shelf is an empty list, not an error.
      assert.deepEqual(await shelf(), []);

      // Only an editor arranges it, and only published work goes on it: a draft
      // on the public shelf is a promise the reader cannot collect.
      await assert.rejects(Promise.resolve().then(() => runtime.store.setFeaturedArticles({ actorId: memberId, articleIds: [first.id] })), ArticleAuthorizationError);
      await assert.rejects(Promise.resolve().then(() => arrange(editorId, [draft.id])), ArticleInputError);
      await assert.rejects(Promise.resolve().then(() => arrange(editorId, [first.id, first.id])), ArticleInputError);
      await assert.rejects(Promise.resolve().then(() => arrange(editorId, ["not-an-article"])), ArticleInputError);
      assert.deepEqual(await shelf(), []);

      // The order is the order the editor sent.
      await arrange(editorId, [first.id, second.id]);
      assert.deepEqual(slugs(await shelf()), [`featured-first-${suffix}`, `featured-second-${suffix}`]);
      // …and a later write replaces the whole shelf, so reordering, dropping one
      // and emptying it are all the same operation.
      await arrange(editorId, [second.id, first.id]);
      assert.deepEqual(slugs(await shelf()), [`featured-second-${suffix}`, `featured-first-${suffix}`]);
      await arrange(editorId, [first.id]);
      assert.deepEqual(slugs(await shelf()), [`featured-first-${suffix}`]);
      await arrange(editorId, []);
      assert.deepEqual(await shelf(), []);

      // A soft-deleted work stops being offered. The featured row survives, so
      // the work comes back to the place the editors gave it — but restoring puts
      // it in the drafts, not back on the front page, so it stays off the shelf
      // until its author publishes it again.
      await arrange(editorId, [first.id, second.id]);
      await runtime.store.deleteArticle({ articleId: first.id, actorId: editorId });
      assert.deepEqual(slugs(await shelf()), [`featured-second-${suffix}`]);
      const restored = await runtime.store.restoreArticle({ articleId: first.id, actorId: editorId });
      assert.equal(restored.status, "draft");
      assert.deepEqual(slugs(await shelf()), [`featured-second-${suffix}`]);
      await runtime.store.updateArticle({
        articleId: first.id, actorId: editorId, slug: restored.slug, title: "第一篇",
        locale: "zh-CN", contentBlocks: blocks, publish: true,
      });
      assert.deepEqual(slugs(await shelf()), [`featured-first-${suffix}`, `featured-second-${suffix}`]);

      // Pagination walks the shelf in the arranged order.
      const firstPage = await runtime.store.listFeaturedArticles({ locale: "zh-CN", limit: 1, offset: 0 });
      const secondPage = await runtime.store.listFeaturedArticles({ locale: "zh-CN", limit: 1, offset: 1 });
      assert.deepEqual(slugs(firstPage), [`featured-first-${suffix}`]);
      assert.deepEqual(slugs(secondPage), [`featured-second-${suffix}`]);
      // A locale with no translation has nothing to show.
      assert.deepEqual(await runtime.store.listFeaturedArticles({ locale: "en" }), []);
    } finally {
      await runtime.cleanup(undefined, suffix);
    }
  });

  test(`${adapterName}: a comment edit replaces the text, keeps the thread and is owner-only`, options, async () => {
    const runtime = await fixture();
    const suffix = randomUUID();
    const slug = `contract-comment-edit-${suffix}`;
    const author = `comment-editor-${suffix}`;
    const stranger = `comment-stranger-${suffix}`;
    try {
      await runtime.store.createArticle({
        authorId: `edit-article-author-${suffix}`, slug, title: "Comment editing contract", summary: "",
        locale: "zh-CN", contentBlocks: [{ id: "p1", type: "paragraph", text: "Shared contract content." }], publish: true,
      });
      const comment = await runtime.store.createArticleComment({
        slug, locale: "zh-CN", actorId: author, content: "First wording of the thought.",
      });
      assert.equal(comment.editedAt, null, "a comment as written carries no edit marker");

      // Somebody else's comment is an authorization failure, not a silent no-op
      // and not a different answer that would reveal which ids exist.
      await assert.rejects(
        Promise.resolve().then(() => runtime.store.updateArticleComment({
          commentId: comment.id, actorId: stranger, content: "Somebody else's words now.",
        })),
        ArticleAuthorizationError,
      );

      const edited = await runtime.store.updateArticleComment({
        commentId: comment.id, actorId: author, locale: "zh-CN", content: "Second wording of the thought.",
      });
      assert.ok(edited, "an edit of an existing comment returns the row");
      assert.equal(edited.id, comment.id);
      assert.equal(edited.content, "Second wording of the thought.");
      assert.equal(edited.authorId, author, "an edit does not move a comment to another account");
      assert.equal(edited.parentCommentId, null, "an edit does not re-parent a comment");
      assert.equal(edited.createdAt, comment.createdAt, "an edit does not reorder the thread");
      assert.equal(typeof edited.editedAt, "string");
      assert.ok((edited.editedAt ?? "").length > 0);

      // The list read is the one the public page uses, so the correction must be
      // what a reader sees — and the marker must survive the projection.
      const listed = await runtime.store.listArticleComments({ slug, locale: "zh-CN" });
      assert.equal(listed.length, 1);
      assert.equal(listed[0]?.content, "Second wording of the thought.");
      assert.equal(typeof listed[0]?.editedAt, "string");

      // An edit that upgrades to the versioned block document keeps the two
      // content columns consistent; the schema check rejects a mismatch.
      const withBlocks = await runtime.store.updateArticleComment({
        commentId: comment.id, actorId: author, locale: "zh-CN", content: "Rich wording of the thought.",
        contentBlocks: [{ id: "p1", type: "paragraph", text: "Rich wording of the thought." }], contentBlocksVersion: 1,
      });
      assert.equal(withBlocks?.contentBlocksVersion, 1);
      assert.deepEqual(withBlocks?.contentBlocks, [{ id: "p1", type: "paragraph", text: "Rich wording of the thought." }]);

      // A comment that does not exist answers `null`: "not found" and "not yours"
      // stay distinguishable to the caller, and only the second is an error.
      assert.equal(await runtime.store.updateArticleComment({
        commentId: randomUUID(), actorId: author, content: "Nothing to edit.",
      }), null);

      // Deleting the edit's target removes it, and editing it afterwards is
      // `null` rather than a resurrected row.
      assert.equal(await runtime.store.deleteArticleComment({ commentId: comment.id, actorId: author }), true);
      assert.equal(await runtime.store.updateArticleComment({
        commentId: comment.id, actorId: author, content: "After deletion.",
      }), null);
    } finally { await runtime.cleanup(undefined, suffix); }
  });

  test(`${adapterName}: article comment deletion is owner-only and idempotent after deletion`, options, async () => {
    const runtime = await fixture();
    const suffix = randomUUID();
    const slug = `contract-comment-${suffix}`;
    try {
      await runtime.store.createArticle({
        authorId: `article-author-${suffix}`, slug, title: "Comment contract article", summary: "",
        locale: "zh-CN", contentBlocks: [{ id: "p1", type: "paragraph", text: "Shared contract content." }], publish: true,
      });
      const comment = await runtime.store.createArticleComment({
        slug, locale: "zh-CN", actorId: `commenter-a-${suffix}`, content: "A comment for the contract.",
      });
      await assert.rejects(Promise.resolve().then(() => runtime.store.deleteArticleComment({
        commentId: comment.id, actorId: `commenter-b-${suffix}`,
      })), ArticleAuthorizationError);
      assert.equal(await runtime.store.deleteArticleComment({ commentId: comment.id, actorId: `commenter-a-${suffix}` }), true);
      assert.equal(await runtime.store.deleteArticleComment({ commentId: comment.id, actorId: `commenter-a-${suffix}` }), false);
      assert.equal((await runtime.store.listArticleComments({ slug, locale: "zh-CN" })).length, 0);
    } finally { await runtime.cleanup(undefined, suffix); }
  });

  test(`${adapterName}: cursors keep every same-millisecond row, then an empty page`, options, async () => {
    const runtime = await fixture();
    const suffix = randomUUID();
    const authorId = `cursor-ms-author-${suffix}`;
    const ownerId = `cursor-ms-owner-${suffix}`;
    const sameMs = "2026-06-01T00:00:00.123Z";
    const newerMs = "2026-06-01T00:00:00.124Z";
    const olderMs = "2026-06-01T00:00:00.122Z";
    const intruderMs = "2026-06-01T00:00:00.125Z";
    const blocks = [{ id: "p1", type: "paragraph", text: "Cursor contract body." }];
    const hour = new Date(Date.now() + 3_600_000).toISOString();
    const account = (userId, seed) => ({
      userId,
      email: `cursor-ms-${seed}-${suffix}@example.test`,
      passwordHash: "hash-before",
      session: {
        sessionId: randomUUID(), userId, accessTokenId: randomUUID(),
        refreshHash: (seed + suffix.replace(/-/g, "")).padEnd(64, seed), expiresAt: hour,
        accessExpiresAt: new Date(Date.now() + 600_000).toISOString(),
      },
    });
    const newestFirst = (rows, timeKey) => [...rows].sort((a, b) => {
      const left = a[timeKey];
      const right = b[timeKey];
      if (left !== right) return left < right ? 1 : -1;
      return a.id < b.id ? 1 : -1;
    }).map((row) => row.id);
    await runtime.store.createIdentityAccount(account(ownerId, "a"));
    try {
      const articleRows = [];
      for (let index = 0; index < 5; index += 1) {
        const slug = `cursor-ms-work-${index}-${suffix}`;
        const created = await runtime.store.createArticle({
          authorId, slug, title: slug, summary: "", locale: "zh-CN", contentBlocks: blocks, publish: true,
        });
        articleRows.push({ id: created.id, slug, publishedAt: null });
      }
      // Assign times in descending-id order: the smallest id is newest and the
      // largest id is oldest, so UUID order and time order deliberately disagree.
      const articlesById = [...articleRows].sort((a, b) => a.id < b.id ? -1 : 1);
      [newerMs, sameMs, sameMs, sameMs, olderMs].forEach((at, index) => { articlesById[index].publishedAt = at; });
      for (const row of articleRows) await runtime.setArticlePublishedAt(row.slug, row.publishedAt);

      const mediaRows = [];
      for (let index = 0; index < 5; index += 1) {
        const id = randomUUID();
        await runtime.store.createMediaAsset({
          id, ownerId, storageKey: `assets/${ownerId}/${id}.webp`, contentType: "image/webp",
          byteSize: 2048, width: 20, height: 10, sha256: "c".repeat(64),
        });
        mediaRows.push({ id, createdAt: null });
      }
      const assetsById = [...mediaRows].sort((a, b) => a.id < b.id ? -1 : 1);
      [newerMs, sameMs, sameMs, sameMs, olderMs].forEach((at, index) => { assetsById[index].createdAt = at; });
      for (const row of mediaRows) await runtime.setMediaAssetCreatedAt(row.id, row.createdAt);

      const expectedArticleIds = newestFirst(articleRows, "publishedAt");
      const expectedMediaIds = newestFirst(mediaRows, "createdAt");
      const intruderSlug = `cursor-ms-intruder-${suffix}`;
      const intruderAssetId = randomUUID();
      let intruderArticleId = null;
      const insertIntruderArticle = async () => {
        const created = await runtime.store.createArticle({
          authorId, slug: intruderSlug, title: intruderSlug, summary: "", locale: "zh-CN",
          contentBlocks: blocks, publish: true,
        });
        intruderArticleId = created.id;
        await runtime.setArticlePublishedAt(intruderSlug, intruderMs);
      };
      const insertIntruderAsset = async () => {
        await runtime.store.createMediaAsset({
          id: intruderAssetId, ownerId, storageKey: `assets/${ownerId}/${intruderAssetId}.webp`,
          contentType: "image/webp", byteSize: 2048, width: 20, height: 10, sha256: "d".repeat(64),
        });
        await runtime.setMediaAssetCreatedAt(intruderAssetId, intruderMs);
      };

      const walkArticlePages = async () => {
        const seen = [];
        let cursor = null;
        let rows = await runtime.store.listPublishedArticles({ locale: "zh-CN", query: suffix, limit: 1, cursor });
        for (let index = 0; index < expectedArticleIds.length; index += 1) {
          const row = rows[0];
          assert.ok(row, `article page ${index + 1} exists`);
          seen.push(row.id);
          cursor = encodeArticleCursor(row.publishedAt, row.id);
          if (index === 0) await insertIntruderArticle();
          rows = await runtime.store.listPublishedArticles({ locale: "zh-CN", query: suffix, limit: 1, cursor });
        }
        assert.deepEqual(rows, [], "the article tail page is empty");
        assert.deepEqual([...seen].sort(), [...expectedArticleIds].sort(), "every article is read once");
        assert.equal(new Set(seen).size, expectedArticleIds.length, "no article is repeated");
        assert.ok(!seen.includes(intruderArticleId), "a newer insert does not rewind the cursor");
      };
      const walkMediaPages = async () => {
        const seen = [];
        let cursor = null;
        let rows = await runtime.store.listMediaAssets({ ownerId, cursor, limit: 1 });
        for (let index = 0; index < expectedMediaIds.length; index += 1) {
          const row = rows[0];
          assert.ok(row, `media page ${index + 1} exists`);
          seen.push(row.id);
          cursor = { at: new Date(row.createdAt).toISOString(), id: row.id };
          if (index === 0) await insertIntruderAsset();
          rows = await runtime.store.listMediaAssets({ ownerId, cursor, limit: 1 });
        }
        assert.deepEqual(rows, [], "the media tail page is empty");
        assert.deepEqual([...seen].sort(), [...expectedMediaIds].sort(), "every asset is read once");
        assert.equal(new Set(seen).size, expectedMediaIds.length, "no asset is repeated");
        assert.ok(!seen.includes(intruderAssetId), "a newer asset does not rewind the cursor");
      };
      await walkArticlePages();
      await walkMediaPages();
    } finally {
      await runtime.cleanup(undefined, suffix);
    }
  });

  /**
   * The batch port methods (#162).
   *
   * The list serializer now reads a page's authors and taxonomies with two
   * statements instead of three per article. That only holds if the batch
   * answer equals the per-article answer, so these assert equality directly
   * rather than spot-checking a field.
   */
  test(`${adapterName}: batch author profiles equal the per-user reads`, options, async () => {
    const runtime = await fixture();
    const suffix = randomUUID();
    const authorIds = [`batch-author-a-${suffix}`, `batch-author-b-${suffix}`];
    const viewerId = `batch-viewer-${suffix}`;
    try {
      await runtime.store.upsertAuthorProfile({ userId: authorIds[0], displayName: "批量作者甲", bio: "简介甲", locale: "zh-CN" });
      await runtime.store.upsertAuthorProfile({ userId: authorIds[1], displayName: "批量作者乙", bio: "简介乙", locale: "zh-CN" });
      await runtime.store.followUser({ actorId: viewerId, targetUserId: authorIds[0] });

      const batched = await runtime.store.getAuthorProfilesByIds({ userIds: authorIds, locale: "zh-CN", viewerId });
      assert.deepEqual(Object.keys(batched).sort(), [...authorIds].sort());
      for (const userId of authorIds) {
        const single = await runtime.store.getAuthorProfile({ userId, locale: "zh-CN", viewerId });
        assert.deepEqual(batched[userId], single, `${userId}: batch and single must agree`);
      }
      // The viewer's follow state is part of the answer, per author, exactly as
      // the single call reports it.
      assert.equal(batched[authorIds[0]].isFollowing, true);
      assert.equal(batched[authorIds[1]].isFollowing, false);

      // Duplicates are the common case (a three-author page names each author
      // many times); the record must still be keyed by user id and not repeat
      // or drop anyone.
      const withDuplicates = await runtime.store.getAuthorProfilesByIds({
        userIds: [authorIds[0], authorIds[0], authorIds[1], authorIds[0]], locale: "zh-CN", viewerId: null,
      });
      assert.deepEqual(Object.keys(withDuplicates).sort(), [...authorIds].sort());

      // An empty page is a legitimate request: no ids in, no queries needed.
      assert.deepEqual(await runtime.store.getAuthorProfilesByIds({ userIds: [], locale: "zh-CN", viewerId: null }), {});
      // An unknown id is absent from the record rather than an error or a null.
      const missing = await runtime.store.getAuthorProfilesByIds({ userIds: [`batch-missing-${suffix}`], locale: "zh-CN", viewerId: null });
      assert.deepEqual(missing, {});

      // Locale selection is per request, matching the single read.
      await runtime.store.upsertAuthorProfile({ userId: authorIds[0], displayName: "Batch Author A", bio: "Bio A", locale: "en" });
      const english = await runtime.store.getAuthorProfilesByIds({ userIds: [authorIds[0]], locale: "en", viewerId: null });
      assert.equal(english[authorIds[0]].displayName, "Batch Author A");
      const chinese = await runtime.store.getAuthorProfilesByIds({ userIds: [authorIds[0]], locale: "zh-CN", viewerId: null });
      assert.equal(chinese[authorIds[0]].displayName, "批量作者甲");
    } finally { await runtime.cleanup(undefined, suffix); }
  });

  test(`${adapterName}: batch article taxonomies equal the per-article reads`, options, async () => {
    const runtime = await fixture();
    const suffix = randomUUID();
    const actorId = `batch-taxonomy-actor-${suffix}`;
    try {
      // Two taxonomies per kind, named so that ordering is observable: the
      // per-article query sorts by lowercased name then id, and the batch must
      // reproduce that within each article.
      const categories = [];
      for (const name of ["批次乙类", "批次甲类"]) {
        categories.push(await runtime.store.createTaxonomy({
          actorId, actorIsEditor: true, kind: "category",
          slug: `batch-cat-${name.endsWith("甲类") ? "a" : "b"}-${suffix}`,
          name, description: "", locale: "zh-CN",
        }));
      }
      const tag = await runtime.store.createTag({ actorId, name: `#批次标签${suffix.slice(0, 6)}`, locale: "zh-CN" });

      const first = await runtime.store.createArticle({
        authorId: actorId, slug: `batch-taxonomy-first-${suffix}`, title: "第一款", summary: "",
        locale: "zh-CN", contentBlocks: [{ id: "p1", type: "paragraph", text: "正文" }], publish: true,
        categoryIds: categories.map((item) => item.id), tagIds: [tag.id],
      });
      const second = await runtime.store.createArticle({
        authorId: actorId, slug: `batch-taxonomy-second-${suffix}`, title: "第二款", summary: "",
        locale: "zh-CN", contentBlocks: [{ id: "p1", type: "paragraph", text: "正文" }], publish: true,
        categoryIds: [categories[0].id], tagIds: [],
      });
      const third = await runtime.store.createArticle({
        authorId: actorId, slug: `batch-taxonomy-third-${suffix}`, title: "第三款", summary: "",
        locale: "zh-CN", contentBlocks: [{ id: "p1", type: "paragraph", text: "正文" }], publish: true,
      });
      const articleIds = [first.id, second.id, third.id];

      for (const kind of ["category", "tag"]) {
        const batched = await runtime.store.listArticlesTaxonomies({ articleIds, kind, locale: "zh-CN" });
        assert.deepEqual(Object.keys(batched).sort(), [...articleIds].sort(), `${kind}: every article is a key`);
        for (const articleId of articleIds) {
          const single = await runtime.store.listArticleTaxonomies({ articleId, kind, locale: "zh-CN" });
          assert.deepEqual(batched[articleId], single, `${kind}/${articleId}: batch and single must agree, including order`);
        }
        // An article with no taxonomies of the kind is an empty list, not absent.
        assert.deepEqual(batched[third.id], []);
        // And the duplicate-id case must not double any row.
        const duplicated = await runtime.store.listArticlesTaxonomies({ articleIds: [first.id, first.id], kind, locale: "zh-CN" });
        assert.deepEqual(duplicated[first.id], batched[first.id]);
      }
      assert.equal((await runtime.store.listArticlesTaxonomies({ articleIds, kind: "category", locale: "zh-CN" }))[first.id].length, 2, "both categories survived the batch");

      assert.deepEqual(await runtime.store.listArticlesTaxonomies({ articleIds: [], kind: "category", locale: "zh-CN" }), {});
    } finally { await runtime.cleanup(undefined, suffix); }
  });

  /**
   * The materialised media references (#163).
   *
   * The library used to answer "is this image an orphan?" by reading every work
   * body on the site. It now reads a table kept current by the writer's own
   * transaction. That trade is only sound if the table says exactly what the old
   * scan said, at every moment the scan could have been asked — so these assert
   * the *same* answer from `listReferencesForAssets` and from the full scan,
   * rather than checking that a row exists.
   */
  test(`${adapterName}: media references stay in step with the bodies that name them`, options, async () => {
    const runtime = await fixture();
    const suffix = randomUUID();
    const ownerId = `media-ref-owner-${suffix}`;
    const hour = new Date(Date.now() + 3_600_000).toISOString();
    let articleId;
    try {
      await runtime.store.createIdentityAccount({
        userId: ownerId,
        email: `media-ref-${suffix}@example.test`,
        passwordHash: "hash",
        session: {
          sessionId: randomUUID(), userId: ownerId, accessTokenId: randomUUID(),
          refreshHash: (suffix.replace(/-/g, "") + "b").padEnd(64, "b"), expiresAt: hour,
          accessExpiresAt: new Date(Date.now() + 600_000).toISOString(),
        },
      });
      const asset = await runtime.store.createMediaAsset({
        id: randomUUID(), ownerId, storageKey: `${suffix}/a.webp`, contentType: "image/webp",
        byteSize: 12, width: 2, height: 2, sha256: "c".repeat(64),
      });
      const bodyWithImage = [
        { id: "p1", type: "paragraph", text: "有图" },
        { id: "i1", type: "image", src: `/api/media/${asset.id}`, alt: "图" },
      ];

      const article = await runtime.store.createArticle({
        authorId: ownerId, slug: `media-ref-${suffix}`, title: "引用作品", summary: "",
        locale: "zh-CN", publish: true, contentBlocks: bodyWithImage,
      });
      articleId = article.id;

      const fromTable = await runtime.store.listReferencesForAssets({ assetIds: [asset.id] });
      assert.equal(fromTable.length, 1, "the create wrote one reference");
      const fromScan = (await runtime.store.listMediaScanRows()).filter((row) =>
        String(row?.content ?? "").toLowerCase().includes(asset.id.toLowerCase()));
      // Same number of uses, same work, same locale: the table is a substitute for
      // the scan, not a different opinion.
      assert.equal(fromTable.length, fromScan.length, "table and scan must agree on how many uses there are");
      assert.equal(fromTable[0].work.articleId, article.id);
      assert.equal(fromTable[0].work.locale, "zh-CN");
      assert.equal(fromTable[0].work.title, "引用作品");

      // Removing the image from the body must remove the reference in the same
      // transaction — this is the half a backfill cannot do.
      await runtime.store.updateArticle({
        articleId: article.id, actorId: ownerId, slug: article.slug, title: "引用作品",
        summary: "", locale: "zh-CN", publish: true,
        contentBlocks: [{ id: "p1", type: "paragraph", text: "图没了" }],
      });
      assert.deepEqual(await runtime.store.listReferencesForAssets({ assetIds: [asset.id] }), [], "an edit that drops the image drops the reference");

      // And adding a different image adds exactly that one.
      const second = await runtime.store.createMediaAsset({
        id: randomUUID(), ownerId, storageKey: `${suffix}/b.webp`, contentType: "image/webp",
        byteSize: 12, width: 2, height: 2, sha256: "d".repeat(64),
      });
      await runtime.store.updateArticle({
        articleId: article.id, actorId: ownerId, slug: article.slug, title: "引用作品",
        summary: "", locale: "zh-CN", publish: true,
        contentBlocks: [{ id: "i2", type: "image", src: `/api/v1/media/${second.id}`, alt: "新图" }],
      });
      const afterSecond = await runtime.store.listReferencesForAssets({ assetIds: [asset.id, second.id] });
      assert.equal(afterSecond.length, 1, "only the current image is referenced");
      assert.equal(afterSecond[0].work.articleId, article.id);

      // A body may name an id that was never uploaded here; the save must still
      // succeed and the phantom must not become a row.
      const phantom = randomUUID();
      await runtime.store.updateArticle({
        articleId: article.id, actorId: ownerId, slug: article.slug, title: "引用作品",
        summary: "", locale: "zh-CN", publish: true,
        contentBlocks: [{ id: "i3", type: "image", src: `/api/media/${phantom}`, alt: "外部" }],
      });
      assert.deepEqual(await runtime.store.listReferencesForAssets({ assetIds: [phantom] }), [], "an unknown id is not a reference row");

      // An empty page asks nothing and gets nothing.
      assert.deepEqual(await runtime.store.listReferencesForAssets({ assetIds: [] }), []);
    } finally {
      if (articleId) await runtime.cleanup(undefined, suffix);
    }
  });

  test(`${adapterName}: an avatar is a reference with no article behind it`, options, async () => {
    const runtime = await fixture();
    const suffix = randomUUID();
    const ownerId = `avatar-ref-owner-${suffix}`;
    const hour = new Date(Date.now() + 3_600_000).toISOString();
    try {
      await runtime.store.createIdentityAccount({
        userId: ownerId,
        email: `avatar-ref-${suffix}@example.test`,
        passwordHash: "hash",
        session: {
          sessionId: randomUUID(), userId: ownerId, accessTokenId: randomUUID(),
          refreshHash: (suffix.replace(/-/g, "") + "e").padEnd(64, "e"), expiresAt: hour,
          accessExpiresAt: new Date(Date.now() + 600_000).toISOString(),
        },
      });
      const asset = await runtime.store.createMediaAsset({
        id: randomUUID(), ownerId, storageKey: `${suffix}/face.webp`, contentType: "image/webp",
        byteSize: 12, width: 2, height: 2, sha256: "f".repeat(64),
      });
      // The avatar half is the one a body-only view misses entirely, which is how
      // a live account's picture used to be offered as an orphan.
      await runtime.store.upsertAuthorProfile({
        userId: ownerId, displayName: "头像作者", bio: "", locale: "zh-CN",
        avatarUrl: `/api/media/${asset.id}`,
      });
      const refs = await runtime.store.listReferencesForAssets({ assetIds: [asset.id] });
      assert.equal(refs.length, 1);
      assert.equal(refs[0].kind, "avatar", "an avatar is reported as an avatar, not as a work");

      // Clearing the avatar clears the reference.
      await runtime.store.upsertAuthorProfile({ userId: ownerId, displayName: "头像作者", bio: "", locale: "zh-CN", avatarUrl: null });
      assert.deepEqual(await runtime.store.listReferencesForAssets({ assetIds: [asset.id] }), []);
    } finally { await runtime.cleanup(undefined, suffix); }
  });

  /**
   * #156: the database, not a read, decides whether an image is in use.
   *
   * Every check that reads and then writes has a window between the two. The
   * reference table (#163) made the check cheap; this makes it impossible to get
   * wrong, because `ON DELETE RESTRICT` is enforced by the DELETE itself. The
   * test does not simulate a race — it asserts the constraint directly, which is
   * what a race would end up hitting, and which no amount of retrying can slip
   * past.
   */
  test(`${adapterName}: the database refuses to delete an image a work still uses`, options, async () => {
    const runtime = await fixture();
    const suffix = randomUUID();
    const ownerId = `restrict-owner-${suffix}`;
    const hour = new Date(Date.now() + 3_600_000).toISOString();
    try {
      await runtime.store.createIdentityAccount({
        userId: ownerId, email: `restrict-${suffix}@example.test`, passwordHash: "hash",
        session: {
          sessionId: randomUUID(), userId: ownerId, accessTokenId: randomUUID(),
          refreshHash: (suffix.replace(/-/g, "") + "c").padEnd(64, "c"), expiresAt: hour,
          accessExpiresAt: new Date(Date.now() + 600_000).toISOString(),
        },
      });
      const asset = await runtime.store.createMediaAsset({
        id: randomUUID(), ownerId, storageKey: `${suffix}/r.webp`, contentType: "image/webp",
        byteSize: 12, width: 2, height: 2, sha256: "d".repeat(64),
      });
      const article = await runtime.store.createArticle({
        authorId: ownerId, slug: `restrict-${suffix}`, title: "在用图片", summary: "",
        locale: "zh-CN", publish: true,
        contentBlocks: [{ id: "i1", type: "image", src: `/api/media/${asset.id}`, alt: "图" }],
      });

      // The guarded delete reports it as in use rather than deleting it.
      const refused = await runtime.store.deleteUnusedMediaAsset({ id: asset.id, ownerId });
      assert.equal(refused?.deleted ?? null, null, "an in-use image is not deleted");
      assert.ok((refused?.usedBy ?? []).length > 0, "and the caller is told what uses it");

      // Deleting the work first releases it, and then the same call succeeds.
      await runtime.store.deleteArticle({ articleId: article.id, actorId: ownerId });
      await runtime.store.purgeExpiredArticles({
        retentionDays: 30, now: new Date(Date.now() + 400 * 86_400_000), limit: 100,
      });
      const allowed = await runtime.store.deleteUnusedMediaAsset({ id: asset.id, ownerId });
      assert.equal(allowed?.deleted?.id, asset.id, "once nothing references it, the delete goes through");
    } finally { await runtime.cleanup(undefined, suffix); }
  });

  /**
   * #156, the half that was missing entirely: an avatar is a reference too, and
   * it used to be `ON DELETE SET NULL`, so deleting someone's picture succeeded
   * and silently blanked the avatar.
   */
  test(`${adapterName}: the database refuses to delete an image in use as an avatar`, options, async () => {
    const runtime = await fixture();
    const suffix = randomUUID();
    const ownerId = `restrict-avatar-owner-${suffix}`;
    const hour = new Date(Date.now() + 3_600_000).toISOString();
    try {
      await runtime.store.createIdentityAccount({
        userId: ownerId, email: `restrict-avatar-${suffix}@example.test`, passwordHash: "hash",
        session: {
          sessionId: randomUUID(), userId: ownerId, accessTokenId: randomUUID(),
          refreshHash: (suffix.replace(/-/g, "") + "d").padEnd(64, "d"), expiresAt: hour,
          accessExpiresAt: new Date(Date.now() + 600_000).toISOString(),
        },
      });
      const asset = await runtime.store.createMediaAsset({
        id: randomUUID(), ownerId, storageKey: `${suffix}/face.webp`, contentType: "image/webp",
        byteSize: 12, width: 2, height: 2, sha256: "e".repeat(64),
      });
      await runtime.store.upsertAuthorProfile({
        userId: ownerId, displayName: "头像作者", bio: "", locale: "zh-CN",
        avatarUrl: `/api/media/${asset.id}`,
      });

      const refused = await runtime.store.deleteUnusedMediaAsset({ id: asset.id, ownerId });
      assert.equal(refused?.deleted ?? null, null, "an avatar image is not deleted");
      assert.ok((refused?.usedBy ?? []).some((entry) => entry.kind === "avatar"), "and it is reported as an avatar");

      // Clearing the avatar releases the image.
      await runtime.store.upsertAuthorProfile({ userId: ownerId, displayName: "头像作者", bio: "", locale: "zh-CN", avatarUrl: null });
      const allowed = await runtime.store.deleteUnusedMediaAsset({ id: asset.id, ownerId });
      assert.equal(allowed?.deleted?.id, asset.id, "after the avatar is cleared, the delete goes through");
    } finally { await runtime.cleanup(undefined, suffix); }
  });

  test(`${adapterName}: import links are one row per page edition and reads stay owner-scoped`, options, async () => {
    const runtime = await fixture();
    const suffix = randomUUID();
    const author = `import-link-author-${suffix}`;
    const other = `import-link-other-${suffix}`;
    const externalId = `page-${suffix}`;
    const syncedAt = "2026-11-03T09:00:00.000Z";
    try {
      const article = await runtime.store.createArticle({
        authorId: author, slug: `import-link-${suffix}`, title: "导入的作品",
        contentBlocks: [{ id: "block-1", type: "paragraph", text: "正文" }], publish: false,
      });

      // Nothing is linked before the first import.
      assert.equal(await runtime.store.getExternalContentLink({ provider: "notion", externalId, locale: "zh-CN" }), null);

      const first = await runtime.store.upsertExternalContentLink({
        provider: "notion", externalId, locale: "zh-CN", articleId: article.id,
        ownerId: author, digest: "a".repeat(16), syncedAt,
      });
      assert.equal(first.articleId, article.id);
      assert.equal(first.ownerId, author);
      assert.equal(first.syncedAt, syncedAt, "both providers answer the same instant, to the millisecond");

      // Re-linking the same page edition replaces it: one page, one row.
      const second = await runtime.store.upsertExternalContentLink({
        provider: "notion", externalId, locale: "zh-CN", articleId: article.id,
        ownerId: author, digest: "b".repeat(16), syncedAt: "2026-11-03T10:00:00.000Z",
      });
      assert.equal(second.digest, "b".repeat(16));
      assert.equal(second.syncedAt, "2026-11-03T10:00:00.000Z");
      const reread = await runtime.store.getExternalContentLink({ provider: "notion", externalId, locale: "zh-CN" });
      assert.equal(reread?.digest, "b".repeat(16), "the second import updated the row instead of adding one");

      // A concurrent claimant must not replace the owner or retarget the link.
      const rival = await runtime.store.createArticle({ authorId: other, slug: `import-rival-${suffix}`, title: "其他作品",
        contentBlocks: [{ id: "block-1", type: "paragraph", text: "正文" }], publish: false });
      await assert.rejects(async () => runtime.store.upsertExternalContentLink({
        provider: "notion", externalId, locale: "zh-CN", articleId: rival.id, ownerId: other, digest: "c", syncedAt,
      }), (error: unknown) => {
        assert.ok(error instanceof ImportConflictError);
        assert.equal(error.code, "IMPORT_CONFLICT");
        // SQLite's BEFORE INSERT trigger runs before the guarded PK upsert;
        // PostgreSQL may deny through that guard instead of the exclusion.
        assert.match(error.message, /already (owned by another account|linked to another work or account)/);
        assert.ok(!error.message.includes(author) && !error.message.includes(article.id));
        return true;
      });
      await assert.rejects(async () => runtime.store.upsertExternalContentLink({
        provider: "notion", externalId, locale: "zh-CN", articleId: rival.id, ownerId: author, digest: "c", syncedAt,
      }), (error: unknown) => {
        assert.ok(error instanceof ImportConflictError);
        assert.equal(error.reason, "provenance");
        assert.match(error.message, /already linked/);
        return true;
      });
      assert.equal((await runtime.store.getExternalContentLink({ provider: "notion", externalId, locale: "zh-CN" }))?.articleId, article.id);
      assert.deepEqual(await runtime.store.getExternalContentLink({ provider: "notion", externalId, locale: "zh-CN" }), second,
        "neither a foreign owner nor a retarget attempt may change any field of the original link");

      // Editions of one work are separate links pointing at the same article.
      const english = await runtime.store.upsertExternalContentLink({
        provider: "notion", externalId: `${externalId}-en`, locale: "en", articleId: article.id,
        ownerId: author, digest: "c".repeat(16), syncedAt,
      });
      assert.equal(english.articleId, article.id);

      // The owner can read the work by id; another account reads nothing, and a
      // deleted work is not readable either.
      assert.equal((await runtime.store.getMyArticle({ articleId: article.id, actorId: author }))?.slug, article.slug);
      assert.equal(await runtime.store.getMyArticle({ articleId: article.id, actorId: other }), null);
      await runtime.store.deleteArticle({ articleId: article.id, actorId: author });
      assert.equal(await runtime.store.getMyArticle({ articleId: article.id, actorId: author }), null, "a tombstone is not an import target");
    } finally { await runtime.cleanup(undefined, suffix); }
  });

  test(`${adapterName}: competing page claims never overwrite the winning link`, options, async () => {
    const runtime = await fixture();
    const suffix = randomUUID();
    const externalId = `race-${suffix}`;
    const authorA = `race-a-${suffix}`;
    const authorB = `race-b-${suffix}`;
    const input = { title: "竞态", contentBlocks: [{ id: "p", type: "paragraph", text: "正文" }], publish: false };
    try {
      const a = await runtime.store.createArticle({ ...input, authorId: authorA, slug: `race-a-${suffix}` });
      const b = await runtime.store.createArticle({ ...input, authorId: authorB, slug: `race-b-${suffix}` });
      const result = await Promise.allSettled([
        runtime.store.upsertExternalContentLink({ provider: "notion", externalId, locale: "zh-CN", articleId: a.id, ownerId: authorA, digest: "a", syncedAt: "2026-11-03T09:00:00.000Z" }),
        runtime.store.upsertExternalContentLink({ provider: "notion", externalId, locale: "zh-CN", articleId: b.id, ownerId: authorB, digest: "b", syncedAt: "2026-11-03T09:00:00.000Z" }),
      ]);
      assert.equal(result.filter((r) => r.status === "fulfilled").length, 1);
      assert.equal(result.filter((r) => r.status === "rejected").length, 1);
      const winner = result.find((r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof runtime.store.upsertExternalContentLink>>> => r.status === "fulfilled");
      assert.ok(winner);
      assert.equal((await runtime.store.getExternalContentLink({ provider: "notion", externalId, locale: "zh-CN" }))?.articleId, winner.value.articleId);
    } finally { await runtime.cleanup(undefined, suffix); }
  });

  test(`${adapterName}: create-key lookup is author-scoped and finds tombstones`, options, async () => {
    const runtime = await fixture();
    const suffix = randomUUID();
    const author = `recovery-author-${suffix}`;
    const other = `recovery-other-${suffix}`;
    const key = `notion-seed:page-${suffix}`;
    try {
      const article = await runtime.store.createArticle({ authorId: author, slug: `recovery-${suffix}`, title: "恢复",
        contentBlocks: [{ id: "p", type: "paragraph", text: "正文" }], publish: false, idempotencyKey: key });
      assert.equal(await runtime.store.findMyArticleByCreateKey({ actorId: author, key }), article.id);
      assert.equal(await runtime.store.findMyArticleByCreateKey({ actorId: other, key }), null);
      assert.equal(await runtime.store.findMyArticleByCreateKey({ actorId: author, key: `${key}-other` }), null);
      await runtime.store.deleteArticle({ articleId: article.id, actorId: author });
      assert.equal(await runtime.store.findMyArticleByCreateKey({ actorId: author, key }), article.id);
      assert.equal(await runtime.store.getMyArticle({ articleId: article.id, actorId: author }), null);
    } finally { await runtime.cleanup(undefined, suffix); }
  });

  test(`${adapterName}: the export's two reads are the inverse of the import's`, options, async () => {
    const runtime = await fixture();
    const suffix = randomUUID();
    const author = `export-author-${suffix}`;
    const other = `export-other-${suffix}`;
    const slug = `export-work-${suffix}`;
    try {
      const primary = await runtime.store.createArticle({
        authorId: author, slug, title: "墙壁",
        contentBlocks: [{ id: "block-1", type: "paragraph", text: "正文" }], publish: true,
      });
      // One work, two editions: the export asks for the work by its address and
      // gets the editions back in locale order, so the primary one is the
      // caller's decision rather than the driver's.
      await runtime.store.updateArticle({
        articleId: primary.id, actorId: author, slug, title: "The Wall",
        contentBlocks: [{ id: "block-1", type: "paragraph", text: "The body" }],
        locale: "en", publish: true,
      });
      const editions = await runtime.store.listMyArticleEditions({ slug, actorId: author });
      assert.deepEqual(editions.map((edition) => edition.locale), ["en", "zh-CN"], "ordered by locale, on both providers");
      assert.equal(new Set(editions.map((edition) => edition.id)).size, 1, "one work, not two articles");
      assert.equal(editions[0]!.slug, slug);

      // The same address is not a permission: another account reads nothing.
      assert.deepEqual(await runtime.store.listMyArticleEditions({ slug, actorId: other }), []);

      // Provenance, read the other way round: by work rather than by page.
      await runtime.store.upsertExternalContentLink({
        provider: "notion", externalId: `page-${suffix}`, locale: "zh-CN", articleId: primary.id,
        ownerId: author, digest: "d".repeat(16), syncedAt: "2026-11-03T09:00:00.000Z",
      });
      const links = await runtime.store.listExternalContentLinks({ provider: "notion", articleId: primary.id, ownerId: author });
      assert.equal(links.length, 1);
      assert.equal(links[0]!.externalId, `page-${suffix}`, "the page the work came from, so an export can name it again");
      assert.equal(links[0]!.locale, "zh-CN");
      // Owner-scoped like every other read here.
      assert.deepEqual(await runtime.store.listExternalContentLinks({ provider: "notion", articleId: primary.id, ownerId: other }), []);
      // Another provider's rows are not this question's answer.
      assert.deepEqual(await runtime.store.listExternalContentLinks({ provider: "notion", articleId: other, ownerId: author }), []);

      // A tombstone is not an exportable work: deleting it released the address.
      await runtime.store.deleteArticle({ articleId: primary.id, actorId: author });
      assert.deepEqual(await runtime.store.listMyArticleEditions({ slug, actorId: author }), []);
    } finally { await runtime.cleanup(undefined, suffix); }
  });
}

registerForEngines(registerReadAndReferenceContracts);
