import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import test from "node:test";

import { ConversationAccessError } from "../domain/errors.ts";

import { createMessageNotificationDelivery } from "./message-notification-delivery.ts";
import { integrationOptions, sql, store, registerPostgresIntegration } from "./test-support/postgres-integration-fixtures.ts";

registerPostgresIntegration();

test("public article search supports bounded pagination and validates offsets", integrationOptions, async () => {
  const ownerId = `it-pagination-owner-${randomUUID()}`;
  const suffix = randomUUID().replaceAll("-", "");
  const searchTerm = `pagequery${suffix}`;
  const contentBlocks = [{ id: "body", type: "paragraph", text: "Pagination fixture." }];
  const articles = [];
  try {
    for (let index = 0; index < 3; index += 1) {
      articles.push(await store.createArticle({
        authorId: ownerId,
        slug: `it-page-${suffix}-${index}`,
        title: `${searchTerm} poetry ${index}`,
        summary: "pagination integration fixture",
        locale: "en",
        contentBlocks,
        publish: true,
        workType: "poetry",
      }));
    }

    const allMatches = await store.listPublishedArticles({ locale: "en", query: searchTerm, limit: 10, offset: 0 });
    const expectedIds = allMatches.filter((item) => articles.some((article) => article.id === item.id)).map((item) => item.id);
    const firstPage = await store.listPublishedArticles({ locale: "en", query: searchTerm, limit: 2, offset: 0 });
    const secondPage = await store.listPublishedArticles({ locale: "en", query: searchTerm, limit: 2, offset: 2 });
    assert.equal(expectedIds.length, 3);
    assert.deepEqual(firstPage.map((item) => item.id), expectedIds.slice(0, 2));
    assert.deepEqual(secondPage.map((item) => item.id), expectedIds.slice(2));
    assert.equal((await store.listPublishedArticles({ locale: "zh-TW", query: searchTerm, limit: 10 }))
      .some((item) => articles.some((article) => article.id === item.id)), false);

    await assert.rejects(store.listPublishedArticles({ locale: "en", offset: -1 }), { code: "BAD_USER_INPUT" });
    await assert.rejects(store.listPublishedArticles({ locale: "en", offset: 1.5 }), { code: "BAD_USER_INPUT" });
    await assert.rejects(store.listPublishedArticles({ locale: "en", offset: 100001 }), { code: "BAD_USER_INPUT" });
  } finally {
    for (const article of articles) {
      await sql.unsafe("DELETE FROM articles WHERE id = $1", [article.id]);
    }
  }
});

test("hashtag creation is user-generated, Unicode-aware, reusable, and idempotent", integrationOptions, async () => {
  const creatorId = `it-tag-creator-${randomUUID()}`;
  const otherId = `it-tag-other-${randomUUID()}`;
  const articleSlug = `it-tag-article-${randomUUID().replaceAll("-", "")}`;
  const blocks = [{ id: "intro", type: "paragraph", text: "Hashtag body." }];
  let tag;
  let article;
  try {
    tag = await store.createTag({ actorId: creatorId, name: "#人工智慧", locale: "zh-TW" });
    const duplicate = await store.createTag({ actorId: otherId, name: "人工智慧", locale: "zh-TW" });
    assert.equal(tag.id, duplicate.id);
    assert.equal(duplicate.createdBy, creatorId);
    assert.equal(duplicate.name, "人工智慧");
    const englishLabel = await store.createTag({ actorId: otherId, name: "#AI", locale: "en" });
    const sameEnglishTag = await store.createTag({ actorId: creatorId, name: "ai", locale: "en" });
    assert.equal(englishLabel.id, sameEnglishTag.id);
    assert.equal(sameEnglishTag.name.toLowerCase(), "ai");
    await assert.rejects(
      store.createTag({ actorId: creatorId, name: "人工 智慧", locale: "zh-TW" }),
      { code: "BAD_USER_INPUT" },
    );
    await assert.rejects(
      store.createTag({ actorId: creatorId, name: "bad#tag", locale: "en" }),
      { code: "BAD_USER_INPUT" },
    );
    article = await store.createArticle({
      authorId: otherId, slug: articleSlug, title: "Article with community tag",
      locale: "zh-TW", contentBlocks: blocks, publish: true, tagIds: [tag.id],
    });
    const attached = await store.listArticleTaxonomies({ articleId: article.id, kind: "tag", locale: "zh-TW" });
    assert.equal(attached.length, 1);
    assert.equal(attached[0].id, tag.id);
    assert.equal((await store.listTaxonomies({ kind: "tag", locale: "zh-TW", query: "人工智慧" }))
      .some((item) => item.id === tag.id && item.articleCount === 1), true);
    const tagBySlug = await store.getTaxonomyBySlug({ kind: "tag", slug: tag.slug, locale: "zh-TW" });
    assert.equal(tagBySlug.id, tag.id);
    assert.equal(tagBySlug.name, "人工智慧");
    assert.equal(tagBySlug.articleCount, 1);
    assert.equal(await store.getTaxonomyBySlug({ kind: "tag", slug: "missing-tag", locale: "zh-TW" }), null);
    await assert.rejects(
      store.deleteTaxonomy({ taxonomyId: tag.id, actorId: otherId }),
      { code: "FORBIDDEN" },
    );
  } finally {
    if (article) await sql.unsafe("DELETE FROM articles WHERE id = $1", [article.id]);
    if (tag) await sql.unsafe("DELETE FROM taxonomies WHERE id = $1", [tag.id]);
    await sql.unsafe("DELETE FROM taxonomies WHERE created_by = $1", [creatorId]);
    await sql.unsafe("DELETE FROM taxonomies WHERE created_by = $1", [otherId]);
  }
});

