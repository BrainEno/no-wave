/**
 * Work deletion, restore and tombstones, taxonomy, likes, comment threads, view counts and media deletion guards.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { CommentDepthError, COMMENT_DEPTH_LIMIT_MESSAGE, MAX_COMMENT_REPLY_DEPTH } from "../domain/comment-content.ts";
import { IdempotencyConflictError, ArticleAuthorizationError, ArticleNotFoundError } from "../domain/errors.ts";
import { registerForEngines, registerPostgresStore } from "./test-support/persistence-adapter-contract-fixtures.ts";

registerPostgresStore();

function registerWorkContracts(adapterName, fixture, options = {}) {
  test(`${adapterName}: deleting a work takes it out of the desk and releases its address`, options, async () => {
    const runtime = await fixture();
    const suffix = randomUUID();
    const slug = `contract-delete-${suffix}`;
    const authorId = `author-${suffix}`;
    const contentBlocks = [{ id: "p1", type: "paragraph", text: "Deleted on purpose." }];
    try {
      const created = await runtime.store.createArticle({
        authorId, slug, title: "Soon deleted", locale: "zh-CN", contentBlocks, publish: true,
      });
      // The public list searches titles and summaries, not addresses.
      assert.ok((await runtime.store.listPublishedArticles({ locale: "zh-CN", query: "Soon deleted" })).some((article) => article.id === created.id));

      await assert.rejects(Promise.resolve().then(() => runtime.store.deleteArticle({
        articleId: created.id, actorId: `not-author-${suffix}`,
      })), ArticleAuthorizationError);

      const deleted = await runtime.store.deleteArticle({ articleId: created.id, actorId: authorId });
      assert.equal(deleted.id, created.id);
      assert.ok(deleted.deletedAt, "deletion is timestamped, not silent");

      // Gone from the reader's feed and from the author's own desk.
      assert.equal((await runtime.store.listPublishedArticles({ locale: "zh-CN", query: "Soon deleted" })).length, 0);
      assert.equal((await runtime.store.listMyArticles({ actorId: authorId, locale: "zh-CN" })).filter((article) => article.id === created.id).length, 0);

      // A tombstone is not a work any more: it cannot be updated, and deleting it
      // twice is a 404 rather than a second tombstone over the first.
      await assert.rejects(Promise.resolve().then(() => runtime.store.updateArticle({
        articleId: created.id, actorId: authorId, slug, title: "Back again", locale: "zh-CN", contentBlocks, publish: true,
      })), ArticleNotFoundError);
      await assert.rejects(Promise.resolve().then(() => runtime.store.deleteArticle({
        articleId: created.id, actorId: authorId,
      })), ArticleNotFoundError);

      // The address is released, so rewriting the same title is not a dead end.
      const rewritten = await runtime.store.createArticle({
        authorId, slug, title: "Written again", locale: "zh-CN", contentBlocks, publish: true,
      });
      assert.equal(rewritten.slug, slug);
      assert.ok((await runtime.store.listPublishedArticles({ locale: "zh-CN", query: "Written again" })).some((article) => article.id === rewritten.id));
    } finally { await runtime.cleanup(undefined, suffix); }
  });

  test(`${adapterName}: a deleted work can be restored, and a tombstone past its window is swept`, options, async () => {
    const runtime = await fixture();
    const suffix = randomUUID();
    const slug = `contract-restore-${suffix}`;
    const authorId = `author-${suffix}`;
    const contentBlocks = [{ id: "p1", type: "paragraph", text: "Restored on purpose." }];
    try {
      const created = await runtime.store.createArticle({
        authorId, slug, title: "Soon restored", locale: "zh-CN", contentBlocks, publish: true,
      });
      // A reader's words, written before the deletion: the sweep removes them
      // with the work, so the recycle bin has to name them.
      await runtime.store.createArticleComment({
        slug, locale: "zh-CN", actorId: `commenter-a-${suffix}`, content: "A reader's words.",
      });
      await runtime.store.deleteArticle({ articleId: created.id, actorId: authorId });

      // The recycle bin is the author's own tombstones, each one timestamped.
      const tombstones = await runtime.store.listMyDeletedArticles({ actorId: authorId, locale: "zh-CN" });
      assert.ok(tombstones.some((article) => article.id === created.id), "a deleted work is still the author's to find");
      assert.ok(tombstones.every((article) => typeof article.deletedAt === "string" && article.deletedAt.length > 0));
      // The cost of the window is other people's words, and it is counted here
      // rather than guessed by the desk.
      assert.equal(tombstones.find((article) => article.id === created.id)?.commentCount, 1);
      // One author's recycle bin is not another author's.
      assert.equal((await runtime.store.listMyDeletedArticles({ actorId: `other-${suffix}`, locale: "zh-CN" })).filter((article) => article.id === created.id).length, 0);

      // Restoring is owner-scoped, and an unknown id is the same 404 as a live work.
      await assert.rejects(Promise.resolve().then(() => runtime.store.restoreArticle({
        articleId: created.id, actorId: `not-author-${suffix}`,
      })), ArticleAuthorizationError);
      await assert.rejects(Promise.resolve().then(() => runtime.store.restoreArticle({
        articleId: randomUUID(), actorId: authorId,
      })), ArticleNotFoundError);

      const restored = await runtime.store.restoreArticle({ articleId: created.id, actorId: authorId, locale: "zh-CN" });
      assert.equal(restored.id, created.id);
      // A restored work is a draft: deleting withdrew it, and putting a public
      // address back is the author's decision to make again, not a side effect
      // of undoing a mistake.
      assert.equal(restored.status, "draft");
      assert.equal(restored.slug, slug, "the address the tombstone released comes back with it");
      assert.ok((await runtime.store.listMyArticles({ actorId: authorId, locale: "zh-CN" })).some((article) => article.id === created.id));
      assert.equal((await runtime.store.listMyDeletedArticles({ actorId: authorId, locale: "zh-CN" })).filter((article) => article.id === created.id).length, 0);
      assert.equal((await runtime.store.listPublishedArticles({ locale: "zh-CN", query: "Soon restored" })).length, 0, "restoring must not republish");
      // A second restore is a 404, exactly like a second delete.
      await assert.rejects(Promise.resolve().then(() => runtime.store.restoreArticle({
        articleId: created.id, actorId: authorId,
      })), ArticleNotFoundError);

      // The sweep is bounded by the window, not by how long ago the row was
      // written: inside it the work is still recoverable, past it, it is gone.
      const swept = await runtime.store.createArticle({ authorId, slug: `${slug}-swept`, title: "Soon swept", locale: "zh-CN", contentBlocks });
      await runtime.store.deleteArticle({ articleId: swept.id, actorId: authorId });
      assert.equal((await runtime.store.listMyDeletedArticles({ actorId: authorId, locale: "zh-CN" })).find((article) => article.id === swept.id)?.commentCount, 0);
      const kept = await runtime.store.createArticle({ authorId, slug: `${slug}-kept`, title: "Not yet swept", locale: "zh-CN", contentBlocks });
      await runtime.store.deleteArticle({ articleId: kept.id, actorId: authorId });
      const deletedAt = new Date();
      assert.equal((await runtime.store.purgeExpiredArticles({ retentionDays: 30, now: deletedAt })).purged, 0);
      const past = await runtime.store.purgeExpiredArticles({ retentionDays: 30, now: new Date(deletedAt.getTime() + 31 * 86_400_000), limit: 10 });
      assert.equal(past.purged, 2, "both tombstones are past the window");
      assert.equal((await runtime.store.listMyDeletedArticles({ actorId: authorId, locale: "zh-CN" })).length, 0);
      // Purged means gone, not hidden: there is nothing left to restore.
      await assert.rejects(Promise.resolve().then(() => runtime.store.restoreArticle({
        articleId: swept.id, actorId: authorId,
      })), ArticleNotFoundError);
    } finally { await runtime.cleanup(undefined, suffix); }
  });

  /**
   * #241: delete/restore must be a cycle, not a ratchet.
   *
   * Two invariants were broken by appending `-deleted-<id8>` to whatever the row
   * already held. The suffix stacked — 17 characters per delete, forever — and a
   * long address went over the 160-character stored contract, so a restored
   * draft could be deleted but never saved again: `validateArticleSlug` refuses
   * the very slug the store had just written.
   */
  test(`${adapterName}: repeated delete and restore keeps the tombstone slug storable`, options, async () => {
    const runtime = await fixture();
    const suffix = randomUUID();
    const authorId = `slug-cycle-${suffix}`;
    // A legal address at the edge of the contract: 150 characters, so any suffix
    // takes it over 160 unless the base makes room.
    const longSlug = `cycle-${"a".repeat(150 - "cycle-".length)}`;
    assert.equal(longSlug.length, 150);
    const contentBlocks = [{ id: "p1", type: "paragraph", text: "Long addressed work." }];
    try {
      const created = await runtime.store.createArticle({
        authorId, slug: longSlug, title: "Long address", summary: "", locale: "zh-CN", contentBlocks, publish: true,
      });

      // First delete: the released address must already fit the contract.
      const deleted = await runtime.store.deleteArticle({ articleId: created.id, actorId: authorId });
      assert.equal(deleted.id, created.id);
      const tombstone = (await runtime.store.listMyDeletedArticles({ actorId: authorId, locale: "zh-CN" }))
        .find((article) => article.id === created.id);
      assert.ok(tombstone, "the tombstone exists");
      assert.ok(tombstone.slug.length <= 160, `a tombstone slug must fit the contract, got ${tombstone.slug.length}`);
      assert.match(tombstone.slug, /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
      assert.equal(tombstone.slug.endsWith(`-deleted-${created.id.slice(0, 8)}`), true);

      // Somebody else takes the address the tombstone released.
      const squatter = await runtime.store.createArticle({
        authorId: `squatter-${suffix}`, slug: longSlug, title: "Same address", summary: "",
        locale: "zh-CN", contentBlocks, publish: false,
      });

      // Restoring must succeed, and must not stack. For an address this long the
      // released slug was truncated to make room for its suffix, so the address
      // the restore can reclaim is that truncated one — shorter than the original,
      // still legal, and never a failure over an address the author cannot see.
      const restored = await runtime.store.restoreArticle({ articleId: created.id, actorId: authorId, locale: "zh-CN" });
      assert.ok(restored.slug.length <= 160, `restored slug must fit the contract, got ${restored.slug.length}`);
      assert.match(restored.slug, /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
      assert.notEqual(restored.slug, longSlug, "the squatter holds the original address");
      assert.equal(longSlug.startsWith(restored.slug), true, "and what comes back is that address, truncated to fit");

      // The draft has to be editable again: this is the failure the issue
      // reported — a slug the store wrote but the contract refuses.
      const saved = await runtime.store.updateArticle({
        articleId: created.id, actorId: authorId, slug: restored.slug,
        title: "Long address, edited after restore", summary: "", locale: "zh-CN",
        contentBlocks, publish: false,
      });
      assert.equal(saved.id, created.id);

      // And delete twice more: the suffix must not accumulate.
      for (let cycle = 0; cycle < 2; cycle += 1) {
        await runtime.store.deleteArticle({ articleId: created.id, actorId: authorId });
        const current = (await runtime.store.listMyDeletedArticles({ actorId: authorId, locale: "zh-CN" }))
          .find((article) => article.id === created.id);
        assert.ok(current);
        assert.ok(current.slug.length <= 160, `cycle ${cycle + 2}: ${current.slug.length} characters`);
        assert.equal(
          current.slug.split("-deleted-").length - 1, 1,
          `cycle ${cycle + 2} must not stack suffixes: ${current.slug}`,
        );
        const back = await runtime.store.restoreArticle({ articleId: created.id, actorId: authorId, locale: "zh-CN" });
        assert.ok(back.slug.length <= 160);
        assert.equal(back.slug.includes("-deleted-"), false, "a restore reclaims an address; it does not keep the tombstone's");
      }

      // The squatter's address is never disturbed by any of this.
      const squatterNow = (await runtime.store.listMyArticles({ actorId: `squatter-${suffix}`, locale: "zh-CN" }))
        .find((article) => article.id === squatter.id);
      assert.equal(squatterNow?.slug, longSlug);
    } finally { await runtime.cleanup(undefined, suffix); }
  });

  test(`${adapterName}: tombstone sweeps honor the strict cutoff, age order, and batch limit`, options, async () => {
    const runtime = await fixture();
    const suffix = randomUUID(), authorId = `author-${suffix}`;
    const times = [
      "2000-01-01T00:00:00.000Z", "2000-01-01T12:00:00.000Z",
      "2000-01-02T00:00:00.000Z", "2000-01-02T00:00:00.001Z",
    ];
    const ids: string[] = [];
    try {
      for (const [index, deletedAt] of times.entries()) {
        const article = await runtime.store.createArticle({
          authorId, slug: `contract-restore-${suffix}-boundary-${index}`, title: `Boundary ${index}`,
          locale: "zh-CN", contentBlocks: [{ id: "p1", type: "paragraph", text: "Boundary test." }],
        });
        ids.push(article.id);
        await runtime.store.deleteArticle({ articleId: article.id, actorId: authorId });
        await runtime.setArticleDeletedAt(article.id, deletedAt);
      }
      const remaining = async () => new Set((await runtime.store.listMyDeletedArticles({ actorId: authorId })).map((article) => article.id));
      const input = { retentionDays: 30, now: "2000-02-01T00:00:00.000Z", limit: 1 };
      assert.equal((await runtime.store.purgeExpiredArticles(input)).purged, 1);
      assert.deepEqual(await remaining(), new Set(ids.slice(1)), "the oldest eligible tombstone is removed first");
      assert.equal((await runtime.store.purgeExpiredArticles(input)).purged, 1);
      assert.deepEqual(await remaining(), new Set(ids.slice(2)), "limit bounds each sweep");
      assert.equal((await runtime.store.purgeExpiredArticles(input)).purged, 0, "exactly at the cutoff is not older than the window");
      assert.equal((await runtime.store.purgeExpiredArticles({ ...input, now: "2000-02-01T00:00:00.001Z" })).purged, 1);
      assert.deepEqual(await remaining(), new Set([ids[3]]));
      assert.equal((await runtime.store.purgeExpiredArticles({ ...input, now: "2000-02-01T00:00:00.002Z" })).purged, 1);
      assert.equal((await remaining()).size, 0);
    } finally { await runtime.cleanup(undefined, suffix); }
  });

  test(`${adapterName}: a work's commenters are listed once each, in the order they first wrote`, options, async () => {
    const runtime = await fixture();
    const suffix = randomUUID();
    const slug = `contract-commenters-${suffix}`;
    const articleId = `commenter-article-${suffix}`;
    try {
      const article = await runtime.store.createArticle({
        authorId: `article-author-${suffix}`, slug, title: "Commenters contract article", summary: "",
        locale: "zh-CN", contentBlocks: [{ id: "p1", type: "paragraph", text: "Shared contract content." }], publish: true,
      });
      // One reader who wrote twice is still one reader with one inbox.
      await runtime.store.createArticleComment({ slug, locale: "zh-CN", actorId: `commenter-a-${suffix}`, content: "First." });
      await runtime.store.createArticleComment({ slug, locale: "zh-CN", actorId: `commenter-b-${suffix}`, content: "Second." });
      await runtime.store.createArticleComment({ slug, locale: "zh-CN", actorId: `commenter-a-${suffix}`, content: "Again." });

      assert.deepEqual(
        await runtime.store.listArticleCommentAuthorIds({ articleId: article.id }),
        [`commenter-a-${suffix}`, `commenter-b-${suffix}`],
      );
      // Bounded, because the list is read inside the request that deletes the
      // work: a work with ten thousand commenters is not a reason to hold it open.
      assert.deepEqual(await runtime.store.listArticleCommentAuthorIds({ articleId: article.id, limit: 1 }), [`commenter-a-${suffix}`]);
      assert.deepEqual(await runtime.store.listArticleCommentAuthorIds({ articleId: randomUUID() }), []);
      await assert.rejects(
        Promise.resolve().then(() => runtime.store.listArticleCommentAuthorIds({ articleId: "not-a-uuid" })),
        { code: "BAD_USER_INPUT" },
      );
      await assert.rejects(
        Promise.resolve().then(() => runtime.store.listArticleCommentAuthorIds({ articleId, limit: 0 })),
        { code: "BAD_USER_INPUT" },
      );
    } finally { await runtime.cleanup(undefined, suffix); }
  });

  test(`${adapterName}: published articles are discoverable through their assigned taxonomy`, options, async () => {
    const runtime = await fixture();
    const suffix = randomUUID();
    const slug = `contract-published-${suffix}`;
    try {
      const taxonomy = await runtime.store.createTaxonomy({
        actorId: `taxonomy-owner-${suffix}`, actorIsEditor: true, kind: "category", slug: `contract-category-${suffix}`,
        name: "Contract category", description: "Shared persistence contract", locale: "zh-CN",
      });
      const article = await runtime.store.createArticle({
        authorId: `article-author-${suffix}`, slug, title: "Taxonomy contract article", summary: "",
        locale: "zh-CN", contentBlocks: [{ id: "p1", type: "paragraph", text: "Shared contract content." }], publish: true, categoryIds: [taxonomy.id],
      });
      const secondArticle = await runtime.store.createArticle({
        authorId: `article-author-${suffix}`, slug: `${slug}-second`, title: "Second taxonomy contract article", summary: "",
        locale: "zh-CN", contentBlocks: [{ id: "p1", type: "paragraph", text: "Second shared contract content." }], publish: true, categoryIds: [taxonomy.id],
      });
      const taxonomyArticles = await runtime.store.listTaxonomyArticles({ kind: "category", slug: taxonomy.slug, locale: "zh-CN", limit: 10 });
      assert.ok(taxonomyArticles.some((item) => item.id === article.id));
      assert.ok(taxonomyArticles.some((item) => item.id === secondArticle.id));
      const nextPage = await runtime.store.listTaxonomyArticles({ kind: "category", slug: taxonomy.slug, locale: "zh-CN", limit: 1, offset: 1 });
      assert.deepEqual(nextPage.map((item) => item.id), taxonomyArticles.slice(1, 2).map((item) => item.id));
      await assert.rejects(
        Promise.resolve().then(() => runtime.store.listTaxonomyArticles({ kind: "category", slug: taxonomy.slug, locale: "zh-CN", limit: 1, offset: -1 })),
        { code: "BAD_USER_INPUT" },
      );
      const assigned = await runtime.store.listArticleTaxonomies({ articleId: article.id, kind: "category", locale: "zh-CN" });
      assert.ok(assigned.some((item) => item.id === taxonomy.id));
    } finally { await runtime.cleanup(undefined, suffix); }
  });

  test(`${adapterName}: taxonomy lists provide stable bounded offset pagination`, options, async () => {
    const runtime = await fixture();
    const suffix = randomUUID();
    const query = `Pagination contract ${suffix}`;
    try {
      for (const label of ["A", "B", "C"]) {
        await runtime.store.createTaxonomy({
          actorId: `taxonomy-owner-${suffix}`, actorIsEditor: true, kind: "category",
          slug: `pagination-${label.toLowerCase()}-${suffix}`,
          name: `${query} ${label}`, description: "",
          locale: "zh-CN",
        });
      }
      const all = await runtime.store.listTaxonomies({
        kind: "category", locale: "zh-CN", query, limit: 10, offset: 0,
      });
      assert.equal(all.length, 3);
      const page = await runtime.store.listTaxonomies({
        kind: "category", locale: "zh-CN", query, limit: 1, offset: 1,
      });
      assert.deepEqual(page.map((item) => item.slug), all.slice(1, 2).map((item) => item.slug));
      await assert.rejects(
        Promise.resolve().then(() => runtime.store.listTaxonomies({
          kind: "category", locale: "zh-CN", query, limit: 1, offset: -1,
        })),
        { code: "BAD_USER_INPUT" },
      );
    } finally { await runtime.cleanup(undefined, suffix); }
  });

  test(`${adapterName}: categories are editor-controlled while hashtags stay open`, options, async () => {
    const runtime = await fixture();
    const suffix = randomUUID();
    const editorId = `taxonomy-editor-${suffix}`;
    const memberId = `taxonomy-member-${suffix}`;
    const categorySlug = `editor-category-${suffix}`;
    try {
      // ADR 0016, decision 1. A hashtag is the author's own words: no role asked.
      const tag = await runtime.store.createTaxonomy({
        actorId: memberId, kind: "tag", slug: `open-tag-${suffix}`, name: "Open tag", locale: "zh-CN",
      });
      assert.equal(tag.kind, "tag");

      // A category is the platform speaking: the same account may not mint one
      // without the role, and a caller that never asks gets no benefit of the
      // doubt (`actorIsEditor` defaults to false).
      await assert.rejects(Promise.resolve().then(() => runtime.store.createTaxonomy({
        actorId: memberId, kind: "category", slug: `member-category-${suffix}`, name: "Member category", locale: "zh-CN",
      })), ArticleAuthorizationError);
      await assert.rejects(Promise.resolve().then(() => runtime.store.createTaxonomy({
        actorId: memberId, actorIsEditor: false, kind: "category", slug: `member-category-${suffix}`, name: "Member category", locale: "zh-CN",
      })), ArticleAuthorizationError);

      const category = await runtime.store.createTaxonomy({
        actorId: editorId, actorIsEditor: true, kind: "category", slug: categorySlug, name: "Editor category", locale: "zh-CN",
      });
      // The public taxonomy is maintained by the editors as a group: another
      // editor may add a translation to a category they did not create.
      const translated = await runtime.store.createTaxonomy({
        actorId: memberId, actorIsEditor: true, kind: "category", slug: categorySlug, name: "编辑分类", locale: "zh-TW",
      });
      assert.equal(translated.id, category.id);

      // Deleting draws the same line: a category needs the role even from the
      // account that created it, while a tag stays its creator's to retract.
      await assert.rejects(Promise.resolve().then(() => runtime.store.deleteTaxonomy({
        taxonomyId: category.id, actorId: editorId,
      })), ArticleAuthorizationError);
      await assert.rejects(Promise.resolve().then(() => runtime.store.deleteTaxonomy({
        taxonomyId: tag.id, actorId: editorId, actorIsEditor: true,
      })), ArticleAuthorizationError);
      assert.equal(await runtime.store.deleteTaxonomy({ taxonomyId: tag.id, actorId: memberId }), true);
      assert.equal(await runtime.store.deleteTaxonomy({ taxonomyId: category.id, actorId: memberId, actorIsEditor: true }), true);
    } finally {
      await runtime.cleanup(undefined, suffix);
    }
  });

  test(`${adapterName}: setting article likes is idempotent and liked lists are user-scoped`, options, async () => {
    const runtime = await fixture();
    const suffix = randomUUID();
    const slug = `contract-liked-${suffix}`;
    try {
      const article = await runtime.store.createArticle({
        authorId: `article-author-${suffix}`, slug, title: "Like contract article", summary: "",
        locale: "zh-CN", contentBlocks: [{ id: "p1", type: "paragraph", text: "Shared contract content." }], publish: true,
      });
      const first = await runtime.store.setArticleLike({ slug, locale: "zh-CN", actorId: `liker-a-${suffix}`, liked: true });
      const second = await runtime.store.setArticleLike({ slug, locale: "zh-CN", actorId: `liker-a-${suffix}`, liked: true });
      assert.equal(first.likedByViewer, true);
      assert.equal(second.likedByViewer, true);
      assert.equal(second.likeCount, 1);
      assert.ok((await runtime.store.listLikedArticles({ actorId: `liker-a-${suffix}`, locale: "zh-CN" })).some((item) => item.id === article.id));
      assert.ok(!(await runtime.store.listLikedArticles({ actorId: `liker-b-${suffix}`, locale: "zh-CN" })).some((item) => item.id === article.id));
    } finally { await runtime.cleanup(undefined, suffix); }
  });

  test(`${adapterName}: article comments notify the right recipients atomically and suppress self-notifications`, options, async () => {
    const runtime = await fixture();
    const suffix = randomUUID();
    const slug = `contract-comment-notifications-${suffix}`;
    const articleAuthor = `article-author-${suffix}`;
    const commenterA = `commenter-a-${suffix}`;
    const commenterB = `commenter-b-${suffix}`;
    try {
      await runtime.store.createArticle({
        authorId: articleAuthor, slug, title: "Comment notification contract", summary: "",
        locale: "zh-CN", contentBlocks: [{ id: "p1", type: "paragraph", text: "Shared persistence contract content." }], publish: true,
      });
      const rootInput = {
        slug, locale: "zh-CN", actorId: commenterA, content: "Root comment",
        idempotencyKey: `root-comment-once-${suffix}`,
      };
      const [root, rootRetry] = await Promise.all([
        runtime.store.createArticleComment(rootInput),
        runtime.store.createArticleComment(rootInput),
      ]);
      assert.equal(rootRetry.id, root.id, "concurrent retries must return the original comment");
      await assert.rejects(
        Promise.resolve().then(() => runtime.store.createArticleComment({ ...rootInput, content: "different comment" })),
        IdempotencyConflictError,
      );
      const rootNotifications = await runtime.store.listNotifications({ actorId: articleAuthor, limit: 100 });
      assert.equal(rootNotifications.filter((item) => item.eventKey === `article.commented:${root.id}`).length, 1);
      assert.equal((await runtime.store.listNotifications({ actorId: commenterA, limit: 100 })).length, 0);

      const reply = await runtime.store.createArticleComment({
        slug, locale: "zh-CN", actorId: commenterB, content: "Reply comment", parentCommentId: root.id,
      });
      const ownerNotifications = await runtime.store.listNotifications({ actorId: articleAuthor, limit: 100 });
      const parentNotifications = await runtime.store.listNotifications({ actorId: commenterA, limit: 100 });
      assert.equal(ownerNotifications.filter((item) => item.eventKey === `article.commented:${reply.id}`).length, 1);
      assert.equal(parentNotifications.filter((item) => item.eventKey === `article.comment_replied:${reply.id}`).length, 1);
      assert.equal((await runtime.store.listNotifications({ actorId: commenterB, limit: 100 })).length, 0);

      const selfComment = await runtime.store.createArticleComment({
        slug, locale: "zh-CN", actorId: articleAuthor, content: "Author comments on own article",
      });
      const ownerAfterSelfComment = await runtime.store.listNotifications({ actorId: articleAuthor, limit: 100 });
      assert.equal(ownerAfterSelfComment.filter((item) => item.eventKey === `article.commented:${selfComment.id}`).length, 0);

      const tree = await runtime.store.listArticleComments({ slug, locale: "zh-CN" });
      assert.equal(tree.length, 2);
      const rootNode = tree.find((node) => node.id === root.id);
      assert.ok(rootNode);
      assert.equal(rootNode.replies.length, 1);
      assert.equal(rootNode.replies[0].id, reply.id);
    } finally {
      await runtime.cleanup(undefined, suffix);
    }
  });
  /**
   * A thread has a bottom (#246).
   *
   * The write path used to accept any reply and the read path stopped at a fixed
   * level, so a deep reply was created successfully and then never came back:
   * the writer saw 201, refreshed, and found nothing. The cap is therefore
   * enforced where the comment is written, and the assertion that matters is not
   * "depth 9 is refused" but "everything that was accepted comes back".
   */
  test(`${adapterName}: a comment thread stops at the depth the reader can see`, options, async () => {
    const runtime = await fixture();
    const suffix = randomUUID();
    const slug = `contract-comment-depth-${suffix}`;
    const articleAuthor = `depth-author-${suffix}`;
    const commenter = `depth-commenter-${suffix}`;
    // The cap is a published contract, so the test reads it rather than repeating
    // a number that could drift away from the message the writer is shown.
    const deepestAllowed = MAX_COMMENT_REPLY_DEPTH;
    try {
      await runtime.store.createArticle({
        authorId: articleAuthor, slug, title: "Depth contract article", summary: "",
        locale: "zh-CN", contentBlocks: [{ id: "p1", type: "paragraph", text: "Depth contract content." }], publish: true,
      });
      const chain = [];
      let parentCommentId = null;
      for (let depth = 0; depth <= deepestAllowed; depth += 1) {
        const comment = await runtime.store.createArticleComment({
          slug, locale: "zh-CN", actorId: commenter, content: `Depth ${depth}`, parentCommentId,
        });
        chain.push(comment.id);
        parentCommentId = comment.id;
      }

      // One level deeper is refused, with a message that says what to do.
      await assert.rejects(
        Promise.resolve().then(() => runtime.store.createArticleComment({
          slug, locale: "zh-CN", actorId: commenter, content: "Too Deep", parentCommentId,
        })),
        (error) => error instanceof CommentDepthError
          && error.code === "COMMENT_DEPTH_EXCEEDED"
          && error.message === COMMENT_DEPTH_LIMIT_MESSAGE,
      );

      // Everything the store accepted is returned, one node per level, in order.
      const flattened = [];
      const walk = (nodes) => { for (const node of nodes) { flattened.push(node.id); walk(node.replies); } };
      walk(await runtime.store.listArticleComments({ slug, locale: "zh-CN" }));
      assert.deepEqual(flattened, chain, "a comment that was accepted must never be truncated away");
    } finally { await runtime.cleanup(undefined, suffix); }
  });

  /**
   * The thread's first page used to be the only page (#248 follow-up).
   *
   * `GET /articles/:slug/comments` counts `limit` in top-level comments and the
   * route had no other parameter, so on a work with more roots than that the rest
   * existed in the database and nowhere a reader could reach. The cursor is the
   * last root of the page; what has to hold is that every root appears exactly
   * once across pages, in the same oldest-first order one big page would use,
   * that replies travel with their root, and that the boundary millisecond loses
   * nothing — which is only true because comment times are stored at the
   * precision the cursor can name (migration 0031).
   */
  test(`${adapterName}: a comment thread pages by root and loses nothing at a boundary`, options, async () => {
    const runtime = await fixture();
    const suffix = randomUUID();
    const slug = `contract-comment-pages-${suffix}`;
    const otherSlug = `contract-comment-pages-other-${suffix}`;
    const authorId = `paging-author-${suffix}`;
    const commenter = `paging-commenter-${suffix}`;
    // Two roots share this millisecond; that is what the `id` half is for.
    const shared = "2026-06-01T00:00:00.123Z";
    try {
      for (const target of [slug, otherSlug]) {
        await runtime.store.createArticle({
          authorId, slug: target, title: "Paging contract article", summary: "",
          locale: "zh-CN", contentBlocks: [{ id: "p1", type: "paragraph", text: "Paging contract content." }], publish: true,
        });
      }
      const create = (target, content, parentCommentId = null) =>
        runtime.store.createArticleComment({ slug: target, locale: "zh-CN", actorId: commenter, content, parentCommentId });

      const roots = [];
      for (const [content, at] of [
        ["root-1", "2026-06-01T00:00:00.121Z"],
        ["root-2", shared],
        ["root-3", shared],
        ["root-4", "2026-06-01T00:00:00.124Z"],
        ["root-5", "2026-06-01T00:00:00.125Z"],
      ]) {
        const root = await create(slug, content);
        await runtime.setArticleCommentCreatedAt(root.id, at);
        roots.push({ id: root.id, at });
      }
      const otherRoot = await create(otherSlug, "other-work's-comment");
      await runtime.setArticleCommentCreatedAt(otherRoot.id, "2026-06-01T00:00:00.122Z");
      const reply = await create(slug, "reply-to-root-2", roots[1].id);
      await runtime.setArticleCommentCreatedAt(reply.id, "2026-06-01T00:00:00.130Z");
      const nested = await create(slug, "reply-to-reply", reply.id);
      await runtime.setArticleCommentCreatedAt(nested.id, "2026-06-01T00:00:00.131Z");

      // The order one unbounded page would return: oldest first, id breaking the
      // tie inside a millisecond.
      const expected = [...roots]
        .sort((a, b) => (a.at === b.at ? (a.id < b.id ? -1 : 1) : a.at < b.at ? -1 : 1))
        .map((root) => root.id);

      const walk = async (limit) => {
        const seen = [];
        const pages = [];
        let cursor = null;
        for (let guard = 0; guard < 20; guard += 1) {
          const page = await runtime.store.listArticleComments({
            slug, locale: "zh-CN", limit, ...(cursor === null ? {} : { cursor }),
          });
          if (page.length === 0) { pages.push(0); break; }
          pages.push(page.length);
          seen.push(...page.map((node) => node.id));
          const last = page[page.length - 1];
          cursor = { at: last.createdAt, id: last.id };
        }
        return { seen, pages };
      };

      const twoAtATime = await walk(2);
      assert.deepEqual(twoAtATime.seen, expected, "every root appears once, in thread order, across pages of two");
      assert.deepEqual(twoAtATime.pages, [2, 2, 1, 0], "a short page still reports what it holds, and the end is empty");
      // The boundary falls inside the shared millisecond, which is exactly the
      // case a millisecond-truncating read gets wrong.
      assert.ok(twoAtATime.pages.length >= 3);

      const oneAtATime = await walk(1);
      assert.deepEqual(oneAtATime.seen, expected, "page size is a client choice, not a contract change");

      // A reply is never a page of its own: it arrives with the root it answers,
      // all the way down, and the page still counts one root.
      const secondPage = await runtime.store.listArticleComments({
        slug, locale: "zh-CN", limit: 2, cursor: { at: roots[0].at, id: roots[0].id },
      });
      const rootWithReplies = secondPage.find((node) => node.replies.length > 0);
      assert.ok(rootWithReplies, "the reply's root is on the page the reply belongs to");
      assert.equal(rootWithReplies.id, roots[1].id);
      assert.equal(rootWithReplies.replies.length, 1);
      assert.equal(rootWithReplies.replies[0].id, reply.id);
      assert.deepEqual(rootWithReplies.replies[0].replies.map((node) => node.id), [nested.id]);

      // Another work's comment is not on this thread, whatever its timestamp.
      assert.ok(!twoAtATime.seen.includes(otherRoot.id), "a page belongs to one work");

      // Reading past the end is empty, not an error, and not a repeat.
      const lastRoot = expected[expected.length - 1];
      const past = await runtime.store.listArticleComments({
        slug, locale: "zh-CN", limit: 2,
        cursor: { at: roots.find((root) => root.id === lastRoot).at, id: lastRoot },
      });
      assert.deepEqual(past, []);

      // A cursor is two strings; anything else is the caller's bug, and it is
      // refused here rather than surfacing as a database error.
      for (const bad of [{ at: 1, id: lastRoot }, { at: shared, id: 2 }]) {
        await assert.rejects(
          Promise.resolve().then(() => runtime.store.listArticleComments({
            slug, locale: "zh-CN", limit: 2, cursor: bad,
          })),
          { code: "BAD_USER_INPUT" },
        );
      }
    } finally { await runtime.cleanup(undefined, suffix); }
  });

  /**
   * A work's reach is stored, not recomputed (ADR 0035).
   *
   * The counter is denormalised so that every list which shows a work reads it
   * with the row it already has, which makes one property load-bearing: the column
   * must move *only* through `incrementArticleViewCount`, and every read path must
   * see the same number. A second, derived count would drift the first time a
   * page was rendered between two increments.
   */
  test(`${adapterName}: a work's view count is work-wide, monotonic, and visible on every read`, options, async () => {
    const runtime = await fixture();
    const suffix = randomUUID();
    const slug = `contract-views-${suffix}`;
    const authorId = `views-author-${suffix}`;
    try {
      // The list path is reached through a search term the title carries, so the
      // assertion is about the same work rather than about a lucky ordering.
      const marker = `viewcontract${suffix.replace(/-/g, "")}`;
      const created = await runtime.store.createArticle({
        authorId, slug, title: `View contract ${marker}`, summary: "",
        locale: "zh-CN", contentBlocks: [{ id: "p1", type: "paragraph", text: "Counted words." }], publish: true,
      });
      const detail = () => runtime.store.getPublishedArticle({ slug, locale: "zh-CN" });
      const listed = async () => (await runtime.store.listPublishedArticles({ locale: "zh-CN", query: marker, limit: 10 }))[0];

      assert.equal((await detail()).viewCount, 0, "a new work has been read by nobody");
      assert.equal((await listed()).viewCount, 0, "the list path reads the same column as the detail path");

      assert.equal(await runtime.store.incrementArticleViewCount({ articleId: created.id }), 1);
      assert.equal(await runtime.store.incrementArticleViewCount({ articleId: created.id }), 2);
      assert.equal((await detail()).viewCount, 2, "the counter is the row, not a second table that could drift");
      assert.equal((await listed()).viewCount, 2);

      // Another work has its own number: reach is not a site-wide tally.
      const sibling = await runtime.store.createArticle({
        authorId, slug: `${slug}-sibling`, title: "Sibling", summary: "",
        locale: "zh-CN", contentBlocks: [{ id: "p1", type: "paragraph", text: "Other words." }], publish: true,
      });
      assert.equal((await runtime.store.getPublishedArticle({ slug: `${slug}-sibling`, locale: "zh-CN" })).viewCount, 0);

      // A draft is not a page anyone can open, and a missing row is a caller bug.
      await assert.rejects(
        Promise.resolve().then(() => runtime.store.incrementArticleViewCount({ articleId: "not-a-uuid" })),
        { code: "BAD_USER_INPUT" },
      );
      await assert.rejects(
        Promise.resolve().then(() => runtime.store.incrementArticleViewCount({ articleId: randomUUID() })),
        { code: "NOT_FOUND" },
      );

      // Deleting and restoring a work does not reset its history: the reach the
      // author earned is what the tombstone comes back with.
      await runtime.store.deleteArticle({ articleId: created.id, actorId: authorId });
      const restored = await runtime.store.restoreArticle({ articleId: created.id, actorId: authorId });
      assert.equal(restored.viewCount, 2, "a restored work keeps its readership");
      assert.equal((await runtime.store.getPublishedArticle({ slug: `${slug}-sibling`, locale: "zh-CN" })).id, sibling.id);
    } finally { await runtime.cleanup(undefined, suffix); }
  });

  /**
   * The media library's persistence (ADR 0022).
   *
   * The assertions that matter are the ones the application layer depends on:
   * the list is one owner's, newest first, and walks with a cursor; a delete is
   * scoped to its owner so "not yours" and "not there" are the same answer; and
   * the reference scan hands back raw JSON text on both providers, which is the
   * only reason the application layer can parse it with one code path.
   */
  /**
   * The media library's persistence (ADR 0022, hardened after the orphan scan
   * offered live cover images and avatars as deletable).
   *
   * The assertions that matter are the ones the application layer depends on:
   * the list is one owner's, newest first, and walks with a cursor; **a delete is
   * guarded by the scan inside the provider**, so a work saved between two
   * statements cannot lose its images; the scan sees **both** spellings of a
   * media address and **both** places one can live — a work's body and a
   * member's avatar — because missing either one marked a live image as an
   * orphan; and a delete is scoped to its owner so "not yours" and "not there"
   * are the same answer.
   */
  test(`${adapterName}: the media library lists one owner's assets and deletes only theirs`, options, async () => {
    const runtime = await fixture();
    const suffix = randomUUID().slice(0, 8);
    const ownerId = `media-owner-${suffix}`;
    const strangerId = `media-stranger-${suffix}`;
    const hour = new Date(Date.now() + 3_600_000).toISOString();
    /**
     * The refresh hash is unique across the whole table, not just this account,
     * so it has to carry the run's suffix. A fixed hash ("a".repeat(64)) looks
     * tidier and fails somewhere else entirely: the PostgreSQL fixture shares
     * one database across every test in this file, so the collision surfaces in
     * whichever test runs second — here that was the identity contract.
     */
    const hash = (seed) => (seed + suffix.replace(/-/g, "")).padEnd(64, seed);
    const account = (userId, seed) => ({
      userId,
      email: `media-${userId}@example.test`,
      passwordHash: "hash-before",
      session: {
        sessionId: randomUUID(), userId, accessTokenId: randomUUID(),
        refreshHash: hash(seed), expiresAt: hour,
        accessExpiresAt: new Date(Date.now() + 600_000).toISOString(),
      },
    });
    await runtime.store.createIdentityAccount(account(ownerId, "a"));
    await runtime.store.createIdentityAccount(account(strangerId, "b"));

    const asset = (index) => ({
      id: `0000000${index}-1111-4111-8111-${suffix.replace(/-/g, "0").padStart(12, "0")}`,
      ownerId,
      storageKey: `assets/${ownerId}/${index}.webp`,
      contentType: "image/webp",
      byteSize: 2048,
      width: 20,
      height: 10,
      sha256: "c".repeat(64),
    });
    const strangerAssetId = `00000009-1111-4111-8111-${suffix.replace(/-/g, "0").padStart(12, "0")}`;
    // The adapter is handed the decoded cursor: decoding is the application
    // layer's job, and the predicate below is the adapter's.
    const cursorFor = (row) => ({ at: new Date(row.createdAt).toISOString(), id: row.id });
    try {
      for (const index of [1, 2, 3]) await runtime.store.createMediaAsset(asset(index));
      await runtime.store.createMediaAsset({ ...asset(9), id: strangerAssetId, ownerId: strangerId, storageKey: `assets/${strangerId}/9.webp` });

      // `limit + 1`: the adapter reads one row past the page so the application
      // layer can tell "exactly a page" from "the end" without a second query.
      const first = await runtime.store.listMediaAssets({ ownerId, cursor: null, limit: 1 });
      assert.equal(first.length, 2, "a page of one, plus the row that proves there is another");
      assert.ok(first.every((row) => row.ownerId === ownerId), "the stranger's asset is never in this list");

      const second = await runtime.store.listMediaAssets({ ownerId, cursor: cursorFor(first[0]), limit: 1 });
      assert.equal(second.length, 2, "the second page still has one row behind it");
      assert.notEqual(second[0].id, first[0].id, "no row is repeated across pages");

      const third = await runtime.store.listMediaAssets({ ownerId, cursor: cursorFor(second[0]), limit: 1 });
      assert.equal(third.length, 1, "the last page has no row behind it");
      assert.notEqual(third[0].id, first[0].id);
      assert.notEqual(third[0].id, second[0].id);

      const fourth = await runtime.store.listMediaAssets({ ownerId, cursor: cursorFor(third[0]), limit: 1 });
      assert.deepEqual(fourth, [], "an empty page is the end of the list");

      // Deleting is scoped by owner: another account asking for this asset gets
      // the same `null` they would get for one that does not exist.
      assert.equal(await runtime.store.deleteUnusedMediaAsset({ id: first[0].id, ownerId: strangerId }), null);
      const gone = await runtime.store.deleteUnusedMediaAsset({ id: first[0].id, ownerId });
      assert.ok(gone?.deleted, "the owner's unused asset is deleted");
      assert.deepEqual(gone.usedBy, []);
      const remaining = await runtime.store.listMediaAssets({ ownerId, cursor: null, limit: 10 });
      assert.equal(remaining.some((row) => row.id === first[0].id), false);
      assert.equal(await runtime.store.deleteUnusedMediaAsset({ id: first[0].id, ownerId }), null, "already gone");
    } finally {
      for (const index of [1, 2, 3]) await runtime.store.deleteUnusedMediaAsset({ id: asset(index).id, ownerId });
      await runtime.store.deleteUnusedMediaAsset({ id: strangerAssetId, ownerId: strangerId });
    }
  });

  /**
   * The guarded delete: the scan and the delete are one operation.
   *
   * This is the whole fix for the race. Two statements in the application layer
   * leave a gap a concurrent save fits through — the scan sees nothing, a work is
   * saved with the image in it, the delete removes the row, and the work that
   * was just saved has lost its picture. Here the provider has to answer "in
   * use" and delete nothing, in that order, without the caller's help.
   */
  test(`${adapterName}: a media delete is refused, inside one operation, when a body or an avatar uses the asset`, options, async () => {
    const runtime = await fixture();
    const suffix = randomUUID().slice(0, 8);
    const ownerId = `media-guard-${suffix}`;
    const authorId = `media-guard-author-${suffix}`;
    const usedId = `0000000a-1111-4111-8111-${suffix.replace(/-/g, "0").padStart(12, "0")}`;
    const avatarId = `0000000b-1111-4111-8111-${suffix.replace(/-/g, "0").padStart(12, "0")}`;
    const freeId = `0000000c-1111-4111-8111-${suffix.replace(/-/g, "0").padStart(12, "0")}`;
    const asset = (id) => ({
      id, ownerId, storageKey: `assets/${ownerId}/${id}.webp`, contentType: "image/webp",
      byteSize: 2048, width: 20, height: 10, sha256: "d".repeat(64),
    });
    // An asset and a profile are both foreign keys to the account, so both the
    // owner and the author have to exist: an avatar is somebody's picture before
    // it is a media reference.
    const hour = new Date(Date.now() + 3_600_000).toISOString();
    const account = (userId, seed) => ({
      userId,
      email: `media-${userId}@example.test`,
      passwordHash: "hash-before",
      session: {
        sessionId: randomUUID(), userId, accessTokenId: randomUUID(),
        refreshHash: (seed + suffix.replace(/-/g, "")).padEnd(64, seed), expiresAt: hour,
        accessExpiresAt: new Date(Date.now() + 600_000).toISOString(),
      },
    });
    try {
      await runtime.store.createIdentityAccount(account(ownerId, "7"));
      await runtime.store.createIdentityAccount(account(authorId, "8"));
      for (const id of [usedId, avatarId, freeId]) await runtime.store.createMediaAsset(asset(id));

      // The two addresses a body can hold: the Web app's `/api/media/…` and the
      // API's own `/api/v1/media/…`, which is what a direct client stored.
      const created = await runtime.store.createArticle({
        authorId,
        slug: `media-guard-${suffix}`,
        title: "封面与头像",
        summary: "",
        locale: "zh-CN",
        contentBlocks: [
          { id: "block-1", type: "image", src: `/api/v1/media/${usedId}`, alt: "" },
          { id: "block-2", type: "paragraph", text: "正文里有两张图。" },
        ],
        publish: false,
      });
      // An avatar: a media URL that lives on a profile, in no body at all.
      await runtime.store.upsertAuthorProfile({ userId: authorId, locale: "zh-CN", displayName: "头像作者", bio: "", avatarUrl: `/api/v1/media/${avatarId}` });

      const scan = await runtime.store.listMediaScanRows();
      assert.ok(scan.some((row) => row.kind === "work"), "bodies are scanned");
      assert.ok(scan.some((row) => row.kind === "avatar"), "and so are avatars");

      const used = await runtime.store.deleteUnusedMediaAsset({ id: usedId, ownerId });
      assert.equal(used?.deleted, null, "a body that uses the image blocks the delete");
      assert.equal(used?.usedBy.length, 1);
      assert.equal(used?.usedBy[0]?.kind, "work");
      assert.equal(used?.usedBy[0]?.work?.articleId, created.id);
      assert.equal(typeof used?.usedBy[0]?.work?.authorId, "string", "who wrote it is part of what the scan knows");

      const avatar = await runtime.store.deleteUnusedMediaAsset({ id: avatarId, ownerId });
      assert.equal(avatar?.deleted, null, "a profile picture blocks the delete too");
      assert.ok(avatar?.usedBy.some((row) => row.kind === "avatar"));

      const free = await runtime.store.deleteUnusedMediaAsset({ id: freeId, ownerId });
      assert.ok(free?.deleted, "an asset nothing uses is deleted");
    } finally {
      await runtime.store.deleteUnusedMediaAsset({ id: usedId, ownerId });
      await runtime.store.deleteUnusedMediaAsset({ id: avatarId, ownerId });
      await runtime.store.deleteUnusedMediaAsset({ id: freeId, ownerId });
      const scan = await runtime.store.listMediaScanRows();
      for (const row of scan) {
        if (row.kind === "work" && row.work?.slug === `media-guard-${suffix}`) {
          await runtime.store.deleteArticle({ articleId: row.work.articleId, actorId: authorId });
        }
      }
    }
  });

  /**
   * #217, from the other side: a reference row can be *missing*.
   *
   * `ON DELETE RESTRICT` only refuses a delete it can see a row for. A provider
   * replay that predates reference capture, an older writer or a direct SQL fix
   * can leave the body holding the URL while the row is gone — and the guard then
   * answered "unused" and deleted an image a published work still shows. The
   * materialised table is the fast path; the body is the evidence.
   */
  test(`${adapterName}: a missing materialised reference cannot authorise a delete`, options, async () => {
    const runtime = await fixture();
    const suffix = randomUUID();
    const ownerId = `drift-owner-${suffix}`;
    const hour = new Date(Date.now() + 3_600_000).toISOString();
    try {
      await runtime.store.createIdentityAccount({
        userId: ownerId, email: `drift-${suffix}@example.test`, passwordHash: "hash",
        session: {
          sessionId: randomUUID(), userId: ownerId, accessTokenId: randomUUID(),
          refreshHash: (suffix.replace(/-/g, "") + "f").padEnd(64, "f"), expiresAt: hour,
          accessExpiresAt: new Date(Date.now() + 600_000).toISOString(),
        },
      });
      const asset = await runtime.store.createMediaAsset({
        id: randomUUID(), ownerId, storageKey: `${suffix}/drift.webp`, contentType: "image/webp",
        byteSize: 12, width: 2, height: 2, sha256: "f".repeat(64),
      });
      const article = await runtime.store.createArticle({
        authorId: ownerId, slug: `drift-${suffix}`, title: "仍然在用", summary: "",
        locale: "zh-CN", publish: true,
        contentBlocks: [{ id: "i1", type: "image", src: `/api/v1/media/${asset.id}`, alt: "" }],
      });

      // The write materialised the reference, so the fast path knows the work.
      assert.equal((await runtime.store.listReferencesForAssets({ assetIds: [asset.id] })).length, 1);

      // Now the drift: the row goes, the body stays.
      await runtime.dropMediaReference(asset.id);
      assert.deepEqual(
        await runtime.store.listReferencesForAssets({ assetIds: [asset.id] }),
        [],
        "the materialised table no longer knows about the work",
      );

      const refused = await runtime.store.deleteUnusedMediaAsset({ id: asset.id, ownerId });
      assert.equal(refused?.deleted ?? null, null, "the body is still evidence that the image is in use");
      assert.ok(
        (refused?.usedBy ?? []).some((row) => row.kind === "work" && row.work?.articleId === article.id),
        "and the caller is told which work holds it",
      );
      const evidence = [...new Set((refused?.usedBy ?? []).map((row) => row.content))];
      assert.equal(evidence.length, 1, "one work holds the asset");
      assert.match(
        String(evidence[0]),
        new RegExp(`/media/${asset.id}\"`),
        "the evidence is the work's own body, and it really does name this asset as a URL",
      );
      assert.ok(await runtime.store.getMediaAsset({ id: asset.id }), "the asset row survives");

      // A tombstone keeps its translation, so the evidence has to go with a purge.
      await runtime.store.deleteArticle({ articleId: article.id, actorId: ownerId });
      await runtime.store.purgeExpiredArticles({
        retentionDays: 30, now: new Date(Date.now() + 400 * 86_400_000), limit: 100,
      });
      const allowed = await runtime.store.deleteUnusedMediaAsset({ id: asset.id, ownerId });
      assert.equal(allowed?.deleted?.id, asset.id, "once nothing mentions it, the delete goes through");
    } finally { await runtime.cleanup(undefined, suffix); }
  });

  /**
   * #243: mentioning an id is not referencing an asset.
   *
   * The delete-time backstop asked SQL whether the id appears anywhere in the
   * body and then handed the caller a fabricated `content` — `/media/<id>` — so
   * its own extraction step agreed with the answer it had already decided. A
   * technical article quoting a UUID in prose therefore pinned the image forever,
   * while the library page, which extracts from the real body, showed it as
   * orphaned. The badge and the refusal have to be the same rule.
   */
  test(`${adapterName}: a body that only mentions an asset id does not block the delete`, options, async () => {
    const runtime = await fixture();
    const suffix = randomUUID();
    const ownerId = `mention-owner-${suffix}`;
    const hour = new Date(Date.now() + 3_600_000).toISOString();
    try {
      await runtime.store.createIdentityAccount({
        userId: ownerId, email: `mention-${suffix}@example.test`, passwordHash: "hash",
        session: {
          sessionId: randomUUID(), userId: ownerId, accessTokenId: randomUUID(),
          refreshHash: (suffix.replace(/-/g, "") + "b").padEnd(64, "b"), expiresAt: hour,
          accessExpiresAt: new Date(Date.now() + 600_000).toISOString(),
        },
      });
      const asset = await runtime.store.createMediaAsset({
        id: randomUUID(), ownerId, storageKey: `${suffix}/mention.webp`, contentType: "image/webp",
        byteSize: 12, width: 2, height: 2, sha256: "b".repeat(64),
      });
      // A published article that quotes the UUID as text: no image block, no
      // reference row, no reference. This is the shape the issue reproduced with.
      await runtime.store.createArticle({
        authorId: ownerId, slug: `mention-${suffix}`, title: "调试日志", summary: "",
        locale: "zh-CN", publish: true,
        contentBlocks: [{ id: "p1", type: "paragraph", text: `调试记录 ID: ${asset.id}` }],
      });

      // The library's own answer, from the real body: unreferenced.
      const scan = await runtime.store.listMediaScanRows();
      const mentions = scan.filter((row) => row.kind === "work" && String(row.content).includes(asset.id));
      assert.equal(mentions.length, 1, "the prose really is in the scan's input");

      const allowed = await runtime.store.deleteUnusedMediaAsset({ id: asset.id, ownerId });
      assert.equal(allowed?.deleted?.id, asset.id, "a quoted id is not a reference");
      assert.deepEqual(allowed?.usedBy, []);
      assert.equal(await runtime.store.getMediaAsset({ id: asset.id }), null);
    } finally { await runtime.cleanup(undefined, suffix); }
  });

  /**
   * The avatar half of the same drift: a picture stored only as a URL on the
   * profile, with no `avatar_media_id` to make the foreign key refuse.
   */
  test(`${adapterName}: an avatar URL with no materialised avatar id still blocks the delete`, options, async () => {
    const runtime = await fixture();
    const suffix = randomUUID();
    const ownerId = `drift-avatar-owner-${suffix}`;
    const hour = new Date(Date.now() + 3_600_000).toISOString();
    try {
      await runtime.store.createIdentityAccount({
        userId: ownerId, email: `drift-avatar-${suffix}@example.test`, passwordHash: "hash",
        session: {
          sessionId: randomUUID(), userId: ownerId, accessTokenId: randomUUID(),
          refreshHash: (suffix.replace(/-/g, "") + "a").padEnd(64, "a"), expiresAt: hour,
          accessExpiresAt: new Date(Date.now() + 600_000).toISOString(),
        },
      });
      const asset = await runtime.store.createMediaAsset({
        id: randomUUID(), ownerId, storageKey: `${suffix}/face.webp`, contentType: "image/webp",
        byteSize: 12, width: 2, height: 2, sha256: "a".repeat(64),
      });
      await runtime.store.upsertAuthorProfile({
        userId: ownerId, locale: "zh-CN", displayName: "有头像的人", bio: "",
        avatarUrl: `/api/v1/media/${asset.id}`,
      });
      await runtime.clearAvatarMediaId(ownerId);

      const refused = await runtime.store.deleteUnusedMediaAsset({ id: asset.id, ownerId });
      assert.equal(refused?.deleted ?? null, null, "the stored URL is evidence even without the id column");
      assert.ok((refused?.usedBy ?? []).some((row) => row.kind === "avatar"));
      assert.ok(await runtime.store.getMediaAsset({ id: asset.id }));
    } finally { await runtime.cleanup(undefined, suffix); }
  });

  test(`${adapterName}: the media reference scan returns raw JSON text for every draft and tombstone`, options, async () => {
    const runtime = await fixture();
    const suffix = randomUUID();
    const authorId = `media-scan-author-${suffix}`;
    const mediaId = "abcdef01-2345-4678-89ab-cdef01234567";
    const blocks = [{ id: "block-1", type: "image", src: `/api/media/${mediaId}`, alt: "" }];
    const created = await runtime.store.createArticle({
      authorId, slug: `media-scan-${suffix}`, title: "用了这张图", summary: "", locale: "zh-CN", contentBlocks: blocks, publish: false,
    });
    try {
      const rows = await runtime.store.listMediaScanRows();
      const found = rows.filter((row) => row.kind === "work" && String(row.content).includes(mediaId));
      assert.equal(found.length, 1, "the draft that uses the image is in the scan");
      assert.equal(typeof found[0].content, "string", "both providers hand the application layer JSON text");
      assert.equal(found[0].kind, "work");
      assert.equal(found[0].work?.status, "draft");
      assert.equal(found[0].work?.deletedAt, null);
      assert.equal(found[0].work?.locale, "zh-CN");
      assert.equal(found[0].work?.authorId, authorId);
    } finally {
      await runtime.store.deleteArticle({ articleId: created.id, actorId: authorId });
    }
  });
}

registerForEngines(registerWorkContracts);
