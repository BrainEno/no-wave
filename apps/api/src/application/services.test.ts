import test from "node:test";
import assert from "node:assert/strict";
import { TOMBSTONE_NOTIFICATION_LIMIT, createApplicationServices } from "./services.ts";
import { assertPersistenceAdapter, persistencePortMethods, createPersistencePorts } from "./persistence-ports.ts";

function completeFakeAdapter() {
  const adapter = {};
  for (const methods of Object.values(persistencePortMethods)) {
    for (const method of methods) adapter[method] = async (...args) => ({ method, args });
  }
  return adapter;
}

test("persistence adapter contract reports every missing operation at composition time", () => {
  assert.throws(
    () => assertPersistenceAdapter({ health() {} }),
    (error) => {
      assert.match(error.message, /content\.listPublishedArticles/);
      assert.match(error.message, /outbox\.rescheduleOutboxEvent/);
      return true;
    },
  );
});

test("persistence ports are grouped by domain and forward calls without changing values", async () => {
  const adapter = completeFakeAdapter();
  const ports = createPersistencePorts(adapter);
  assert.equal(typeof ports.content.getPublishedArticle, "function");
  assert.equal(typeof ports.taxonomy.createTag, "function");
  assert.equal(typeof ports.conversations.persistMessage, "function");
  assert.equal(typeof ports.sessions.isSessionRevoked, "function");
  const result = await ports.taxonomy.createTag({ actorId: "user-1", name: "#中文" });
  assert.deepEqual(result, {
    method: "createTag",
    args: [{ actorId: "user-1", name: "#中文" }],
  });
});

test("application service facade exposes domain operations without requiring a database driver", async () => {
  const persistence = completeFakeAdapter();
  assert.equal(assertPersistenceAdapter(persistence), persistence);
  const services = createApplicationServices({ persistence });
  const content = await services.getPublishedArticle({ slug: "clean-architecture", locale: "en" });
  assert.deepEqual(content, {
    method: "getPublishedArticle",
    args: [{ slug: "clean-architecture", locale: "en" }],
  });
  const session = await services.isSessionRevoked("session-123");
  assert.deepEqual(session, { method: "isSessionRevoked", args: ["session-123"] });
});


test("deleting a work tells the readers who commented on it when their words go", async () => {
  const notified: Array<{ userId: string; eventKey: string; payload: unknown }> = [];
  let requestedLimit;
  const persistence = completeFakeAdapter();
  persistence.deleteArticle = async () => ({ id: "article-1", deletedAt: "2026-01-02T03:04:05.678Z" });
  persistence.listArticleCommentAuthorIds = async (args) => {
    requestedLimit = args.limit;
    return ["reader-1", "reader-2", "author-1"];
  };
  persistence.createNotification = async (input) => {
    notified.push(input);
    return { id: `notification-${notified.length}`, duplicate: false };
  };
  const services = createApplicationServices({ persistence, env: { ARTICLE_TOMBSTONE_RETENTION_DAYS: "30" } });
  await services.deleteArticle({ actorId: "author-1", articleId: "article-1" });

  // Every commenter is told once; the author who deleted their own work is not.
  assert.deepEqual(notified.map((input) => input.userId), ["reader-1", "reader-2"]);
  // The notice names the date the sweep runs, not the deletion: that is the
  // date the reader's own words disappear.
  assert.deepEqual(notified[0].payload, {
    type: "article.deleted",
    articleId: "article-1",
    purgesAt: "2026-02-01T03:04:05.678Z",
  });
  assert.equal(notified[0].eventKey, "article.deleted:article-1:reader-1");
  // Bounded inside the request rather than paginated across many.
  assert.equal(requestedLimit, TOMBSTONE_NOTIFICATION_LIMIT);
});

test("a reader who cannot be told does not stop the deletion", async () => {
  const notified: string[] = [];
  const persistence = completeFakeAdapter();
  persistence.deleteArticle = async () => ({ id: "article-1", deletedAt: "2026-01-02T03:04:05.678Z" });
  persistence.listArticleCommentAuthorIds = async () => ["reader-1", "reader-2"];
  persistence.createNotification = async ({ userId }) => {
    if (userId === "reader-1") throw new Error("the inbox row could not be written");
    notified.push(userId);
    return { id: `notification-${userId}`, duplicate: false };
  };
  const services = createApplicationServices({ persistence });
  // The deletion stands on its own: an inbox is not part of its transaction.
  assert.deepEqual(await services.deleteArticle({ actorId: "author-1", articleId: "article-1" }), {
    id: "article-1",
    deletedAt: "2026-01-02T03:04:05.678Z",
  });
  assert.deepEqual(notified, ["reader-2"], "one undeliverable notice must not silence the rest");

  const broken = completeFakeAdapter();
  broken.deleteArticle = async () => ({ id: "article-1", deletedAt: "2026-01-02T03:04:05.678Z" });
  broken.listArticleCommentAuthorIds = async () => { throw new Error("the comment index is down"); };
  const servicesWithoutInbox = createApplicationServices({ persistence: broken });
  assert.deepEqual(await servicesWithoutInbox.deleteArticle({ actorId: "author-1", articleId: "article-1" }), {
    id: "article-1",
    deletedAt: "2026-01-02T03:04:05.678Z",
  });
});

test("application article use cases parse serialized content blocks before persistence", async () => {
  const persistence = completeFakeAdapter();
  const services = createApplicationServices({ persistence });
  const input = {
    slug: "hello-world",
    title: "Hello",
    locale: "zh-TW",
    contentBlocks: '[{"id":"b1","type":"paragraph","text":"Hello"}]',
  };
  const created = await services.createArticle({ ...input, authorId: "author-1" });
  assert.deepEqual(created.args[0], {
    ...input,
    authorId: "author-1",
    contentBlocks: [{ id: "b1", type: "paragraph", text: "Hello" }],
  });
  const updated = await services.updateArticle({ ...input, articleId: "article-1", actorId: "author-1" });
  assert.deepEqual(updated.args[0].contentBlocks, [{ id: "b1", type: "paragraph", text: "Hello" }]);
});

test("application article use cases reject malformed or non-array content before persistence", async () => {
  const calls = [];
  const persistence = completeFakeAdapter();
  persistence.createArticle = async (input) => {
    calls.push({ method: "createArticle", input });
    return input;
  };
  persistence.updateArticle = async (input) => {
    calls.push({ method: "updateArticle", input });
    return input;
  };
  const services = createApplicationServices({ persistence });
  const invalidValues = ["not-json", JSON.stringify({ type: "paragraph" }), JSON.stringify(null)];

  for (const contentBlocks of invalidValues) {
    await assert.rejects(
      () => services.createArticle({ slug: "invalid", title: "Invalid", locale: "zh-TW", contentBlocks, authorId: "author-1" }),
      (error) => error.code === "BAD_USER_INPUT" && /valid JSON array/.test(error.message),
    );
    await assert.rejects(
      () => services.updateArticle({ articleId: "article-1", slug: "invalid", title: "Invalid", locale: "zh-TW", contentBlocks, actorId: "author-1" }),
      (error) => error.code === "BAD_USER_INPUT" && /valid JSON array/.test(error.message),
    );
  }

  assert.deepEqual(calls, []);
});