test("taxonomy registry supports localized labels, article associations and creator-scoped deletion", integrationOptions, async () => {
  const creatorId = `it-taxonomy-creator-${randomUUID()}`;
  const outsiderId = `it-taxonomy-outsider-${randomUUID()}`;
  const slug = `it-taxonomy-${randomUUID().replaceAll("-", "")}`;
  const articleSlug = `it-tax-article-${randomUUID().replaceAll("-", "")}`;
  const blocks = [{ id: "intro", type: "paragraph", text: "Taxonomy article body." }];
  let category;
  let tag;
  let article;
  try {
    category = await store.createTaxonomy({
      actorId: creatorId, actorIsEditor: true, kind: "category", slug, name: "工程", description: "繁體中文分類", locale: "zh-TW",
    });
    const englishCategory = await store.createTaxonomy({
      actorId: creatorId, actorIsEditor: true, kind: "category", slug, name: "Engineering", description: "English category", locale: "en",
    });
    tag = await store.createTaxonomy({
      actorId: creatorId, kind: "tag", slug, name: "Web", locale: "en",
    });
    assert.equal(category.id, englishCategory.id);
    assert.equal(englishCategory.name, "Engineering");
    assert.equal((await store.listTaxonomies({ kind: "category", locale: "zh-TW" })).some((item) => item.id === category.id && item.name === "工程"), true);
    // A category is maintained by the editors as a group, so another editor may
    // add a translation to one they did not create; what keeps an outsider out
    // of a category is the role, not the creator stamp.
    await assert.rejects(
      store.createTaxonomy({ actorId: outsiderId, kind: "category", slug, name: "Hijack", locale: "en" }),
      { code: "FORBIDDEN" },
    );
    // A tag is the author's own words: there the creator stamp is what counts,
    // and being an editor does not let you rewrite somebody else's.
    await assert.rejects(
      store.createTaxonomy({ actorId: outsiderId, actorIsEditor: true, kind: "tag", slug, name: "Hijack", locale: "en" }),
      { code: "FORBIDDEN" },
    );
    article = await store.createArticle({
      authorId: creatorId, slug: articleSlug, title: "Tagged article", locale: "en",
      contentBlocks: blocks, publish: true, categoryIds: [category.id], tagIds: [tag.id],
    });
    const categories = await store.listArticleTaxonomies({ articleId: article.id, kind: "category", locale: "en" });
    const tags = await store.listArticleTaxonomies({ articleId: article.id, kind: "tag", locale: "en" });
    assert.equal(categories[0].name, "Engineering");
    assert.equal(tags[0].name, "Web");
    assert.equal((await store.listTaxonomyArticles({ kind: "category", slug, locale: "en" }))[0].id, article.id);
    const updated = await store.updateArticle({
      articleId: article.id, actorId: creatorId, slug: articleSlug, title: "Tagged article",
      locale: "en", contentBlocks: blocks, publish: true, tagIds: [],
    });
    assert.equal(updated.id, article.id);
    assert.equal((await store.listArticleTaxonomies({ articleId: article.id, kind: "category", locale: "en" })).length, 1);
    assert.equal((await store.listArticleTaxonomies({ articleId: article.id, kind: "tag", locale: "en" })).length, 0);
    await assert.rejects(
      store.deleteTaxonomy({ taxonomyId: category.id, actorId: outsiderId }),
      { code: "FORBIDDEN" },
    );
    assert.equal(await store.deleteTaxonomy({ taxonomyId: tag.id, actorId: creatorId }), true);
    tag = null;
  } finally {
    if (article) await sql.unsafe("DELETE FROM articles WHERE id = $1", [article.id]);
    if (category) await sql.unsafe("DELETE FROM taxonomies WHERE id = $1", [category.id]);
    if (tag) await sql.unsafe("DELETE FROM taxonomies WHERE id = $1", [tag.id]);
  }
});

