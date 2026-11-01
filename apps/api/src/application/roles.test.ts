import assert from "node:assert/strict";
import test from "node:test";
import { createApplicationServices } from "./services.ts";
import { ProfileAuthorizationError, ProfileInputError, ProfileNotFoundError } from "../domain/errors.ts";

/**
 * ADR 0016: the editor role is the platform's first permission question, so it is
 * the first place a caller can be refused. These tests use a fake adapter on
 * purpose — the two real adapters' agreement about *how* a role is stored is the
 * persistence contract's job; what belongs here is who gets to answer the
 * question, and that depends on the environment list.
 */
function fakePersistence(overrides = {}) {
  const roles = new Map();
  const calls = [];
  return {
    calls,
    roles,
    adapter: {
      async getUserRole({ userId }) {
        calls.push(["getUserRole", userId]);
        return roles.get(userId) ?? "member";
      },
      async setUserRole({ actorId, userId, role }) {
        calls.push(["setUserRole", { actorId, userId, role }]);
        if (actorId === userId) throw new ProfileInputError("You cannot change your own role.");
        if (!["member", "editor"].includes(role)) throw new ProfileInputError("role must be one of: member, editor.");
        if (userId === "missing-user") throw new ProfileNotFoundError();
        roles.set(userId, role);
        return role;
      },
      ...overrides,
    },
  };
}

test("an account is a member until something says otherwise, and a missing one never fails open", async () => {
  const { adapter, calls } = fakePersistence();
  const services = createApplicationServices({ persistence: adapter, env: {} });
  assert.equal(await services.isEditor({ actorId: "nobody" }), false);

  const empty = createApplicationServices({ persistence: adapter, env: {} });
  assert.equal(await empty.isEditor({ actorId: "   " }), false);
  assert.equal(await empty.isEditor({ actorId: "" }), false);
  // An empty actor never reaches persistence at all.
  assert.deepEqual(calls, [["getUserRole", "nobody"]]);
});

test("EDITOR_USER_IDS bootstraps the first editor and is honoured without a stored role", async () => {
  const { adapter, roles } = fakePersistence();
  const services = createApplicationServices({
    persistence: adapter,
    env: { EDITOR_USER_IDS: "bootstrap-editor, other-editor , ," },
  });
  // Whitespace and empty entries are tolerated; the column is never consulted
  // for these accounts, which is what makes an empty database usable.
  assert.equal(await services.isEditor({ actorId: "bootstrap-editor" }), true);
  assert.equal(await services.isEditor({ actorId: "other-editor" }), true);
  assert.equal(await services.isEditor({ actorId: "someone-else" }), false);
  assert.equal(roles.has("bootstrap-editor"), false);
});

test("a stored editor is one too, and the environment list adds to the column rather than replacing it", async () => {
  const { adapter, roles } = fakePersistence();
  roles.set("stored-editor", "editor");
  const services = createApplicationServices({
    persistence: adapter,
    env: { EDITOR_USER_IDS: "bootstrap-editor" },
  });
  assert.equal(await services.isEditor({ actorId: "stored-editor" }), true);
  assert.equal(await services.isEditor({ actorId: "bootstrap-editor" }), true);
  assert.equal(await services.isEditor({ actorId: "stored-member" }), false);
});

test("only an editor may assign a role, and the refusal happens before persistence is touched", async () => {
  const { adapter, calls, roles } = fakePersistence();
  const services = createApplicationServices({ persistence: adapter, env: {} });
  await assert.rejects(
    () => services.assignUserRole({ actorId: "a-member", userId: "someone", role: "editor" }),
    ProfileAuthorizationError,
  );
  assert.deepEqual(calls, [["getUserRole", "a-member"]]);
  assert.equal(roles.size, 0);
});

test("an editor can promote and demote others, and the assignment still refuses self-service", async () => {
  const { adapter, roles } = fakePersistence();
  const services = createApplicationServices({
    persistence: adapter,
    env: { EDITOR_USER_IDS: "bootstrap-editor" },
  });
  assert.equal(await services.assignUserRole({ actorId: "bootstrap-editor", userId: "writer", role: "editor" }), "editor");
  assert.equal(await services.isEditor({ actorId: "writer" }), true);
  assert.equal(await services.assignUserRole({ actorId: "bootstrap-editor", userId: "writer", role: "member" }), "member");
  assert.equal(await services.isEditor({ actorId: "writer" }), false);
  // ADR 0016, decision 3: the bootstrap editor is an editor and still cannot
  // touch its own role — being an editor is not permission to lock the platform out.
  await assert.rejects(
    () => services.assignUserRole({ actorId: "bootstrap-editor", userId: "bootstrap-editor", role: "member" }),
    ProfileInputError,
  );
  // A missing account is a 404 from persistence, not a silent success.
  await assert.rejects(
    () => services.assignUserRole({ actorId: "bootstrap-editor", userId: "missing-user", role: "editor" }),
    ProfileNotFoundError,
  );
  assert.deepEqual([...roles.entries()], [["writer", "member"]]);
});

test("the editor question is answered once in the application layer and handed to persistence as a fact", async () => {
  const calls = [];
  const { adapter } = fakePersistence({
    async createTaxonomy(args) { calls.push(["create", args]); return { id: "taxonomy-1", ...args }; },
    async deleteTaxonomy(args) { calls.push(["delete", args]); return true; },
  });
  const services = createApplicationServices({
    persistence: adapter,
    env: { EDITOR_USER_IDS: "bootstrap-editor" },
  });
  await services.createTaxonomy({ actorId: "bootstrap-editor", kind: "category", slug: "poetry", name: "诗", locale: "zh-CN" });
  // A hashtag needs no role: the author is speaking about their own work.
  await services.createTaxonomy({ actorId: "a-member", kind: "tag", slug: "nowave", name: "NoWave", locale: "zh-CN" });
  await services.deleteTaxonomy({ actorId: "a-member", taxonomyId: "taxonomy-1" });
  assert.deepEqual(calls, [
    ["create", { kind: "category", slug: "poetry", name: "诗", locale: "zh-CN", actorId: "bootstrap-editor", actorIsEditor: true }],
    ["create", { kind: "tag", slug: "nowave", name: "NoWave", locale: "zh-CN", actorId: "a-member", actorIsEditor: false }],
    ["delete", { taxonomyId: "taxonomy-1", actorId: "a-member", actorIsEditor: false }],
  ]);
});
