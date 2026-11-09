import test from "node:test";
import assert from "node:assert/strict";
import {
  TOMBSTONE_NOTIFICATION_BATCH_SIZE,
  TOMBSTONE_NOTIFICATION_LIMIT,
  createApplicationServices,
} from "./services.ts";
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
  const calls: number[] = [];
  let requestedLimit;
  const persistence = completeFakeAdapter();
  persistence.deleteArticle = async () => ({ id: "article-1", deletedAt: "2026-01-02T03:04:05.678Z" });
  persistence.listArticleCommentAuthorIds = async (args) => {
    requestedLimit = args.limit;
    return ["reader-1", "reader-2", "author-1"];
  };
  // Audit F-23: the notices are written in batches, one transaction each, rather
  // than one transaction per reader inside the deleting request.
  persistence.createNotifications = async (inputs) => {
    calls.push(inputs.length);
    for (const input of inputs) notified.push(input);
    return inputs.map((input) => ({ id: `notification-${input.userId}`, duplicate: false }));
  };
  const services = createApplicationServices({ persistence, env: { ARTICLE_TOMBSTONE_RETENTION_DAYS: "30" } });
  await services.deleteArticle({ actorId: "author-1", articleId: "article-1" });

  // Every commenter is told once; the author who deleted their own work is not.
  assert.deepEqual(notified.map((input) => input.userId), ["reader-1", "reader-2"]);
  assert.deepEqual(calls, [2], "two notices, one transaction");
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
  // The batch is one transaction, so a collision inside it writes nothing; the
  // deletion path then retries that batch row by row, which is what isolates the
  // one reader who cannot be told.
  persistence.createNotifications = async () => {
    throw new Error("one of these keys was already used with a different payload");
  };
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