test("liked article list is private and related articles rank shared taxonomy in the requested locale", integrationOptions, async () => {
  const ownerId = `it-discovery-owner-${randomUUID()}`;
  const likerId = `it-discovery-liker-${randomUUID()}`;
  const otherUser = `it-discovery-other-${randomUUID()}`;
  const slugBase = `it-discovery-${randomUUID().replaceAll("-", "")}`;
  const blocks = [{ id: "body", type: "paragraph", text: "Discovery body." }];
  let category;
  const articles = [];
  try {
    category = await store.createTaxonomy({
      actorId: ownerId, actorIsEditor: true, kind: "category", slug: `${slugBase}-category`, name: "Discovery", locale: "en",
    });
    const target = await store.createArticle({
      authorId: ownerId, slug: `${slugBase}-target`, title: "Target article", locale: "en",
      contentBlocks: blocks, publish: true, categoryIds: [category.id],
    });
    articles.push(target);
    const related = await store.createArticle({
      authorId: otherUser, slug: `${slugBase}-related`, title: "Related article", locale: "en",
      contentBlocks: blocks, publish: true, categoryIds: [category.id],
    });
    articles.push(related);
    const sameAuthor = await store.createArticle({
      authorId: ownerId, slug: `${slugBase}-same-author`, title: "Same author article", locale: "en",
      contentBlocks: blocks, publish: true,
    });
    articles.push(sameAuthor);
    const unrelatedLocale = await store.createArticle({
      authorId: ownerId, slug: `${slugBase}-zh-only`, title: "只有中文版本", locale: "zh-TW",
      contentBlocks: blocks, publish: true,
    });
    articles.push(unrelatedLocale);
    const draft = await store.createArticle({
      authorId: ownerId, slug: `${slugBase}-draft`, title: "Draft", locale: "en",
      contentBlocks: blocks, publish: false, categoryIds: [category.id],
    });
    articles.push(draft);

    assert.deepEqual(await store.listLikedArticles({ actorId: likerId, locale: "en" }), []);
    await store.toggleArticleLike({ slug: target.slug, locale: "en", actorId: likerId });
    await store.toggleArticleLike({ slug: related.slug, locale: "en", actorId: likerId });
    const liked = await store.listLikedArticles({ actorId: likerId, locale: "en" });
    assert.deepEqual(liked.map((article) => article.slug), [related.slug, target.slug]);
    assert.equal((await store.listLikedArticles({ actorId: otherUser, locale: "en" })).length, 0);

    const suggestions = await store.listRelatedArticles({ slug: target.slug, locale: "en" });
    assert.equal(suggestions[0].slug, related.slug);
    assert.ok(!suggestions.some((article) => article.slug === target.slug));
    assert.ok(!suggestions.some((article) => article.slug === draft.slug));
    assert.ok(!suggestions.some((article) => article.locale === "zh-TW"));
    assert.deepEqual(await store.listRelatedArticles({ slug: target.slug, locale: "zh-TW" }), []);
  } finally {
    if (articles.length) {
      for (const article of articles) await sql.unsafe("DELETE FROM articles WHERE id = $1", [article.id]);
    }
    if (category) await sql.unsafe("DELETE FROM taxonomies WHERE id = $1", [category.id]);
  }
});

test("article likes are idempotent per user and only target published localized content", integrationOptions, async () => {
  const ownerId = `it-like-owner-${randomUUID()}`;
  const likerId = `it-liker-${randomUUID()}`;
  const otherId = `it-other-liker-${randomUUID()}`;
  const slug = `it-like-${randomUUID().replaceAll("-", "")}`;
  const blocks = [{ id: "intro", type: "paragraph", text: "Likeable body." }];
  let draft;
  let published;
  try {
    draft = await store.createArticle({
      authorId: ownerId, slug: slug + "-draft", title: "Draft", locale: "en", contentBlocks: blocks, publish: false,
    });
    assert.equal(await store.getArticleLikeInfo({ slug: slug + "-draft", locale: "en" }), null);
    await assert.rejects(
      store.toggleArticleLike({ slug: slug + "-draft", locale: "en", actorId: likerId }),
      { code: "NOT_FOUND" },
    );
    published = await store.createArticle({
      authorId: ownerId, slug, title: "Published", locale: "en", contentBlocks: blocks, publish: true,
    });
    assert.deepEqual(await store.getArticleLikeInfo({ slug, locale: "en" }), {
      articleId: published.id, slug, likeCount: 0, likedByViewer: false,
    });
    assert.deepEqual(await store.toggleArticleLike({ slug, locale: "en", actorId: likerId }), {
      articleId: published.id, slug, likeCount: 1, likedByViewer: true,
    });
    assert.deepEqual(await store.toggleArticleLike({ slug, locale: "en", actorId: likerId }), {
      articleId: published.id, slug, likeCount: 0, likedByViewer: false,
    });
    await store.toggleArticleLike({ slug, locale: "en", actorId: likerId });
    assert.equal((await store.getArticleLikeInfo({ slug, locale: "en", actorId: otherId })).likedByViewer, false);
    assert.equal((await store.getArticleLikeInfo({ slug, locale: "en", actorId: likerId })).likeCount, 1);
    assert.equal((await store.getArticleLikeInfo({ slug, locale: "zh-TW", actorId: likerId })), null);
    assert.deepEqual(await store.setArticleLike({ slug, locale: "en", actorId: otherId, liked: true }), {
      articleId: published.id, slug, likeCount: 2, likedByViewer: true,
    });
    assert.deepEqual(await store.setArticleLike({ slug, locale: "en", actorId: otherId, liked: true }), {
      articleId: published.id, slug, likeCount: 2, likedByViewer: true,
    });
    assert.deepEqual(await store.setArticleLike({ slug, locale: "en", actorId: otherId, liked: false }), {
      articleId: published.id, slug, likeCount: 1, likedByViewer: false,
    });
    assert.deepEqual(await store.setArticleLike({ slug, locale: "en", actorId: otherId, liked: false }), {
      articleId: published.id, slug, likeCount: 1, likedByViewer: false,
    });
    const likeNotices = await sql.unsafe(
      "SELECT id, payload FROM notifications WHERE user_id = $1 AND payload->>'articleId' = $2 AND payload->>'type' = 'article.liked'",
      [ownerId, published.id],
    );
    assert.equal(likeNotices.length, 2, "undoing and repeating a like cannot create a third notification");
    assert.deepEqual(new Set(likeNotices.map(row => row.payload.actorId)), new Set([likerId, otherId]));
  } finally {
    if (draft) await sql.unsafe("DELETE FROM articles WHERE id = $1", [draft.id]);
    if (published) {
      await sql.unsafe("DELETE FROM notifications WHERE payload->>'articleId' = $1", [published.id]);
      await sql.unsafe("DELETE FROM articles WHERE id = $1", [published.id]);
    }
  }
});

