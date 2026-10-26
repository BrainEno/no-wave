import test from "node:test";
import assert from "node:assert/strict";
import { createApplicationServices } from "./services.ts";
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
