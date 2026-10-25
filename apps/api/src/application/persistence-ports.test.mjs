import assert from "node:assert/strict";
import test from "node:test";

import {
  assertPersistenceAdapter,
  createPersistencePorts,
  persistencePortMethods,
} from "./persistence-ports.mjs";
import { createApplicationServices } from "./services.mjs";

function makeAdapter(overrides = {}) {
  const calls = [];
  const adapter = Object.fromEntries(
    Object.values(persistencePortMethods).flat().map((method) => [
      method,
      async (...args) => {
        calls.push({ method, args });
        return { method, args };
      },
    ]),
  );
  Object.assign(adapter, overrides);
  return { adapter, calls };
}

test("the persistence port contract has unique method names across domain groups", () => {
  const entries = Object.entries(persistencePortMethods);
  const names = entries.flatMap(([, methods]) => methods);
  assert.ok(entries.length >= 8);
  assert.equal(new Set(names).size, names.length);
  for (const [group, methods] of entries) {
    assert.ok(group.length > 0);
    assert.ok(methods.length > 0);
    for (const method of methods) assert.match(method, /^[a-z][A-Za-z0-9]*$/);
  }
});

test("adapter shape validation reports every missing operation in one error", () => {
  assert.throws(
    () => assertPersistenceAdapter({ health() {} }),
    (error) => {
      assert.match(error.message, /content\.listPublishedArticles/);
      assert.match(error.message, /outbox\.claimOutboxEvents/);
      return true;
    },
  );
  assert.throws(() => assertPersistenceAdapter(null), /adapter object is required/);
});

test("domain-grouped ports preserve adapter receiver and forward arguments and results", async () => {
  let receiver;
  const expected = { id: "article-1" };
  const { adapter } = makeAdapter({
    async getPublishedArticle(input) {
      receiver = this;
      assert.deepEqual(input, { slug: "hello", locale: "en" });
      return expected;
    },
  });
  const ports = createPersistencePorts(adapter);
  assert.equal(await ports.content.getPublishedArticle({ slug: "hello", locale: "en" }), expected);
  assert.equal(receiver, adapter);
  assert.ok(Object.isFrozen(ports));
  assert.ok(Object.isFrozen(ports.content));
});

test("application services expose a transport-neutral facade over adapter operations", async () => {
  const expected = [{ id: "article-1", slug: "hello" }];
  const { adapter, calls } = makeAdapter({
    async listPublishedArticles(input) {
      calls.push({ method: "listPublishedArticles", args: [input] });
      return expected;
    },
  });
  const services = createApplicationServices({ persistence: adapter });
  assert.equal(await services.listPublishedArticles({
    locale: "en", query: "poetry", limit: 10, offset: 20,
  }), expected);
  assert.deepEqual(calls, [{
    method: "listPublishedArticles",
    args: [{ locale: "en", query: "poetry", limit: 10, offset: 20 }],
  }]);
  assert.equal(typeof services.health, "function");
  assert.equal(typeof services.createArticle, "function");
  assert.equal(Object.isFrozen(services), true);
});

test("application service facade rejects invalid serialized article content before persistence", async () => {
  let called = false;
  const { adapter } = makeAdapter({
    async createArticle() {
      called = true;
      throw new Error("must not be reached");
    },
  });
  const services = createApplicationServices({ persistence: adapter });
  await assert.rejects(
    services.createArticle({ authorId: "author-1", title: "Draft", contentBlocks: "not-json" }),
    /contentBlocks must be a valid JSON array/,
  );
  assert.equal(called, false);
});

test("every required operation can be invoked through its matching domain port", async () => {
  const { adapter, calls } = makeAdapter();
  const ports = createPersistencePorts(adapter);
  for (const [group, methods] of Object.entries(persistencePortMethods)) {
    for (const method of methods) {
      const result = await ports[group][method]("contract-probe");
      assert.equal(result.method, method);
      assert.deepEqual(result.args, ["contract-probe"]);
    }
  }
  assert.equal(calls.length, Object.values(persistencePortMethods).flat().length);
});

test("port wrappers fail explicitly when a required adapter operation is absent", () => {
  const adapter = { health: async () => true };
  const ports = createPersistencePorts(adapter);
  assert.throws(
    () => ports.content.listPublishedArticles({ locale: "en" }),
    /does not implement content\.listPublishedArticles/,
  );
});