test("article comments are threaded, locale-scoped and deletions enforce ownership", integrationOptions, async () => {
  const ownerId = `it-comment-owner-${randomUUID()}`;
  const commenterId = `it-commenter-${randomUUID()}`;
  const outsiderId = `it-comment-outsider-${randomUUID()}`;
  const slug = `it-comment-${randomUUID().replaceAll("-", "")}`;
  const blocks = [{ id: "intro", type: "paragraph", text: "Commentable body." }];
  let article;
  try {
    article = await store.createArticle({
      authorId: ownerId, slug, title: "Commentable", locale: "zh-TW", contentBlocks: blocks, publish: true,
    });
    assert.deepEqual(await store.listArticleComments({ slug, locale: "zh-TW" }), []);
    const root = await store.createArticleComment({
      slug, locale: "zh-TW", actorId: commenterId, content: "第一則留言",
    });
    assert.equal(root.authorId, commenterId);
    const reply = await store.createArticleComment({
      slug, locale: "zh-TW", actorId: ownerId, content: "回覆留言", parentCommentId: root.id,
    });
    assert.equal(reply.parentCommentId, root.id);
    const tree = await store.listArticleComments({ slug, locale: "zh-TW" });
    assert.equal(tree.length, 1);
    assert.equal(tree[0].id, root.id);
    assert.equal(tree[0].replies.length, 1);
    assert.equal(tree[0].replies[0].id, reply.id);
    const rootNotice = await sql.unsafe(
      "SELECT payload FROM notifications WHERE user_id = $1 AND payload->>'type' = 'article.commented' AND payload->>'articleId' = $2",
      [ownerId, article.id],
    );
    const replyNotice = await sql.unsafe(
      "SELECT payload FROM notifications WHERE user_id = $1 AND payload->>'type' = 'article.comment_replied' AND payload->>'articleId' = $2",
      [commenterId, article.id],
    );
    assert.equal(rootNotice.length, 1);
    assert.equal(replyNotice.length, 1);
    assert.equal(rootNotice[0].payload.locale, "zh-TW");
    assert.equal(replyNotice[0].payload.locale, "zh-TW");
    await assert.rejects(
      store.createArticleComment({ slug, locale: "en", actorId: commenterId, content: "Should not work" }),
      { code: "NOT_FOUND" },
    );
    await assert.rejects(
      store.deleteArticleComment({ commentId: root.id, actorId: outsiderId }),
      { code: "FORBIDDEN" },
    );
    await assert.rejects(
      store.createArticleComment({ slug, locale: "zh-TW", actorId: commenterId, content: "  " }),
      { code: "BAD_USER_INPUT" },
    );
    assert.equal(await store.deleteArticleComment({ commentId: root.id, actorId: commenterId }), true);
    assert.deepEqual(await store.listArticleComments({ slug, locale: "zh-TW" }), []);
    const remaining = await sql.unsafe("SELECT id FROM article_comments WHERE parent_comment_id = $1", [root.id]);
    assert.equal(remaining.length, 0);
  } finally {
    if (article) await sql.unsafe("DELETE FROM articles WHERE id = $1", [article.id]);
  }
});