test("a page of commenters is written in batches, and a failing batch costs only its own readers", async () => {
  // Audit F-23: 200 recipients used to mean 200 transactions inside one DELETE
  // request. They are now ceil(200 / batch) transactions, and one bad batch must
  // not take the others with it.
  const recipients = Array.from({ length: 150 }, (_, index) => `reader-${index}`);
  const delivered: string[][] = [];
  const batchCalls: string[][] = [];
  const failures: Array<{ task: string; errorName: string; failed?: number }> = [];
  const persistence = completeFakeAdapter();
  persistence.deleteArticle = async () => ({ id: "article-1", deletedAt: "2026-01-02T03:04:05.678Z" });
  persistence.listArticleCommentAuthorIds = async () => recipients;
  persistence.createNotifications = async (inputs) => {
    batchCalls.push(inputs.map((input) => input.userId));
    // The middle batch is the broken one.
    if (batchCalls.length === 2) throw new Error("the second batch could not be written");
    delivered.push(inputs.map((input) => input.userId));
    return inputs.map((input) => ({ id: `notification-${input.userId}`, duplicate: false }));
  };
  // The retry after a failed batch: two rows land one at a time, so exactly the
  // remaining readers of that batch are counted as never told.
  let retried = 0;
  persistence.createNotification = async ({ userId }) => {
    retried += 1;
    if (retried <= 2) return { id: `notification-${userId}`, duplicate: false };
    throw new Error("this reader's inbox row cannot be written");
  };

  const services = createApplicationServices({ persistence, onBackgroundFailure: (failure) => failures.push(failure) });
  await services.deleteArticle({ actorId: "author-1", articleId: "article-1" });

  assert.deepEqual(batchCalls.map((batch) => batch.length), [50, 50, 50], "three transactions, not 150");
  assert.deepEqual(delivered, [recipients.slice(0, 50), recipients.slice(100)], "the batches around the broken one are committed");
  assert.equal(retried, 50, "only the failed batch is retried row by row");
  assert.deepEqual(failures, [{
    task: "tombstone-notifications",
    errorName: "Error",
    failed: 48,
  }]);
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

test("a failing cleanup rides on the write without becoming the write's failure — and is reported", async () => {
  // Audit F-22: both of these used to `catch {}`, so a broken cleanup was
  // indistinguishable from an empty one. They still may not fail the user's save;
  // they now say what happened, by class, on the API's own log sink.
  const failures: Array<{ task: string; errorName: string; failed?: number }> = [];
  const persistence = completeFakeAdapter();
  persistence.createArticle = async () => ({ id: "article-1", slug: "kept" });
  persistence.purgeExpiredArticles = async () => {
    throw new RangeError("database is locked for postgres://writer:hunter2@db.internal/no_wave");
  };
  persistence.deleteArticle = async () => ({ id: "article-1", deletedAt: "2026-01-02T03:04:05.678Z" });
  persistence.listArticleCommentAuthorIds = async () => ["reader-1", "reader-2"];
  persistence.createNotifications = async () => { throw new Error("inbox unavailable"); };
  persistence.createNotification = async () => { throw new Error("inbox unavailable"); };
  const services = createApplicationServices({
    persistence,
    onBackgroundFailure: (failure) => failures.push(failure),
  });

  // The tombstone sweep fires every 32 writes; the 32nd must still return the
  // article it created.
  let last;
  for (let write = 0; write < 32; write += 1) {
    last = await services.createArticle({ authorId: "author-1", slug: "kept", title: "Kept", locale: "en", contentBlocks: "[]", summary: "" });
  }
  assert.deepEqual(last, { id: "article-1", slug: "kept" });

  assert.deepEqual(failures, [{ task: "tombstone-purge", errorName: "RangeError" }]);
  assert.equal(JSON.stringify(failures).includes("hunter2"), false, "no connection string may reach the report");

  // The deletion notice is a background write too: one report per deletion, with
  // the count of readers who could not be told.
  await services.deleteArticle({ actorId: "author-1", articleId: "article-1" });
  const notice = failures.find((failure) => failure.task === "tombstone-notifications");
  assert.deepEqual(notice, { task: "tombstone-notifications", errorName: "Error", failed: 2 });
});

test("a reporter that throws cannot turn a cleanup failure into a request failure", async () => {
  const persistence = completeFakeAdapter();
  persistence.deleteArticle = async () => ({ id: "article-1", deletedAt: "2026-01-02T03:04:05.678Z" });
  persistence.listArticleCommentAuthorIds = async () => ["reader-1"];
  persistence.createNotifications = async () => { throw new Error("inbox unavailable"); };
  const services = createApplicationServices({
    persistence,
    onBackgroundFailure: () => { throw new Error("the log sink is full"); },
  });
  assert.deepEqual(await services.deleteArticle({ actorId: "author-1", articleId: "article-1" }), {
    id: "article-1",
    deletedAt: "2026-01-02T03:04:05.678Z",
  });
});

/**
 * What the counter counts (ADR 0035).
 *
 * The four decisions that make a view a view, each asserted where it is made: a
 * signed-in reader is charged one bucket for the day, a repeat answers "not
 * counted" instead of incrementing, the author's own reading is refused before
 * anything is charged, and a deployment with no secret to key readers by records
 * nothing rather than recording a number that means nothing.
 */
test("a read is counted once per reader per day, and the author's own reading is not", async () => {
  const article = {
    id: "9f0e3d2a-0000-4000-8000-000000000001",
    authorId: "author-1",
    slug: "clean-architecture",
    workType: "essay",
    status: "published",
    locale: "en",
    title: "Clean Architecture",
    summary: "",
    contentBlocks: [],
    contentBlocksVersion: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    publishedAt: "2026-01-01T00:00:00.000Z",
    viewCount: 7,
  };
  const charges: Array<{ key: string; limit: number; windowSeconds: number }> = [];
  const increments: string[] = [];
  let allow = true;
  const persistence = completeFakeAdapter();
  persistence.getPublishedArticle = async () => article;
  persistence.consumeRateLimit = async (bucket) => {
    charges.push(bucket);
    return { allowed: allow, resetAt: "2026-03-02T00:00:00.000Z" };
  };
  persistence.incrementArticleViewCount = async ({ articleId }) => {
    increments.push(articleId);
    return 8;
  };
  const services = createApplicationServices({
    persistence,
    env: { AUTH_JWT_SECRET: "s".repeat(40) },
  });

  // A reader's first visit of the day: one bucket charged for one view.
  assert.deepEqual(
    await services.recordArticleView({ slug: "clean-architecture", locale: "en", actorId: "reader-1", address: "203.0.113.9" }),
    { counted: true, viewCount: 8 },
  );
  assert.equal(charges.length, 1);
  assert.equal(charges[0].limit, 1, "one view per bucket");
  assert.equal(charges[0].windowSeconds, 86_400);
  assert.match(charges[0].key, /^[0-9a-f]{64}$/, "the bucket key is a digest, not the reader");
  assert.deepEqual(increments, [article.id]);

  // The same reader, the same day: the bucket says no, and nothing is written.
  allow = false;
  assert.deepEqual(
    await services.recordArticleView({ slug: "clean-architecture", locale: "en", actorId: "reader-1", address: "203.0.113.9" }),
    { counted: false, viewCount: 7 },
    "a deduplicated view reports the count the reader already had",
  );
  assert.deepEqual(increments, [article.id], "the deduplicated read did not touch the counter");

  // The author reading their own work is not charged at all — not even a bucket.
  charges.length = 0;
  assert.deepEqual(
    await services.recordArticleView({ slug: "clean-architecture", locale: "en", actorId: "author-1", address: "203.0.113.9" }),
    { counted: false, viewCount: 7 },
  );
  assert.deepEqual(charges, [], "the author's proofreading never reaches the dedupe store");
});

test("a view of something that is not a published work is a not-found, not a discarded write", async () => {
  const persistence = completeFakeAdapter();
  persistence.getPublishedArticle = async () => null;
  const services = createApplicationServices({ persistence, env: { AUTH_JWT_SECRET: "s".repeat(40) } });
  await assert.rejects(
    Promise.resolve().then(() => services.recordArticleView({ slug: "never-published", address: "203.0.113.9" })),
    { code: "NOT_FOUND" },
  );
});

test("without a secret to key readers by, nothing is counted", async () => {
  const article = {
    id: "9f0e3d2a-0000-4000-8000-000000000002",
    authorId: "author-1",
    slug: "unkeyed",
    viewCount: 3,
  };
  const charges: unknown[] = [];
  const increments: unknown[] = [];
  const persistence = completeFakeAdapter();
  persistence.getPublishedArticle = async () => article;
  persistence.consumeRateLimit = async (bucket) => {
    charges.push(bucket);
    return { allowed: true, resetAt: "2026-03-02T00:00:00.000Z" };
  };
  persistence.incrementArticleViewCount = async (input) => {
    increments.push(input);
    return 4;
  };
  // A short secret is the misconfiguration the rest of the service also refuses;
  // here it must not turn into an inflatable counter.
  const services = createApplicationServices({ persistence, env: { AUTH_JWT_SECRET: "short" } });
  assert.deepEqual(
    await services.recordArticleView({ slug: "unkeyed", address: "203.0.113.9" }),
    { counted: false, viewCount: 3 },
  );
  assert.deepEqual(charges, []);
  assert.deepEqual(increments, []);
});
