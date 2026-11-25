/** Conversations, notifications and duplicated query parameters. Split from server.test.ts (#357). */
import assert from "node:assert/strict";
import test from "node:test";
import { encodeCursor } from "./domain/cursor.ts";
import { authEnv, signedToken, withServer } from "./test-support/rest-server-harness.ts";


test("REST conversation and message routes preserve full fields, cursor order contract, membership context, and idempotency", async () => {
  const calls: Array<{ method: string; args: Record<string, unknown> }> = [];
  const conversation = {
    id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", createdBy: "writer-user", participantIds: ["reader-user", "writer-user"],
    createdAt: "2026-01-01T00:00:00.000Z", lastActivityAt: "2026-01-02T00:00:00.000Z",
    unreadCount: 2,
    lastMessage: { id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", conversationId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", senderId: "reader-user", body: "收到", createdAt: "2026-01-02T00:00:00.000Z" },
  };
  const message = { id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", conversationId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", senderId: "writer-user", body: "你好", createdAt: "2026-01-03T00:00:00.000Z" };
  await withServer(async (baseUrl) => {
    const authorization = "Bearer " + signedToken("writer-user");
    const jsonHeaders = { authorization, "content-type": "application/json" };

    const created = await fetch(baseUrl + "/api/v1/conversations", {
      method: "POST", headers: { ...jsonHeaders, "idempotency-key": "open-once-1" }, body: JSON.stringify({ participantIds: ["reader-user"] }),
    });
    assert.equal(created.status, 201);
    assert.deepEqual(await created.json(), { data: conversation });

    const missingCreateKeyRejected = await fetch(baseUrl + "/api/v1/conversations", {
      method: "POST", headers: jsonHeaders, body: JSON.stringify({ participantIds: ["reader-user"] }),
    });
    assert.equal(missingCreateKeyRejected.status, 400, "a retried create without a key would silently open a second conversation");

    const listed = await fetch(baseUrl + "/api/v1/conversations?limit=5", { headers: { authorization } });
    assert.equal(listed.status, 200);
    assert.deepEqual(await listed.json(), { data: [conversation] });

    const fetched = await fetch(baseUrl + "/api/v1/conversations/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", { headers: { authorization } });
    assert.equal(fetched.status, 200);
    assert.deepEqual(await fetched.json(), { data: conversation });

    const history = await fetch(baseUrl + "/api/v1/conversations/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/messages?limit=2&before=eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", { headers: { authorization } });
    assert.equal(history.status, 200);
    assert.deepEqual(await history.json(), { data: [message] });

    const sent = await fetch(baseUrl + "/api/v1/conversations/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/messages", {
      method: "POST", headers: { ...jsonHeaders, "idempotency-key": "send-once-1" }, body: JSON.stringify({ body: "你好" }),
    });
    assert.equal(sent.status, 201);
    assert.deepEqual(await sent.json(), { data: message });

    const bodyIdentityRejected = await fetch(baseUrl + "/api/v1/conversations/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/messages", {
      method: "POST", headers: { ...jsonHeaders, "idempotency-key": "send-once-2" },
      body: JSON.stringify({ body: "你好", senderId: "admin-user" }),
    });
    assert.equal(bodyIdentityRejected.status, 400);

    const missingKeyRejected = await fetch(baseUrl + "/api/v1/conversations/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/messages", {
      method: "POST", headers: jsonHeaders, body: JSON.stringify({ body: "另一条消息" }),
    });
    assert.equal(missingKeyRejected.status, 400);

    const updated = await fetch(baseUrl + "/api/v1/conversations/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/participants", {
      method: "PATCH", headers: jsonHeaders, body: JSON.stringify({ addUserIds: ["third-user"], removeUserIds: [] }),
    });
    assert.equal(updated.status, 200);
    assert.deepEqual(await updated.json(), { data: conversation });

    const markedRead = await fetch(baseUrl + "/api/v1/conversations/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/read", { method: "PUT", headers: { authorization } });
    assert.equal(markedRead.status, 200);
    assert.deepEqual(await markedRead.json(), { data: true });

    const deleted = await fetch(baseUrl + "/api/v1/conversations/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", { method: "DELETE", headers: { authorization } });
    assert.equal(deleted.status, 200);
    assert.deepEqual(await deleted.json(), { data: true });

    const unauthenticated = await fetch(baseUrl + "/api/v1/conversations");
    assert.equal(unauthenticated.status, 401);
  }, {
    env: authEnv,
    store: {
      async createConversation(args) { calls.push({ method: "createConversation", args }); return conversation; },
      async listConversations(args) { calls.push({ method: "listConversations", args }); return [conversation]; },
      async listConversationMessages(args) { calls.push({ method: "listConversationMessages", args }); return [message]; },
      async persistMessage(args) { calls.push({ method: "persistMessage", args }); return message; },
      async getConversation(args) { calls.push({ method: "getConversation", args }); return conversation; },
      async updateConversationParticipants(args) { calls.push({ method: "updateConversationParticipants", args }); return ["reader-user", "third-user", "writer-user"]; },
      async markConversationAsRead(args) { calls.push({ method: "markConversationAsRead", args }); return true; },
      async deleteConversation(args) { calls.push({ method: "deleteConversation", args }); return true; },
    },
  });

  assert.deepEqual(calls[0], { method: "createConversation", args: { actorId: "writer-user", participantIds: ["reader-user"], idempotencyKey: "open-once-1" } });
  assert.deepEqual(calls.find((call) => call.method === "listConversationMessages"), {
    method: "listConversationMessages",
    args: { conversationId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", actorId: "writer-user", limit: 2, before: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee" },
  });
  assert.deepEqual(calls.find((call) => call.method === "persistMessage"), {
    method: "persistMessage",
    args: { conversationId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", senderId: "writer-user", body: "你好", idempotencyKey: "send-once-1" },
  });
  assert.deepEqual(calls.find((call) => call.method === "updateConversationParticipants"), {
    method: "updateConversationParticipants",
    args: { conversationId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", actorId: "writer-user", addUserIds: ["third-user"], removeUserIds: [] },
  });
  assert.deepEqual(calls.find((call) => call.method === "getConversation"), {
    method: "getConversation",
    args: { conversationId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", actorId: "writer-user" },
  });
  assert.equal(calls.filter((call) => call.method === "listConversations").length, 1,
    "the participant update response must not depend on the first 100 conversation list entries");
  assert.deepEqual(calls.find((call) => call.method === "markConversationAsRead"), {
    method: "markConversationAsRead", args: { conversationId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", actorId: "writer-user" },
  });
  assert.deepEqual(calls.find((call) => call.method === "deleteConversation"), {
    method: "deleteConversation", args: { conversationId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", actorId: "writer-user" },
  });
});

test("REST conversation detail is member-scoped: a stranger's read is indistinguishable from a missing conversation", async () => {
  const conversation = {
    id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", createdBy: "writer-user", participantIds: ["reader-user", "writer-user"],
    createdAt: "2026-01-01T00:00:00.000Z", lastActivityAt: "2026-01-02T00:00:00.000Z", unreadCount: 0, lastMessage: null,
  };
  await withServer(async (baseUrl) => {
    const authorization = "Bearer " + signedToken("stranger-user");
    const read = await fetch(baseUrl + "/api/v1/conversations/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", { headers: { authorization } });
    assert.equal(read.status, 404);
    assert.deepEqual(await read.json(), { error: { code: "NOT_FOUND", message: "The conversation was not found." } });

    const unauthenticated = await fetch(baseUrl + "/api/v1/conversations/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
    assert.equal(unauthenticated.status, 401);

    const unsupported = await fetch(baseUrl + "/api/v1/conversations/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", { method: "PUT", headers: { authorization } });
    assert.equal(unsupported.status, 405);
    assert.equal(unsupported.headers.get("allow"), "GET, DELETE");
  }, {
    env: authEnv,
    store: {
      async getConversation() { return null; },
    },
  });
});

test("REST notification routes are recipient-scoped and preserve their JSON-string payload contract", async () => {
  const calls: Array<{ method: string; args: Record<string, unknown> }> = [];
  const notification = {
    id: "ffffffff-ffff-4fff-8fff-ffffffffffff", userId: "reader-user", eventKey: "message.created",
    payload: { conversationId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", messageId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", type: "message.created" },
    createdAt: "2026-01-01T00:00:00.000Z", readAt: null,
  };
  const publicShape = {
    id: "ffffffff-ffff-4fff-8fff-ffffffffffff", eventKey: "message.created", payload: JSON.stringify(notification.payload),
    createdAt: notification.createdAt, readAt: null,
  };
  await withServer(async (baseUrl) => {
    const authorization = "Bearer " + signedToken("reader-user");
    const listed = await fetch(baseUrl + "/api/v1/me/notifications?limit=10", { headers: { authorization } });
    assert.equal(listed.status, 200);
    assert.deepEqual(await listed.json(), { data: [publicShape] });

    const unread = await fetch(baseUrl + "/api/v1/me/notifications/unread-count", { headers: { authorization } });
    assert.equal(unread.status, 200);
    assert.deepEqual(await unread.json(), { data: 4 });

    const marked = await fetch(baseUrl + "/api/v1/me/notifications/ffffffff-ffff-4fff-8fff-ffffffffffff/read", { method: "PUT", headers: { authorization } });
    assert.equal(marked.status, 200);
    assert.deepEqual(await marked.json(), { data: { ...publicShape, readAt: "2026-01-02T00:00:00.000Z" } });

    const all = await fetch(baseUrl + "/api/v1/me/notifications/read-all", { method: "POST", headers: { authorization } });
    assert.equal(all.status, 200);
    assert.deepEqual(await all.json(), { data: 3 });

    const unauthorized = await fetch(baseUrl + "/api/v1/me/notifications");
    assert.equal(unauthorized.status, 401);
  }, {
    env: authEnv,
    store: {
      async listNotifications(args) { calls.push({ method: "listNotifications", args }); return [notification]; },
      async getUnreadNotificationCount(args) { calls.push({ method: "getUnreadNotificationCount", args }); return 4; },
      async markNotificationRead(args) { calls.push({ method: "markNotificationRead", args }); return { ...notification, readAt: "2026-01-02T00:00:00.000Z" }; },
      async markAllNotificationsRead(args) { calls.push({ method: "markAllNotificationsRead", args }); return 3; },
    },
  });

  assert.deepEqual(calls, [
    { method: "listNotifications", args: { actorId: "reader-user", limit: 10 } },
    { method: "getUnreadNotificationCount", args: { actorId: "reader-user" } },
    { method: "markNotificationRead", args: { notificationId: "ffffffff-ffff-4fff-8fff-ffffffffffff", actorId: "reader-user" } },
    { method: "markAllNotificationsRead", args: { actorId: "reader-user" } },
  ]);
});

test("REST notification inbox decodes a page cursor and refuses a malformed one", async () => {
  const calls: Array<{ method: string; args: Record<string, unknown> }> = [];
  const at = "2026-01-01T00:00:00.123Z";
  const id = "ffffffff-ffff-4fff-8fff-ffffffffffff";
  await withServer(async (baseUrl) => {
    const authorization = "Bearer " + signedToken("reader-user");
    const paged = await fetch(
      `${baseUrl}/api/v1/me/notifications?limit=5&cursor=${encodeURIComponent(encodeCursor(at, id))}`,
      { headers: { authorization } },
    );
    assert.equal(paged.status, 200);
    assert.deepEqual(await paged.json(), { data: [] });
    // The store sees the two halves of the sort key, not the client's base64.
    assert.deepEqual(calls.at(-1), { method: "listNotifications", args: { actorId: "reader-user", limit: 5, cursor: { at, id } } });

    // Without a cursor the request is the first page, exactly as before.
    const first = await fetch(`${baseUrl}/api/v1/me/notifications?limit=5`, { headers: { authorization } });
    assert.equal(first.status, 200);
    assert.deepEqual(calls.at(-1), { method: "listNotifications", args: { actorId: "reader-user", limit: 5 } });

    // A cursor half the API cannot compare is the client's mistake: 400, never a
    // database error surfacing as 500.
    for (const bad of [
      "not-a-cursor",
      encodeCursor("2026-01-01T00:00:00.123Z", "not-a-uuid"),
      encodeCursor("2026-01-01T00:00:00Z", id),
      Buffer.from("", "utf8").toString("base64url"),
    ]) {
      const response = await fetch(
        `${baseUrl}/api/v1/me/notifications?cursor=${encodeURIComponent(bad)}`,
        { headers: { authorization } },
      );
      assert.equal(response.status, 400, `cursor ${JSON.stringify(bad)} is rejected`);
      assert.deepEqual(await response.json(), {
        error: { code: "BAD_USER_INPUT", message: "Invalid cursor query parameter." },
      });
    }
    assert.equal(calls.filter((call) => call.method === "listNotifications").length, 2, "a refused cursor never reaches the store");

    // A cursor cannot select somebody else's inbox either: the actor is the token.
    const other = await fetch(
      `${baseUrl}/api/v1/me/notifications?cursor=${encodeURIComponent(encodeCursor(at, id))}`,
      { headers: { authorization: "Bearer " + signedToken("stranger-user") } },
    );
    assert.equal(other.status, 200);
    assert.deepEqual(calls.at(-1), { method: "listNotifications", args: { actorId: "stranger-user", limit: 50, cursor: { at, id } } });

    const unauthenticated = await fetch(
      `${baseUrl}/api/v1/me/notifications?cursor=${encodeURIComponent(encodeCursor(at, id))}`,
    );
    assert.equal(unauthenticated.status, 401);
  }, {
    env: authEnv,
    store: {
      async listNotifications(args) { calls.push({ method: "listNotifications", args }); return []; },
    },
  });
});

test("REST rejects duplicated query parameters before reading or writing route data", async () => {
  await withServer(async (baseUrl) => {
    const readResponse = await fetch(
      `${baseUrl}/api/v1/articles?locale=zh-CN&locale=zh-TW&limit=1&limit=100`,
    );
    assert.equal(readResponse.status, 400);
    assert.deepEqual(await readResponse.json(), {
      error: { code: "BAD_USER_INPUT", message: "Query parameters must not be repeated." },
    });
    assert.equal(readResponse.headers.get("connection"), "close");

    const writeResponse = await fetch(
      `${baseUrl}/api/v1/articles?locale=zh-CN&locale=zh-TW`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          slug: "duplicate-query-test",
          title: "Must not be written",
          contentBlocks: [],
          publish: false,
        }),
      },
    );
    assert.equal(writeResponse.status, 400);
    assert.deepEqual(await writeResponse.json(), {
      error: { code: "BAD_USER_INPUT", message: "Query parameters must not be repeated." },
    });
    assert.equal(writeResponse.headers.get("connection"), "close");
  });
});