test("PostgreSQL comment v1 persists validated rich blocks and retains plain-text fallback", integrationOptions, async () => {
  const ownerId = `it-comment-rich-owner-${randomUUID()}`;
  const commenterId = `it-comment-rich-user-${randomUUID()}`;
  const slug = `it-comment-rich-${randomUUID().replaceAll("-", "")}`;
  let article;
  try {
    article = await store.createArticle({
      authorId: ownerId, slug, title: "Rich comment contract", locale: "zh-CN",
      contentBlocks: [{ id: "p1", type: "paragraph", text: "Comment body." }], publish: true,
    });
    const contentBlocks = [{
      id: "comment-p1", type: "paragraph", text: "重点 链接",
      inlines: [{ text: "重点", marks: ["bold"] }, { text: " " }, { text: "链接", href: "https://example.test/comment" }],
    }];
    const comment = await store.createArticleComment({
      slug, locale: "zh-CN", actorId: commenterId, content: "重点 链接",
      contentBlocks, contentBlocksVersion: 1,
    });
    assert.equal(comment.content, "重点 链接");
    assert.equal(comment.contentBlocksVersion, 1);
    assert.deepEqual(comment.contentBlocks, contentBlocks);
    const listed = await store.listArticleComments({ slug, locale: "zh-CN" });
    assert.equal(listed.length, 1);
    assert.equal(listed[0].contentBlocksVersion, 1);
    assert.deepEqual(listed[0].contentBlocks, contentBlocks);
    const rows = await sql.unsafe("SELECT content, content_blocks, content_blocks_version FROM article_comments WHERE id = $1", [comment.id]);
    assert.equal(rows[0].content, "重点 链接");
    assert.equal(Number(rows[0].content_blocks_version), 1);
    assert.deepEqual(rows[0].content_blocks, contentBlocks);
    await assert.rejects(
      store.createArticleComment({ slug, locale: "zh-CN", actorId: commenterId, content: "mismatch", contentBlocks, contentBlocksVersion: 1 }),
      { code: "BAD_USER_INPUT" },
    );
  } finally {
    if (article) {
      await sql.unsafe("DELETE FROM notifications WHERE payload->>'articleId' = $1", [article.id]);
      await sql.unsafe("DELETE FROM articles WHERE id = $1", [article.id]);
    }
  }
});

test("conversation lifecycle controls participants and unread state without deleting removed users' history", integrationOptions, async () => {
  const ownerId = `it-convo-owner-${randomUUID()}`;
  const recipientId = `it-convo-recipient-${randomUUID()}`;
  const addId = `it-convo-added-${randomUUID()}`;
  const outsiderId = `it-convo-outsider-${randomUUID()}`;
  let conversation;
  try {
    conversation = await store.createConversation({ actorId: ownerId, participantIds: [recipientId] });
    assert.equal(conversation.createdBy, ownerId);
    assert.deepEqual(conversation.participantIds.sort(), [ownerId, recipientId].sort());
    const directConversation = await store.getConversation({ conversationId: conversation.id, actorId: ownerId });
    assert.ok(directConversation);
    assert.equal(directConversation.id, conversation.id);
    assert.deepEqual(directConversation.participantIds, conversation.participantIds);
    assert.equal(await store.getConversation({ conversationId: conversation.id, actorId: outsiderId }), null);
    assert.equal((await store.listConversations({ actorId: ownerId }))[0].unreadCount, 0);
    await assert.rejects(
      store.createConversation({ actorId: ownerId, participantIds: [recipientId, recipientId] }),
      { code: "BAD_USER_INPUT" },
    );
    await assert.rejects(
      store.createConversation({ actorId: ownerId, participantIds: [] }),
      { code: "BAD_USER_INPUT" },
    );

    const firstMessage = await store.persistMessage({
      conversationId: conversation.id, senderId: ownerId, body: "first", idempotencyKey: `it-convo-first-${randomUUID()}`,
    });
    assert.equal((await store.listConversations({ actorId: recipientId }))[0].unreadCount, 1);
    await store.markConversationAsRead({ conversationId: conversation.id, actorId: recipientId });
    assert.equal((await store.listConversations({ actorId: recipientId }))[0].unreadCount, 0);
    await assert.rejects(
      store.markConversationAsRead({ conversationId: conversation.id, actorId: outsiderId }),
      { code: "FORBIDDEN" },
    );

    const updatedParticipants = await store.updateConversationParticipants({
      conversationId: conversation.id, actorId: ownerId,
      addUserIds: [addId], removeUserIds: [recipientId],
    });
    assert.deepEqual(updatedParticipants, [ownerId, addId].sort());
    assert.equal((await store.listConversations({ actorId: recipientId })).length, 0);
    assert.equal(await store.getConversation({ conversationId: conversation.id, actorId: recipientId }), null);
    assert.equal((await store.getConversation({ conversationId: conversation.id, actorId: addId })).lastMessage.id, firstMessage.id);
    assert.equal((await store.listConversations({ actorId: addId }))[0].lastMessage.id, firstMessage.id);
    await assert.rejects(
      store.listConversationMessages({ conversationId: conversation.id, actorId: recipientId }),
      { code: "FORBIDDEN" },
    );
    await assert.rejects(
      store.updateConversationParticipants({
        conversationId: conversation.id, actorId: outsiderId,
        addUserIds: [], removeUserIds: [],
      }),
      { code: "FORBIDDEN" },
    );
    await assert.rejects(
      store.deleteConversation({ conversationId: conversation.id, actorId: outsiderId }),
      { code: "FORBIDDEN" },
    );

    const secondMessage = await store.persistMessage({
      conversationId: conversation.id, senderId: ownerId, body: "second", idempotencyKey: `it-convo-second-${randomUUID()}`,
    });
    assert.equal((await store.listConversations({ actorId: addId }))[0].unreadCount, 1);
    assert.equal(await store.deleteConversation({ conversationId: conversation.id, actorId: ownerId }), true);
    assert.equal((await store.listConversations({ actorId: addId })).length, 0);
    const remainingMessages = await sql.unsafe("SELECT id FROM messages WHERE conversation_id = $1", [conversation.id]);
    assert.equal(remainingMessages.length, 0);
    const orphanedEvents = await sql.unsafe("SELECT id FROM outbox_events WHERE aggregate_id IN ($1, $2)", [firstMessage.id, secondMessage.id]);
    assert.equal(orphanedEvents.length, 0);
    conversation = null;
  } finally {
    if (conversation) {
      await sql.unsafe("DELETE FROM outbox_events WHERE aggregate_id IN (SELECT id::text FROM messages WHERE conversation_id = $1)", [conversation.id]);
      await sql.unsafe("DELETE FROM conversations WHERE id = $1", [conversation.id]);
    }
  }
});

test("message outbox consumer creates deduplicated inbox notifications for other conversation participants", integrationOptions, async () => {
  const { createMessageNotificationDelivery } = await import("./message-notification-delivery.ts");
  const suffix = randomUUID();
  const conversationId = `it-notification-delivery-${suffix}`;
  const senderId = `it-notification-sender-${suffix}`;
  const recipientId = `it-notification-recipient-${suffix}`;
  await sql.unsafe("INSERT INTO conversations (id) VALUES ($1)", [conversationId]);
  await sql.unsafe(
    "INSERT INTO conversation_participants (conversation_id, user_id) VALUES ($1, $2), ($1, $3)",
    [conversationId, senderId, recipientId],
  );
  try {
    const message = await store.persistMessage({
      conversationId, senderId, body: "notify recipient", idempotencyKey: `it-notify-${suffix}`,
    });
    const events = await sql.unsafe("SELECT id, event_key, event_type, aggregate_id, payload FROM outbox_events WHERE event_key = $1", [`message:${message.id}`]);
    const deliver = createMessageNotificationDelivery({ store });
    await deliver(events[0]);
    await deliver(events[0]);
    const recipientRows = await sql.unsafe("SELECT event_key, payload FROM notifications WHERE user_id = $1 AND event_key = $2", [recipientId, events[0].event_key]);
    const senderRows = await sql.unsafe("SELECT id FROM notifications WHERE user_id = $1 AND event_key = $2", [senderId, events[0].event_key]);
    assert.equal(recipientRows.length, 1);
    const notificationPayload = typeof recipientRows[0].payload === "string"
      ? JSON.parse(recipientRows[0].payload)
      : recipientRows[0].payload;
    assert.equal(notificationPayload.messageId, message.id);
    assert.equal(notificationPayload.conversationId, conversationId);
    assert.equal(senderRows.length, 0);
  } finally {
    await sql.unsafe("DELETE FROM notifications WHERE user_id IN ($1, $2)", [senderId, recipientId]);
    await sql.unsafe("DELETE FROM outbox_events WHERE aggregate_id IN (SELECT id::text FROM messages WHERE conversation_id = $1)", [conversationId]);
    await sql.unsafe("DELETE FROM conversations WHERE id = $1", [conversationId]);
  }
});

test("message delivery serializes with conversation deletion and cannot recreate orphaned notifications", integrationOptions, async () => {
  const suffix = randomUUID();
  const owner = `it-delete-owner-${suffix}`;
  const recipient = `it-delete-recipient-${suffix}`;
  const conversation = await store.createConversation({ actorId: owner, participantIds: [recipient] });
  let releaseDeletion;
  const holdDeletion = new Promise((resolve) => { releaseDeletion = resolve; });
  let signalLocked;
  const locked = new Promise((resolve) => { signalLocked = resolve; });
  let deletion;
  try {
    const message = await store.persistMessage({
      conversationId: conversation.id, senderId: owner, body: "in flight", idempotencyKey: `it-delete-${suffix}`,
    });
    const [event] = await store.claimOutboxEvents({ limit: 1 });
    assert.equal(event.aggregate_id, message.id);
    // Keep the transaction uncommitted after it has deleted the conversation.
    // A non-locking reader sees the previous participants and could insert an
    // orphaned notification after the delete has already swept the inbox.
    deletion = sql.begin(async (tx) => {
      await tx.unsafe("SELECT id FROM conversations WHERE id = $1 FOR UPDATE", [conversation.id]);
      await tx.unsafe("DELETE FROM outbox_events WHERE aggregate_id = $1", [message.id]);
      await tx.unsafe("DELETE FROM notifications WHERE payload->>'conversationId' = $1", [conversation.id]);
      await tx.unsafe("DELETE FROM conversations WHERE id = $1", [conversation.id]);
      signalLocked();
      await holdDeletion;
    });
    await locked;
    const delivery = createMessageNotificationDelivery({ store })(event);
    const completedWhileDeletionHeld = await Promise.race([
      delivery.then(() => true),
      new Promise((resolve) => setTimeout(() => resolve(false), 150)),
    ]);
    releaseDeletion();
    await deletion;
    await delivery;
    assert.equal(completedWhileDeletionHeld, false, "delivery must wait for the conversation lock");
    const rows = await sql.unsafe("SELECT id FROM notifications WHERE payload->>'conversationId' = $1", [conversation.id]);
    assert.equal(rows.length, 0);
  } finally {
    releaseDeletion();
    if (deletion) await deletion;
    await sql.unsafe("DELETE FROM notifications WHERE payload->>'conversationId' = $1", [conversation.id]);
    await sql.unsafe("DELETE FROM outbox_events WHERE aggregate_id IN (SELECT id::text FROM messages WHERE conversation_id = $1)", [conversation.id]);
    await sql.unsafe("DELETE FROM conversations WHERE id = $1", [conversation.id]);
  }
});

test("message delivery observes a concurrent committed membership change", integrationOptions, async () => {
  const suffix = randomUUID();
  const owner = `it-membership-owner-${suffix}`;
  const removed = `it-membership-removed-${suffix}`;
  const added = `it-membership-added-${suffix}`;
  const conversation = await store.createConversation({ actorId: owner, participantIds: [removed] });
  let releaseUpdate;
  const holdUpdate = new Promise((resolve) => { releaseUpdate = resolve; });
  let signalLocked;
  const locked = new Promise((resolve) => { signalLocked = resolve; });
  let update;
  try {
    await store.persistMessage({
      conversationId: conversation.id, senderId: owner, body: "membership changed", idempotencyKey: `it-membership-${suffix}`,
    });
    const [event] = await store.claimOutboxEvents({ limit: 1 });
    update = sql.begin(async (tx) => {
      await tx.unsafe("SELECT id FROM conversations WHERE id = $1 FOR UPDATE", [conversation.id]);
      await tx.unsafe("UPDATE conversation_participants SET left_at = now() WHERE conversation_id = $1 AND user_id = $2", [conversation.id, removed]);
      await tx.unsafe("INSERT INTO conversation_participants (conversation_id, user_id) VALUES ($1, $2)", [conversation.id, added]);
      signalLocked();
      await holdUpdate;
    });
    await locked;
    const delivery = createMessageNotificationDelivery({ store })(event);
    const completedWhileUpdateHeld = await Promise.race([
      delivery.then(() => true),
      new Promise((resolve) => setTimeout(() => resolve(false), 150)),
    ]);
    releaseUpdate();
    await update;
    await delivery;
    assert.equal(completedWhileUpdateHeld, false, "delivery must wait for the conversation lock");
    assert.equal((await store.listNotifications({ actorId: removed })).length, 0);
    assert.equal((await store.listNotifications({ actorId: added })).length, 1);
  } finally {
    releaseUpdate();
    if (update) await update;
    await sql.unsafe("DELETE FROM notifications WHERE payload->>'conversationId' = $1", [conversation.id]);
    await sql.unsafe("DELETE FROM outbox_events WHERE aggregate_id IN (SELECT id::text FROM messages WHERE conversation_id = $1)", [conversation.id]);
    await sql.unsafe("DELETE FROM conversations WHERE id = $1", [conversation.id]);
  }
});

test("message sending waits for concurrent sender removal and then denies the removed member", integrationOptions, async () => {
  const suffix = randomUUID();
  const owner = `it-send-lock-owner-${suffix}`;
  const sender = `it-send-lock-sender-${suffix}`;
  const conversation = await store.createConversation({ actorId: owner, participantIds: [sender] });
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  let signalLocked;
  const locked = new Promise((resolve) => { signalLocked = resolve; });
  let removal;
  try {
    removal = sql.begin(async (tx) => {
      await tx.unsafe("SELECT id FROM conversations WHERE id = $1 FOR UPDATE", [conversation.id]);
      await tx.unsafe("UPDATE conversation_participants SET left_at = now() WHERE conversation_id = $1 AND user_id = $2", [conversation.id, sender]);
      signalLocked();
      await held;
    });
    await locked;
    const pending = store.persistMessage({ conversationId: conversation.id, senderId: sender, body: "must not send after removal", idempotencyKey: suffix });
    const settledWhileRemovalHeld = await Promise.race([
      pending.then(() => true, () => true),
      new Promise((resolve) => setTimeout(() => resolve(false), 150)),
    ]);
    release();
    await removal;
    await assert.rejects(pending, ConversationAccessError);
    assert.equal(settledWhileRemovalHeld, false, "message send must wait for the conversation lock");
    assert.equal((await sql.unsafe("SELECT id FROM messages WHERE conversation_id = $1", [conversation.id])).length, 0);
    assert.equal((await sql.unsafe("SELECT id FROM outbox_events WHERE payload->>'conversationId' = $1", [conversation.id])).length, 0);
  } finally {
    release();
    if (removal) await removal;
    await sql.unsafe("DELETE FROM outbox_events WHERE payload->>'conversationId' = $1", [conversation.id]);
    await sql.unsafe("DELETE FROM conversations WHERE id = $1", [conversation.id]);
  }
});

test("message sending cannot create an orphan outbox event during conversation deletion", integrationOptions, async () => {
  const suffix = randomUUID();
  const owner = `it-send-delete-owner-${suffix}`;
  const recipient = `it-send-delete-recipient-${suffix}`;
  const conversation = await store.createConversation({ actorId: owner, participantIds: [recipient] });
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  let signalSwept;
  const swept = new Promise((resolve) => { signalSwept = resolve; });
  let deletion;
  try {
    deletion = sql.begin(async (tx) => {
      await tx.unsafe("SELECT id FROM conversations WHERE id = $1 FOR UPDATE", [conversation.id]);
      await tx.unsafe("DELETE FROM outbox_events WHERE aggregate_id IN (SELECT id::text FROM messages WHERE conversation_id = $1)", [conversation.id]);
      await tx.unsafe("DELETE FROM notifications WHERE payload->>'conversationId' = $1", [conversation.id]);
      signalSwept();
      await held;
      await tx.unsafe("DELETE FROM conversations WHERE id = $1", [conversation.id]);
    });
    await swept;
    const pending = store.persistMessage({ conversationId: conversation.id, senderId: owner, body: "must not orphan", idempotencyKey: suffix });
    const settledWhileDeletionHeld = await Promise.race([
      pending.then(() => true, () => true),
      new Promise((resolve) => setTimeout(() => resolve(false), 150)),
    ]);
    release();
    await deletion;
    await assert.rejects(pending, ConversationAccessError);
    assert.equal(settledWhileDeletionHeld, false, "message send must wait for the conversation lock");
    assert.equal((await sql.unsafe("SELECT id FROM outbox_events WHERE payload->>'conversationId' = $1", [conversation.id])).length, 0);
  } finally {
    release();
    if (deletion) await deletion;
    await sql.unsafe("DELETE FROM outbox_events WHERE payload->>'conversationId' = $1", [conversation.id]);
    await sql.unsafe("DELETE FROM conversations WHERE id = $1", [conversation.id]);
  }
});

test("import revision advances on work, translation and taxonomy changes, not views", integrationOptions, async () => {
  const id = randomUUID();
  const tag = randomUUID();
  const suffix = id.replaceAll("-", "");
  try {
    await sql.unsafe("INSERT INTO articles (id, author_id, slug) VALUES ($1, $2, $3)", [id, "revision-test", `rev-${suffix}`]);
    const revision = async () => BigInt((await sql.unsafe("SELECT import_revision FROM articles WHERE id = $1", [id]))[0].import_revision);
    let prev = await revision();
    const advances = async () => { const next = await revision(); assert.ok(next > prev); prev = next; };
    await sql.unsafe("INSERT INTO article_translations (article_id, locale, title, content_blocks) VALUES ($1, 'en', 'First', '[]'::jsonb)", [id]); await advances();
    await sql.unsafe("UPDATE article_translations SET title = 'Second' WHERE article_id = $1", [id]); await advances();
    await sql.unsafe("UPDATE articles SET slug = $2 WHERE id = $1", [id, `revised-${suffix}`]); await advances();
    await sql.unsafe("INSERT INTO taxonomies (id, kind, slug, created_by) VALUES ($1, 'tag', $2, 'revision-test')", [tag, `rev-${suffix}`]);
    await sql.unsafe("INSERT INTO article_taxonomies (article_id, taxonomy_id) VALUES ($1, $2)", [id, tag]); await advances();
    await sql.unsafe("DELETE FROM article_taxonomies WHERE article_id = $1", [id]); await advances();
    await sql.unsafe("UPDATE articles SET view_count = view_count + 1 WHERE id = $1", [id]);
    assert.equal(await revision(), prev);
    await assert.rejects(sql.begin(async (tx) => {
      await tx.unsafe("UPDATE article_translations SET title = 'Rollback' WHERE article_id = $1", [id]);
      const rows = await tx.unsafe("SELECT import_revision FROM articles WHERE id = $1", [id]);
      assert.ok(BigInt(rows[0].import_revision) > prev);
      throw new Error("test rollback");
    }), /test rollback/);
    assert.equal(await revision(), prev);
    await sql.unsafe("DELETE FROM article_translations WHERE article_id = $1", [id]); await advances();
    await sql.unsafe("UPDATE articles SET deleted_at = now() WHERE id = $1", [id]); await advances();
  } finally {
    await sql.unsafe("DELETE FROM articles WHERE id = $1", [id]);
    await sql.unsafe("DELETE FROM taxonomies WHERE id = $1", [tag]);
  }
});
