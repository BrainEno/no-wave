import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import test, { after, before } from "node:test";
import { createPostgresClient, createPostgresStore } from "./postgres.mjs";
import { ConversationAccessError, IdempotencyConflictError } from "../domain/errors.mjs";
import { runMigrations } from "./migrate.mjs";
import { dispatchOutboxBatch } from "./outbox-worker.mjs";

const connectionString = process.env.TEST_DATABASE_URL;
const integrationOptions = { skip: !connectionString && "Set TEST_DATABASE_URL to run PostgreSQL integration tests." };
let sql;
let store;

before(async () => {
  if (!connectionString) return;
  sql = await createPostgresClient({ connectionString, max: 4 });
  await runMigrations(sql);
  store = createPostgresStore(sql);
});
after(async () => { if (sql) await sql.end({ timeout: 5 }); });

test("migrations are repeatable and record applied versions once", integrationOptions, async () => {
  const first = await runMigrations(sql);
  const second = await runMigrations(sql);
  assert.equal(first.discovered, 8);
  assert.equal(second.applied.length, 0);
  const rows = await sql.unsafe("SELECT version FROM api_schema_migrations WHERE version IN ($1, $2, $3, $4, $5, $6, $7, $8)", ["0001_initial_domain_schema", "0002_article_content", "0003_author_profiles", "0004_article_engagement", "0005_article_taxonomies", "0006_conversation_lifecycle", "0007_user_follows", "0008_literary_work_types_and_zh_cn"]);
  assert.deepEqual(rows.map((row) => row.version).sort(), ["0001_initial_domain_schema", "0002_article_content", "0003_author_profiles", "0004_article_engagement", "0005_article_taxonomies", "0006_conversation_lifecycle", "0007_user_follows", "0008_literary_work_types_and_zh_cn"]);
});

test("message write, outbox intent and idempotency are atomic", integrationOptions, async () => {
  const suffix = randomUUID();
  const conversationId = `it-conversation-${suffix}`;
  const senderId = `it-sender-${suffix}`;
  const idempotencyKey = `it-key-${suffix}`;
  await sql.unsafe("INSERT INTO conversations (id) VALUES ($1)", [conversationId]);
  await sql.unsafe("INSERT INTO conversation_participants (conversation_id, user_id) VALUES ($1, $2)", [conversationId, senderId]);
  try {
    const input = { conversationId, senderId, body: "persist me", idempotencyKey };
    const first = await store.persistMessage(input);
    const retry = await store.persistMessage(input);
    assert.equal(first.duplicate, false);
    assert.equal(retry.duplicate, true);
    assert.equal(retry.id, first.id);
    const messages = await sql.unsafe("SELECT id FROM messages WHERE sender_id = $1 AND idempotency_key = $2", [senderId, idempotencyKey]);
    const events = await sql.unsafe("SELECT id FROM outbox_events WHERE event_key = $1", [`message:${first.id}`]);
    assert.equal(messages.length, 1);
    assert.equal(events.length, 1);
    await assert.rejects(store.persistMessage({ ...input, body: "different payload" }), IdempotencyConflictError);
  } finally {
    await sql.unsafe("DELETE FROM outbox_events WHERE aggregate_id IN (SELECT id::text FROM messages WHERE conversation_id = $1)", [conversationId]);
    await sql.unsafe("DELETE FROM conversations WHERE id = $1", [conversationId]);
  }
});

test("message persistence rejects senders who are not conversation participants", integrationOptions, async () => {
  const suffix = randomUUID();
  const conversationId = `it-private-${suffix}`;
  await sql.unsafe("INSERT INTO conversations (id) VALUES ($1)", [conversationId]);
  try {
    await assert.rejects(store.persistMessage({
      conversationId, senderId: `not-a-member-${suffix}`, body: "must not persist", idempotencyKey: `key-${suffix}`,
    }), ConversationAccessError);
    const rows = await sql.unsafe("SELECT id FROM messages WHERE conversation_id = $1", [conversationId]);
    assert.equal(rows.length, 0);
  } finally {
    await sql.unsafe("DELETE FROM outbox_events WHERE aggregate_id IN (SELECT id::text FROM messages WHERE conversation_id = $1)", [conversationId]);
    await sql.unsafe("DELETE FROM conversations WHERE id = $1", [conversationId]);
  }
});

test("notification inbox is durable and deduplicates event retries", integrationOptions, async () => {
  const userId = `it-user-${randomUUID()}`;
  const eventKey = `it-event-${randomUUID()}`;
  const payload = { type: "message.created", messageId: randomUUID() };
  const first = await store.createNotification({ userId, eventKey, payload });
  const retry = await store.createNotification({ userId, eventKey, payload });
  try {
    assert.deepEqual(first.payload, payload);
    assert.deepEqual(retry.payload, payload);
    assert.equal(first.duplicate, false);
    assert.equal(retry.duplicate, true);
    assert.equal(retry.id, first.id);
    await assert.rejects(store.createNotification({ userId, eventKey, payload: { type: "different" } }), IdempotencyConflictError);
    const rows = await sql.unsafe("SELECT id FROM notifications WHERE user_id = $1 AND event_key = $2", [userId, eventKey]);
    assert.equal(rows.length, 1);
  } finally {
    await sql.unsafe("DELETE FROM notifications WHERE user_id = $1 AND event_key = $2", [userId, eventKey]);
  }
});

test("session revocation survives store operations until expiry", integrationOptions, async () => {
  const sessionId = `it-session-${randomUUID()}`;
  try {
    assert.equal(await store.isSessionRevoked(sessionId), false);
    await store.revokeSession({ sessionId, expiresAt: new Date(Date.now() + 60_000) });
    assert.equal(await store.isSessionRevoked(sessionId), true);
  } finally {
    await sql.unsafe("DELETE FROM revoked_sessions WHERE session_id = $1", [sessionId]);
  }
});

test("explicit transactions roll back all writes when work fails", integrationOptions, async () => {
  const userId = `it-rollback-${randomUUID()}`;
  const eventKey = `it-event-${randomUUID()}`;
  await assert.rejects(store.transaction(async (tx) => {
    await tx.unsafe(
      "INSERT INTO notifications (id, user_id, event_key, payload, payload_hash) VALUES ($1, $2, $3, $4::jsonb, $5)",
      [randomUUID(), userId, eventKey, JSON.stringify({ type: "rollback" }), "0".repeat(64)],
    );
    throw new Error("intentional rollback probe");
  }), /intentional rollback probe/);
  const rows = await sql.unsafe("SELECT id FROM notifications WHERE user_id = $1 AND event_key = $2", [userId, eventKey]);
  assert.equal(rows.length, 0);
});

test("GraphQL message operations authorize database membership and derive sender from JWT", integrationOptions, async () => {
  const { createApiServer } = await import("../server.mjs");
  const secret = "integration-test-secret-that-is-at-least-32-bytes";
  const env = {
    AUTH_JWT_SECRET: secret,
    AUTH_JWT_ISSUER: "https://auth.integration.test",
    AUTH_JWT_AUDIENCE: "bot-thk-api",
  };
  const sign = (sub) => {
    const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const header = encode({ alg: "HS256", typ: "JWT" });
    const payload = encode({
      sub, iss: env.AUTH_JWT_ISSUER, aud: env.AUTH_JWT_AUDIENCE,
      exp: Math.floor(Date.now() / 1000) + 60,
      jti: `session-${sub}`,
    });
    const unsigned = `${header}.${payload}`;
    return `${unsigned}.${createHmac("sha256", secret).update(unsigned).digest("base64url")}`;
  };
  const suffix = randomUUID();
  const conversationId = `it-api-conversation-${suffix}`;
  const senderId = `it-api-sender-${suffix}`;
  const recipientId = `it-api-recipient-${suffix}`;
  const outsiderId = `it-api-outsider-${suffix}`;
  const server = createApiServer({ env, store });
  await sql.unsafe("INSERT INTO conversations (id) VALUES ($1)", [conversationId]);
  await sql.unsafe(
    "INSERT INTO conversation_participants (conversation_id, user_id) VALUES ($1, $2), ($1, $3)",
    [conversationId, senderId, recipientId],
  );
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const post = async (query, sub) => {
    const response = await fetch(`http://127.0.0.1:${address.port}/graphql`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${sign(sub)}` },
      body: JSON.stringify({ query }),
    });
    return response.json();
  };
  try {
    const spoofAttempt = await post(
      `mutation { sendMessage(conversationId: "${conversationId}", senderId: "attacker", body: "spoof", idempotencyKey: "spoof-${suffix}") { id senderId body } }`,
      senderId,
    );
    assert.ok(Array.isArray(spoofAttempt.errors), "senderId must not be an accepted mutation argument");
    const spoofRows = await sql.unsafe("SELECT id FROM messages WHERE conversation_id = $1", [conversationId]);
    assert.equal(spoofRows.length, 0);

    const sent = await post(
      `mutation { sendMessage(conversationId: "${conversationId}", body: "from verified identity", idempotencyKey: "api-${suffix}") { id senderId body } }`,
      senderId,
    );
    assert.deepEqual(sent.data.sendMessage, {
      id: sent.data.sendMessage.id, senderId, body: "from verified identity",
    });
    const conflictingRetry = await post(
      `mutation { sendMessage(conversationId: "${conversationId}", body: "different body", idempotencyKey: "api-${suffix}") { id senderId body } }`,
      senderId,
    );
    assert.equal(conflictingRetry.errors?.[0]?.extensions?.code, "IDEMPOTENCY_CONFLICT");
    const afterConflictMessages = await sql.unsafe("SELECT id FROM messages WHERE conversation_id = $1", [conversationId]);
    const afterConflictEvents = await sql.unsafe(
      "SELECT event_key FROM outbox_events WHERE aggregate_id IN (SELECT id::text FROM messages WHERE conversation_id = $1)",
      [conversationId],
    );
    assert.equal(afterConflictMessages.length, 1);
    assert.equal(afterConflictEvents.length, 1);

    const forbiddenRead = await post(`{ conversationMessages(conversationId: "${conversationId}") { id body } }`, outsiderId);
    assert.equal(forbiddenRead.data.conversationMessages, null);
    assert.equal(forbiddenRead.errors?.[0]?.extensions?.code, "FORBIDDEN");
    const allowedRead = await post(`{ conversationMessages(conversationId: "${conversationId}") { senderId body } }`, senderId);
    assert.equal(allowedRead.data.conversationMessages[0].senderId, senderId);
    assert.equal(allowedRead.data.conversationMessages[0].body, "from verified identity");

    const ownConversations = await post("{ conversations { id participantIds lastActivityAt lastMessage { id senderId body } } }", senderId);
    assert.equal(ownConversations.errors, undefined);
    assert.equal(ownConversations.data.conversations.length, 1);
    assert.deepEqual(ownConversations.data.conversations[0].participantIds, [recipientId, senderId].sort());
    assert.equal(ownConversations.data.conversations[0].lastMessage.body, "from verified identity");
    const outsiderConversations = await post("{ conversations { id } }", outsiderId);
    assert.deepEqual(outsiderConversations.data.conversations, []);

    const followUp = await post(
      `mutation { sendMessage(conversationId: "${conversationId}", body: "follow-up message", idempotencyKey: "follow-up-${suffix}") { id body } }`,
      senderId,
    );
    assert.equal(followUp.errors, undefined);
    const newestPage = await post(
      `{ conversationMessages(conversationId: "${conversationId}", limit: 1) { id body } }`,
      senderId,
    );
    assert.equal(newestPage.data.conversationMessages.length, 1);
    assert.equal(newestPage.data.conversationMessages[0].id, followUp.data.sendMessage.id);
    const olderPage = await post(
      `{ conversationMessages(conversationId: "${conversationId}", limit: 1, before: "${followUp.data.sendMessage.id}") { id body } }`,
      senderId,
    );
    assert.equal(olderPage.data.conversationMessages.length, 1);
    assert.equal(olderPage.data.conversationMessages[0].body, "from verified identity");
    const invalidCursor = await post(
      `{ conversationMessages(conversationId: "${conversationId}", before: "00000000-0000-0000-0000-000000000000") { id } }`,
      senderId,
    );
    assert.equal(invalidCursor.errors?.[0]?.extensions?.code, "BAD_USER_INPUT");
    const malformedCursor = await post(
      `{ conversationMessages(conversationId: "${conversationId}", before: "not-a-uuid") { id } }`,
      senderId,
    );
    assert.equal(malformedCursor.errors?.[0]?.extensions?.code, "BAD_USER_INPUT");
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await sql.unsafe("DELETE FROM outbox_events WHERE aggregate_id IN (SELECT id::text FROM messages WHERE conversation_id = $1)", [conversationId]);
    await sql.unsafe("DELETE FROM conversations WHERE id = $1", [conversationId]);
  }
});

test("GraphQL denies a JWT after its durable session ID is revoked", integrationOptions, async () => {
  const { createApiServer } = await import("../server.mjs");
  const secret = "revocation-integration-secret-at-least-32-bytes";
  const env = {
    AUTH_JWT_SECRET: secret,
    AUTH_JWT_ISSUER: "https://auth.integration.test",
    AUTH_JWT_AUDIENCE: "bot-thk-api",
  };
  const userId = `it-revoked-user-${randomUUID()}`;
  const sessionId = `it-revoked-session-${randomUUID()}`;
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const unsigned = `${encode({ alg: "HS256", typ: "JWT" })}.${encode({
    sub: userId, jti: sessionId, iss: env.AUTH_JWT_ISSUER, aud: env.AUTH_JWT_AUDIENCE,
    exp: Math.floor(Date.now() / 1000) + 60,
  })}`;
  const token = `${unsigned}.${createHmac("sha256", secret).update(unsigned).digest("base64url")}`;
  await store.revokeSession({ sessionId, expiresAt: new Date(Date.now() + 60_000) });
  const server = createApiServer({ env, store });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/graphql`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ query: "{ viewer { id } }" }),
    });
    const result = await response.json();
    assert.equal(result.data.viewer, null);
    assert.equal(result.errors?.[0]?.extensions?.code, "UNAUTHENTICATED");
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await sql.unsafe("DELETE FROM revoked_sessions WHERE session_id = $1", [sessionId]);
  }
});

test("outbox worker marks successful delivery and leases failed events for retry", integrationOptions, async () => {
  const suffix = randomUUID();
  const conversationId = `it-outbox-${suffix}`;
  const senderId = `it-outbox-sender-${suffix}`;
  await sql.unsafe("INSERT INTO conversations (id) VALUES ($1)", [conversationId]);
  await sql.unsafe("INSERT INTO conversation_participants (conversation_id, user_id) VALUES ($1, $2)", [conversationId, senderId]);
  try {
    const successMessage = await store.persistMessage({
      conversationId, senderId, body: "deliver me", idempotencyKey: `outbox-ok-${suffix}`,
    });
    const deliveredEvents = [];
    const success = await dispatchOutboxBatch({
      store,
      deliver: async (event) => deliveredEvents.push(event.event_key),
    });
    assert.deepEqual(success, { claimed: 1, delivered: 1, failed: 0 });
    assert.deepEqual(deliveredEvents, [`message:${successMessage.id}`]);
    const deliveredRows = await sql.unsafe(
      "SELECT delivered_at, attempts FROM outbox_events WHERE event_key = $1",
      [`message:${successMessage.id}`],
    );
    assert.equal(deliveredRows[0].delivered_at instanceof Date, true);
    assert.equal(deliveredRows[0].attempts, 1);

    const failedMessage = await store.persistMessage({
      conversationId, senderId, body: "retry me", idempotencyKey: `outbox-fail-${suffix}`,
    });
    const failure = await dispatchOutboxBatch({
      store,
      retryDelaySeconds: 60,
      deliver: async () => { throw new Error("simulated delivery failure"); },
    });
    assert.deepEqual(failure, { claimed: 1, delivered: 0, failed: 1 });
    const failedRows = await sql.unsafe(
      "SELECT delivered_at, attempts, available_at > now() AS deferred FROM outbox_events WHERE event_key = $1",
      [`message:${failedMessage.id}`],
    );
    assert.equal(failedRows[0].delivered_at, null);
    assert.equal(failedRows[0].attempts, 1);
    assert.equal(failedRows[0].deferred, true);
    assert.equal((await store.claimOutboxEvents()).length, 0);
  } finally {
    await sql.unsafe("DELETE FROM outbox_events WHERE aggregate_id IN (SELECT id::text FROM messages WHERE conversation_id = $1)", [conversationId]);
    await sql.unsafe("DELETE FROM conversations WHERE id = $1", [conversationId]);
  }
});

test("message idempotency lookup does not bypass conversation membership authorization", integrationOptions, async () => {
  const suffix = randomUUID();
  const allowedConversation = `it-idempotency-allowed-${suffix}`;
  const deniedConversation = `it-idempotency-denied-${suffix}`;
  const senderId = `it-idempotency-sender-${suffix}`;
  const key = `it-idempotency-key-${suffix}`;
  await sql.unsafe("INSERT INTO conversations (id) VALUES ($1), ($2)", [allowedConversation, deniedConversation]);
  await sql.unsafe("INSERT INTO conversation_participants (conversation_id, user_id) VALUES ($1, $2)", [allowedConversation, senderId]);
  try {
    await store.persistMessage({ conversationId: allowedConversation, senderId, body: "private", idempotencyKey: key });
    await assert.rejects(
      store.persistMessage({ conversationId: deniedConversation, senderId, body: "private", idempotencyKey: key }),
      ConversationAccessError,
    );
    const deniedRows = await sql.unsafe("SELECT id FROM messages WHERE conversation_id = $1", [deniedConversation]);
    assert.equal(deniedRows.length, 0);
  } finally {
    await sql.unsafe("DELETE FROM outbox_events WHERE aggregate_id IN (SELECT id::text FROM messages WHERE conversation_id IN ($1, $2))", [allowedConversation, deniedConversation]);
    await sql.unsafe("DELETE FROM conversations WHERE id IN ($1, $2)", [allowedConversation, deniedConversation]);
  }
});


test("GraphQL notification inbox is scoped to the verified actor and read state cannot be changed by another user", integrationOptions, async () => {
  const { createApiServer } = await import("../server.mjs");
  const secret = "notification-integration-secret-at-least-32-bytes";
  const env = {
    AUTH_JWT_SECRET: secret,
    AUTH_JWT_ISSUER: "https://auth.integration.test",
    AUTH_JWT_AUDIENCE: "bot-thk-api",
  };
  const ownerId = `it-notification-owner-${randomUUID()}`;
  const outsiderId = `it-notification-outsider-${randomUUID()}`;
  const ownerEventKey = `it-notification-owner-event-${randomUUID()}`;
  const ownerSecondEventKey = `it-notification-owner-event-second-${randomUUID()}`;
  const outsiderEventKey = `it-notification-outsider-event-${randomUUID()}`;
  const ownerNotification = await store.createNotification({
    userId: ownerId, eventKey: ownerEventKey, payload: { type: "message.created", private: "owner-only" },
  });
  await store.createNotification({
    userId: ownerId, eventKey: ownerSecondEventKey, payload: { type: "message.created", private: "owner-only-second" },
  });
  const outsiderNotification = await store.createNotification({
    userId: outsiderId, eventKey: outsiderEventKey, payload: { type: "message.created", private: "outsider-only" },
  });
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const sign = (sub) => {
    const unsigned = `${encode({ alg: "HS256", typ: "JWT" })}.${encode({
      sub, iss: env.AUTH_JWT_ISSUER, aud: env.AUTH_JWT_AUDIENCE,
      exp: Math.floor(Date.now() / 1000) + 60, jti: `session-${sub}`,
    })}`;
    return `${unsigned}.${createHmac("sha256", secret).update(unsigned).digest("base64url")}`;
  };
  const server = createApiServer({ env, store });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const post = async (query, sub) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/graphql`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${sign(sub)}` },
      body: JSON.stringify({ query }),
    });
    return response.json();
  };
  try {
    const inbox = await post("{ notifications { id eventKey payload readAt } }", ownerId);
    assert.equal(inbox.errors, undefined);
    assert.deepEqual(inbox.data.notifications.map((item) => item.eventKey).sort(), [ownerEventKey, ownerSecondEventKey].sort());
    assert.match(inbox.data.notifications.find((item) => item.eventKey === ownerEventKey).payload, /owner-only/);
    const initialUnread = await post("{ unreadNotificationCount }", ownerId);
    assert.equal(initialUnread.data.unreadNotificationCount, 2);
    const outsiderInbox = await post("{ notifications { eventKey } unreadNotificationCount }", outsiderId);
    assert.deepEqual(outsiderInbox.data.notifications.map((item) => item.eventKey), [outsiderEventKey]);
    assert.equal(outsiderInbox.data.unreadNotificationCount, 1);

    const malformedNotificationId = await post(
      'mutation { markNotificationRead(notificationId: "not-a-uuid") { id readAt } }',
      ownerId,
    );
    assert.equal(malformedNotificationId.errors?.[0]?.extensions?.code, "BAD_USER_INPUT");

    const forbiddenMark = await post(
      `mutation { markNotificationRead(notificationId: "${ownerNotification.id}") { id readAt } }`,
      outsiderId,
    );
    assert.equal(forbiddenMark.errors, undefined);
    assert.equal(forbiddenMark.data.markNotificationRead, null);
    const stillUnread = await sql.unsafe("SELECT read_at FROM notifications WHERE id = $1", [ownerNotification.id]);
    assert.equal(stillUnread[0].read_at, null);

    const marked = await post(
      `mutation { markNotificationRead(notificationId: "${ownerNotification.id}") { id readAt } }`,
      ownerId,
    );
    assert.equal(marked.errors, undefined);
    assert.equal(marked.data.markNotificationRead.id, ownerNotification.id);
    assert.equal(typeof marked.data.markNotificationRead.readAt, "string");
    const batchMarked = await post("mutation { markAllNotificationsRead }", ownerId);
    assert.equal(batchMarked.data.markAllNotificationsRead, 1);
    const noUnread = await post("{ unreadNotificationCount }", ownerId);
    assert.equal(noUnread.data.unreadNotificationCount, 0);
    const remaining = await sql.unsafe(
      "SELECT read_at FROM notifications WHERE user_id = $1 AND event_key = $2",
      [ownerId, ownerSecondEventKey],
    );
    assert.equal(remaining[0].read_at instanceof Date, true);
    const again = await post(
      `mutation { markNotificationRead(notificationId: "${ownerNotification.id}") { id readAt } }`,
      ownerId,
    );
    assert.equal(again.data.markNotificationRead.readAt, marked.data.markNotificationRead.readAt);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await sql.unsafe("DELETE FROM notifications WHERE (user_id = $1 AND event_key IN ($2, $3)) OR (user_id = $4 AND event_key = $5)", [ownerId, ownerEventKey, ownerSecondEventKey, outsiderId, outsiderEventKey]);
  }
});


test("follow graph is idempotent, searchable, localized and creates a notification once", integrationOptions, async () => {
  const followerId = `it-following-${randomUUID()}`;
  const targetId = `it-followed-${randomUUID()}`;
  try {
    await store.upsertAuthorProfile({ userId: followerId, displayName: "跟隨者", bio: "中文簡介", locale: "zh-TW" });
    await store.upsertAuthorProfile({ userId: followerId, displayName: "Follower", bio: "English bio", locale: "en" });
    await store.upsertAuthorProfile({ userId: targetId, displayName: "創作者", bio: "目標簡介", locale: "zh-TW" });
    await store.upsertAuthorProfile({ userId: targetId, displayName: "Creator", bio: "Target biography", locale: "en" });

    assert.equal(await store.followUser({ actorId: followerId, targetUserId: targetId }), true);
    assert.equal(await store.followUser({ actorId: followerId, targetUserId: targetId }), false);
    const ownProfile = await store.getAuthorProfile({ userId: followerId, locale: "en", viewerId: followerId });
    const targetProfile = await store.getAuthorProfile({ userId: targetId, locale: "en", viewerId: followerId });
    assert.equal(ownProfile.followingCount, 1);
    assert.equal(targetProfile.followerCount, 1);
    assert.equal(targetProfile.isFollowing, true);
    assert.equal((await store.getAuthorProfile({ userId: targetId, locale: "zh-TW", viewerId: targetId })).isFollowing, false);
    assert.equal((await store.listFollowing({ userId: followerId, locale: "en", viewerId: followerId }))[0].displayName, "Creator");
    assert.equal((await store.listFollowers({ userId: targetId, locale: "en", viewerId: targetId }))[0].displayName, "Follower");
    assert.equal((await store.searchUsers({ query: "creat", locale: "en", viewerId: followerId }))[0].isFollowing, true);
    assert.equal((await store.searchUsers({ query: "創作者", locale: "zh-TW", viewerId: targetId })).length, 1);
    const followNotifications = await sql.unsafe(
      "SELECT id, payload FROM notifications WHERE user_id = $1 AND payload->>'type' = 'user.followed' AND payload->>'followerId' = $2",
      [targetId, followerId],
    );
    assert.equal(followNotifications.length, 1);
    const notificationPayload = typeof followNotifications[0].payload === "string"
      ? JSON.parse(followNotifications[0].payload)
      : followNotifications[0].payload;
    assert.deepEqual(notificationPayload, { type: "user.followed", followerId });

    await assert.rejects(store.followUser({ actorId: followerId, targetUserId: followerId }), { code: "BAD_USER_INPUT" });
    await assert.rejects(store.followUser({ actorId: followerId, targetUserId: "missing-profile" }), { code: "NOT_FOUND" });
    assert.equal(await store.unfollowUser({ actorId: followerId, targetUserId: targetId }), true);
    assert.equal(await store.unfollowUser({ actorId: followerId, targetUserId: targetId }), false);
    assert.equal((await store.getAuthorProfile({ userId: targetId, locale: "en", viewerId: followerId })).isFollowing, false);
    assert.equal((await store.getAuthorProfile({ userId: targetId, locale: "en" })).followerCount, 0);
  } finally {
    await sql.unsafe("DELETE FROM user_follows WHERE follower_id IN ($1, $2) OR followed_id IN ($1, $2)", [followerId, targetId]);
    await sql.unsafe("DELETE FROM notifications WHERE user_id = $1 AND payload->>'followerId' = $2", [targetId, followerId]);
    await sql.unsafe("DELETE FROM user_profiles WHERE user_id IN ($1, $2)", [followerId, targetId]);
  }
});

test("author profiles keep per-locale display text and share validated account links", integrationOptions, async () => {
  const userId = `it-profile-${randomUUID()}`;
  try {
    const chinese = await store.upsertAuthorProfile({
      userId,
      displayName: "作者名稱",
      bio: "繁體中文簡介",
      avatarUrl: "/avatars/profile.webp",
      websiteUrl: "https://example.test/profile",
      locale: "zh-TW",
    });
    const english = await store.upsertAuthorProfile({
      userId,
      displayName: "Author Name",
      bio: "English profile biography",
      locale: "en",
    });
    assert.equal(chinese.displayName, "作者名稱");
    assert.equal(english.displayName, "Author Name");
    assert.equal((await store.getAuthorProfile({ userId, locale: "zh-TW" })).bio, "繁體中文簡介");
    assert.equal(english.avatarUrl, "/avatars/profile.webp");
    assert.equal(english.websiteUrl, "https://example.test/profile");
    await assert.rejects(
      store.upsertAuthorProfile({
        userId: `${userId}-bad`, displayName: "Bad URL", locale: "en",
        avatarUrl: "javascript:alert(1)",
      }),
      { code: "BAD_USER_INPUT" },
    );
    const updated = await store.upsertAuthorProfile({
      userId, displayName: "Author Renamed", bio: "Updated", locale: "en",
      avatarUrl: null, websiteUrl: null,
    });
    assert.equal(updated.avatarUrl, null);
    assert.equal(updated.websiteUrl, null);
    assert.equal((await store.getAuthorProfile({ userId, locale: "zh-TW" })).displayName, "作者名稱");
  } finally {
    await sql.unsafe("DELETE FROM user_profiles WHERE user_id LIKE $1", [userId + "%"]);
  }
});

test("article CRUD preserves author ownership, publish visibility and locale separation", integrationOptions, async () => {
  const ownerId = `it-article-owner-${randomUUID()}`;
  const outsiderId = `it-article-outsider-${randomUUID()}`;
  const slug = `it-article-${randomUUID().replaceAll("-", "")}`;
  const contentBlocks = [
    { id: "intro", type: "paragraph", text: "A testable article body." },
    { id: "next", type: "heading", level: 2, text: "Next section" }
  ];
  let article;
  try {
    article = await store.createArticle({
      authorId: ownerId, slug, title: "Draft title", summary: "Draft summary",
      locale: "en", workType: "poetry", contentBlocks, publish: false,
    });
    assert.equal(article.status, "draft");
    assert.equal(article.workType, "poetry");
    assert.deepEqual(article.contentBlocks, contentBlocks);
    assert.equal(article.publishedAt, null);
    assert.equal((await store.getPublishedArticle({ slug, locale: "en" })), null);
    assert.equal((await store.listPublishedArticles({ locale: "en", query: slug })).length, 0);
    assert.equal((await store.listMyArticles({ actorId: ownerId, locale: "en" })).length, 1);
    assert.equal((await store.listMyArticles({ actorId: outsiderId, locale: "en" })).length, 0);

    await assert.rejects(
      store.updateArticle({
        articleId: article.id, actorId: outsiderId, slug, title: "Hijacked", summary: "",
        locale: "en", contentBlocks, publish: true,
      }),
      { code: "FORBIDDEN" },
    );
    const afterDeniedUpdate = await store.getPublishedArticle({ slug, locale: "en" });
    assert.equal(afterDeniedUpdate, null);

    const published = await store.updateArticle({
      articleId: article.id, actorId: ownerId, slug, title: "Published title", summary: "Visible summary",
      locale: "en", contentBlocks, publish: true,
    });
    assert.equal(published.status, "published");
    assert.ok(published.publishedAt);
    assert.equal(published.title, "Published title");
    assert.equal(published.workType, "poetry");
    assert.equal((await store.getPublishedArticle({ slug, locale: "en" })).id, article.id);
    assert.equal((await store.getPublishedArticle({ slug, locale: "zh-TW" })), null);
    assert.equal((await store.listPublishedArticles({ locale: "en", query: "Published title" })).length, 1);

    await assert.rejects(
      store.createArticle({
        authorId: ownerId, slug, title: "Duplicate slug", summary: "",
        locale: "en", contentBlocks, publish: true,
      }),
      { code: "CONFLICT" },
    );
    await assert.rejects(
      store.createArticle({
        authorId: ownerId, slug: "bad slug", title: "Invalid", summary: "",
        locale: "en", contentBlocks, publish: true,
      }),
      { code: "BAD_USER_INPUT" },
    );
    await assert.rejects(
      store.createArticle({
        authorId: ownerId, slug: `${slug}-malformed`, title: "Invalid body", summary: "",
        locale: "en", contentBlocks: [{ id: "bad", type: "unsupported" }], publish: true,
      }),
      { code: "BAD_USER_INPUT" },
    );
  } finally {
    if (article) {
      await sql.unsafe("DELETE FROM notifications WHERE payload->>'articleId' = $1", [article.id]);
      await sql.unsafe("DELETE FROM articles WHERE id = $1", [article.id]);
    }
  }
});

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

    const firstPage = await store.listPublishedArticles({ locale: "en", query: searchTerm, limit: 2, offset: 0 });
    const secondPage = await store.listPublishedArticles({ locale: "en", query: searchTerm, limit: 2, offset: 2 });
    assert.deepEqual(firstPage.map((item) => item.id), articles.slice().reverse().slice(0, 2).map((item) => item.id));
    assert.deepEqual(secondPage.map((item) => item.id), [articles[0].id]);
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

test("GraphQL article mutations derive authors from JWT and protect updates", integrationOptions, async () => {
  const { createApiServer } = await import("../server.mjs");
  const secret = "article-integration-secret-is-at-least-32-bytes";
  const env = {
    AUTH_JWT_SECRET: secret,
    AUTH_JWT_ISSUER: "https://auth.integration.test",
    AUTH_JWT_AUDIENCE: "bot-thk-api",
  };
  const ownerId = `it-article-api-owner-${randomUUID()}`;
  const outsiderId = `it-article-api-outsider-${randomUUID()}`;
  const slug = `it-article-api-${randomUUID().replaceAll("-", "")}`;
  const blocks = JSON.stringify([{ id: "intro", type: "paragraph", text: "Persisted through GraphQL." }]);
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const sign = (sub) => {
    const unsigned = `${encode({ alg: "HS256", typ: "JWT" })}.${encode({
      sub, iss: env.AUTH_JWT_ISSUER, aud: env.AUTH_JWT_AUDIENCE,
      exp: Math.floor(Date.now() / 1000) + 60, jti: `session-${sub}`,
    })}`;
    return `${unsigned}.${createHmac("sha256", secret).update(unsigned).digest("base64url")}`;
  };
  const server = createApiServer({ env, store });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const post = async (query, sub) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/graphql`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${sign(sub)}` },
      body: JSON.stringify({ query }),
    });
    return response.json();
  };
  let articleId = null;
  try {
    const updatedProfile = await post(
      'mutation { updateMyProfile(displayName: "Article Owner", bio: "Profile bio", locale: "en", avatarUrl: "/avatars/owner.webp") { userId displayName locale avatarUrl } }',
      ownerId,
    );
    assert.equal(updatedProfile.errors, undefined);
    assert.deepEqual(updatedProfile.data.updateMyProfile, {
      userId: ownerId, displayName: "Article Owner", locale: "en", avatarUrl: "/avatars/owner.webp",
    });
    const ownProfile = await post('{ viewerProfile(locale: "en") { userId displayName } }', ownerId);
    assert.equal(ownProfile.data.viewerProfile.displayName, "Article Owner");

    const created = await post(
      `mutation { createArticle(slug: "${slug}", title: "API article", summary: "summary", locale: "en", contentBlocks: ${JSON.stringify(blocks)}, publish: true) { id authorId slug status title } }`,
      ownerId,
    );
    assert.equal(created.errors, undefined);
    assert.equal(created.data.createArticle.authorId, ownerId);
    assert.equal(created.data.createArticle.status, "published");
    articleId = created.data.createArticle.id;
    const foreignUpdate = await post(
      `mutation { updateArticle(articleId: "${articleId}", slug: "${slug}", title: "hijack", summary: "", locale: "en", contentBlocks: ${JSON.stringify(blocks)}, publish: true) { id title } }`,
      outsiderId,
    );
    assert.equal(foreignUpdate.errors?.[0]?.extensions?.code, "FORBIDDEN");
    const publicArticle = await post(`{ article(slug: "${slug}", locale: "en") { id title authorId author { userId displayName bio avatarUrl } } }`, outsiderId);
    assert.equal(publicArticle.data.article.title, "API article");
    assert.deepEqual(publicArticle.data.article.author, {
      userId: ownerId, displayName: "Article Owner", bio: "Profile bio", avatarUrl: "/avatars/owner.webp",
    });
    const publicProfile = await post(`{ authorProfile(userId: "${ownerId}", locale: "en") { displayName userId } }`, outsiderId);
    assert.equal(publicProfile.data.authorProfile.displayName, "Article Owner");
    const privateDraft = await post(
      `mutation { createArticle(slug: "${slug}-draft", title: "Private draft", locale: "en", contentBlocks: ${JSON.stringify(blocks)}) { id status } }`,
      ownerId,
    );
    assert.equal(privateDraft.errors, undefined);
    const draftId = privateDraft.data.createArticle.id;
    const hiddenDraft = await post(`{ article(slug: "${slug}-draft", locale: "en") { id } }`, outsiderId);
    assert.equal(hiddenDraft.data.article, null);
    const ownedDrafts = await post(`{ myArticles(locale: "en") { id status title } }`, ownerId);
    assert.equal(ownedDrafts.errors, undefined);
    assert.ok(ownedDrafts.data.myArticles.some((item) => item.id === draftId && item.status === "draft"));
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await sql.unsafe("DELETE FROM articles WHERE author_id IN ($1, $2) AND slug LIKE $3", [ownerId, outsiderId, "it-article-api-%"]);
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
      actorId: creatorId, kind: "category", slug, name: "工程", description: "繁體中文分類", locale: "zh-TW",
    });
    const englishCategory = await store.createTaxonomy({
      actorId: creatorId, kind: "category", slug, name: "Engineering", description: "English category", locale: "en",
    });
    tag = await store.createTaxonomy({
      actorId: creatorId, kind: "tag", slug, name: "Web", locale: "en",
    });
    assert.equal(category.id, englishCategory.id);
    assert.equal(englishCategory.name, "Engineering");
    assert.equal((await store.listTaxonomies({ kind: "category", locale: "zh-TW" })).some((item) => item.id === category.id && item.name === "工程"), true);
    await assert.rejects(
      store.createTaxonomy({ actorId: outsiderId, kind: "category", slug, name: "Hijack", locale: "en" }),
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


test("GraphQL taxonomy APIs derive creators from JWT and expose localized article associations", integrationOptions, async () => {
  const { createApiServer } = await import("../server.mjs");
  const secret = "taxonomy-graphql-secret-at-least-32-bytes-long";
  const env = {
    AUTH_JWT_SECRET: secret,
    AUTH_JWT_ISSUER: "https://auth.integration.test",
    AUTH_JWT_AUDIENCE: "bot-thk-api",
  };
  const ownerId = `it-tax-gql-owner-${randomUUID()}`;
  const outsiderId = `it-tax-gql-outsider-${randomUUID()}`;
  const suffix = randomUUID().replaceAll("-", "");
  const categorySlug = `it-gql-cat-${suffix}`;
  const tagSlug = `it-gql-tag-${suffix}`;
  const articleSlug = `it-gql-article-${suffix}`;
  const hashtagName = `繁體中文${suffix.slice(0, 10)}`;
  let generatedHashtagId = null;
  const blocks = JSON.stringify([{ id: "intro", type: "paragraph", text: "Categorized article body." }]);
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const sign = (sub) => {
    const unsigned = `${encode({ alg: "HS256", typ: "JWT" })}.${encode({
      sub, iss: env.AUTH_JWT_ISSUER, aud: env.AUTH_JWT_AUDIENCE,
      exp: Math.floor(Date.now() / 1000) + 60, jti: `session-${sub}`,
    })}`;
    return `${unsigned}.${createHmac("sha256", secret).update(unsigned).digest("base64url")}`;
  };
  const server = createApiServer({ env, store });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const post = async (query, sub) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/graphql`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${sign(sub)}` },
      body: JSON.stringify({ query }),
    });
    return response.json();
  };
  let articleId = null;
  let categoryId = null;
  let tagId = null;
  try {
    const createdCategory = await post(
      `mutation { createTaxonomy(kind: "category", slug: "${categorySlug}", name: "工程", locale: "zh-TW") { id kind slug name locale createdBy } }`,
      ownerId,
    );
    assert.equal(createdCategory.errors, undefined);
    categoryId = createdCategory.data.createTaxonomy.id;
    assert.equal(createdCategory.data.createTaxonomy.createdBy, ownerId);
    const translatedCategory = await post(
      `mutation { createTaxonomy(kind: "category", slug: "${categorySlug}", name: "Engineering", locale: "en") { id name locale } }`,
      ownerId,
    );
    assert.equal(translatedCategory.data.createTaxonomy.id, categoryId);
    const createdTag = await post(
      `mutation { createTaxonomy(kind: "tag", slug: "${tagSlug}", name: "Web", locale: "en") { id kind slug name } }`,
      ownerId,
    );
    assert.equal(createdTag.errors, undefined);
    tagId = createdTag.data.createTaxonomy.id;

    const createdHashtag = await post(
      `mutation { createTag(name: "#${hashtagName}", locale: "zh-TW") { id kind slug name createdBy } }`,
      outsiderId,
    );
    assert.equal(createdHashtag.errors, undefined);
    assert.equal(createdHashtag.data.createTag.kind, "tag");
    assert.equal(createdHashtag.data.createTag.name, hashtagName);
    assert.equal(createdHashtag.data.createTag.createdBy, outsiderId);
    generatedHashtagId = createdHashtag.data.createTag.id;
    const reusedHashtag = await post(
      `mutation { createTag(name: "${hashtagName}", locale: "zh-TW") { id name createdBy } }`,
      ownerId,
    );
    assert.equal(reusedHashtag.errors, undefined);
    assert.equal(reusedHashtag.data.createTag.id, createdHashtag.data.createTag.id);

    const createdArticle = await post(
      `mutation { createArticle(slug: "${articleSlug}", title: "Taxonomy article", locale: "en", contentBlocks: ${JSON.stringify(blocks)}, publish: true, categoryIds: ["${categoryId}"], tagIds: ["${tagId}"]) { id slug categories { id name kind } tags { id name kind } } }`,
      ownerId,
    );
    assert.equal(createdArticle.errors, undefined);
    articleId = createdArticle.data.createArticle.id;
    assert.deepEqual(createdArticle.data.createArticle.categories.map((item) => item.name), ["Engineering"]);
    assert.deepEqual(createdArticle.data.createArticle.tags.map((item) => item.name), ["Web"]);

    const categoryArticles = await post(
      `{ taxonomyArticles(kind: "category", slug: "${categorySlug}", locale: "en") { slug categories { name } } }`,
      outsiderId,
    );
    assert.equal(categoryArticles.errors, undefined);
    assert.equal(categoryArticles.data.taxonomyArticles[0].slug, articleSlug);
    const list = await post(`{ taxonomies(kind: "category", locale: "en", query: "engineer") { id name articleCount } }`, outsiderId);
    assert.equal(list.errors, undefined);
    assert.deepEqual(list.data.taxonomies, [{ id: categoryId, name: "Engineering", articleCount: 1 }]);
    const publicTag = await post(`{ taxonomy(kind: "tag", slug: "${tagSlug}", locale: "en") { id kind slug name articleCount } }`, outsiderId);
    assert.equal(publicTag.errors, undefined);
    assert.deepEqual(publicTag.data.taxonomy, {
      id: tagId, kind: "tag", slug: tagSlug, name: "Web", articleCount: 1,
    });

    const foreignDelete = await post(`mutation { deleteTaxonomy(taxonomyId: "${tagId}") }`, outsiderId);
    assert.equal(foreignDelete.errors?.[0]?.extensions?.code, "FORBIDDEN");
    const deletedByOwner = await post(`mutation { deleteTaxonomy(taxonomyId: "${tagId}") }`, ownerId);
    assert.equal(deletedByOwner.data.deleteTaxonomy, true);
    tagId = null;
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    if (articleId) await sql.unsafe("DELETE FROM articles WHERE id = $1", [articleId]);
    if (generatedHashtagId) await sql.unsafe("DELETE FROM taxonomies WHERE id = $1", [generatedHashtagId]);
    if (categoryId) await sql.unsafe("DELETE FROM taxonomies WHERE id = $1", [categoryId]);
    if (tagId) await sql.unsafe("DELETE FROM taxonomies WHERE id = $1", [tagId]);
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
      actorId: ownerId, kind: "category", slug: `${slugBase}-category`, name: "Discovery", locale: "en",
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
    assert.equal(likeNotices.length, 3);
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

test("GraphQL article likes and comments derive actor identity from JWT and enforce comment ownership", integrationOptions, async () => {
  const { createApiServer } = await import("../server.mjs");
  const secret = "article-engagement-secret-at-least-32-bytes";
  const env = {
    AUTH_JWT_SECRET: secret,
    AUTH_JWT_ISSUER: "https://auth.integration.test",
    AUTH_JWT_AUDIENCE: "bot-thk-api",
  };
  const ownerId = `it-engage-owner-${randomUUID()}`;
  const commenterId = `it-engage-commenter-${randomUUID()}`;
  const outsiderId = `it-engage-outsider-${randomUUID()}`;
  const slug = `it-engage-${randomUUID().replaceAll("-", "")}`;
  const blocks = JSON.stringify([{ id: "intro", type: "paragraph", text: "Engagement body." }]);
  const article = await store.createArticle({
    authorId: ownerId, slug, title: "Engagement article", locale: "en",
    contentBlocks: JSON.parse(blocks), publish: true,
  });
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const sign = (sub) => {
    const unsigned = `${encode({ alg: "HS256", typ: "JWT" })}.${encode({
      sub, iss: env.AUTH_JWT_ISSUER, aud: env.AUTH_JWT_AUDIENCE,
      exp: Math.floor(Date.now() / 1000) + 60, jti: `session-${sub}`,
    })}`;
    return `${unsigned}.${createHmac("sha256", secret).update(unsigned).digest("base64url")}`;
  };
  const server = createApiServer({ env, store });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const post = async (query, sub) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/graphql`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${sign(sub)}` },
      body: JSON.stringify({ query }),
    });
    return response.json();
  };
  try {
    const comment = await post(
      `mutation { createArticleComment(slug: "${slug}", locale: "en", content: "Hello from GraphQL") { id authorId content } }`,
      commenterId,
    );
    assert.equal(comment.errors, undefined);
    assert.equal(comment.data.createArticleComment.authorId, commenterId);
    const foreignDelete = await post(
      `mutation { deleteArticleComment(commentId: "${comment.data.createArticleComment.id}") }`,
      outsiderId,
    );
    assert.equal(foreignDelete.errors?.[0]?.extensions?.code, "FORBIDDEN");
    const liked = await post(`mutation { toggleArticleLike(slug: "${slug}", locale: "en") { likeCount likedByViewer } }`, commenterId);
    assert.deepEqual(liked.data.toggleArticleLike, { likeCount: 1, likedByViewer: true });
    const publicInfo = await post(`{ articleLikeInfo(slug: "${slug}", locale: "en") { likeCount likedByViewer } }`, outsiderId);
    assert.deepEqual(publicInfo.data.articleLikeInfo, { likeCount: 1, likedByViewer: false });
    const setTrue = await post(`mutation { setArticleLike(slug: "${slug}", locale: "en", liked: true) { likeCount likedByViewer } }`, commenterId);
    assert.deepEqual(setTrue.data.setArticleLike, { likeCount: 1, likedByViewer: true });
    const repeatedSetTrue = await post(`mutation { setArticleLike(slug: "${slug}", locale: "en", liked: true) { likeCount likedByViewer } }`, commenterId);
    assert.deepEqual(repeatedSetTrue.data.setArticleLike, { likeCount: 1, likedByViewer: true });
    const setFalse = await post(`mutation { setArticleLike(slug: "${slug}", locale: "en", liked: false) { likeCount likedByViewer } }`, commenterId);
    assert.deepEqual(setFalse.data.setArticleLike, { likeCount: 0, likedByViewer: false });
    const likeNotices = await sql.unsafe(
      "SELECT id, payload FROM notifications WHERE user_id = $1 AND payload->>'articleId' = $2 AND payload->>'type' = 'article.liked'",
      [ownerId, article.id],
    );
    assert.equal(likeNotices.length, 1);
    const deleted = await post(
      `mutation { deleteArticleComment(commentId: "${comment.data.createArticleComment.id}") }`,
      commenterId,
    );
    assert.equal(deleted.data.deleteArticleComment, true);
    const missingDraftComment = await post(
      `mutation { createArticleComment(slug: "${slug}-missing", locale: "en", content: "not here") { id } }`,
      commenterId,
    );
    assert.equal(missingDraftComment.errors?.[0]?.extensions?.code, "NOT_FOUND");
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await sql.unsafe("DELETE FROM notifications WHERE payload->>'articleId' = $1", [article.id]);
    await sql.unsafe("DELETE FROM articles WHERE id = $1", [article.id]);
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

    await store.updateConversationParticipants({
      conversationId: conversation.id, actorId: ownerId,
      addUserIds: [addId], removeUserIds: [recipientId],
    });
    assert.equal((await store.listConversations({ actorId: recipientId })).length, 0);
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

test("GraphQL follow mutations derive the follower from JWT and expose follow state", integrationOptions, async () => {
  const { createApiServer } = await import("../server.mjs");
  const secret = "follow-graphql-secret-at-least-32-bytes-long";
  const env = {
    AUTH_JWT_SECRET: secret,
    AUTH_JWT_ISSUER: "https://auth.integration.test",
    AUTH_JWT_AUDIENCE: "bot-thk-api",
  };
  const followerId = `it-follow-api-follower-${randomUUID()}`;
  const targetId = `it-follow-api-target-${randomUUID()}`;
  await store.upsertAuthorProfile({ userId: targetId, displayName: "Target User", locale: "en" });
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const sign = (sub) => {
    const unsigned = `${encode({ alg: "HS256", typ: "JWT" })}.${encode({
      sub, iss: env.AUTH_JWT_ISSUER, aud: env.AUTH_JWT_AUDIENCE,
      exp: Math.floor(Date.now() / 1000) + 60, jti: `session-${sub}`,
    })}`;
    return `${unsigned}.${createHmac("sha256", secret).update(unsigned).digest("base64url")}`;
  };
  const server = createApiServer({ env, store });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const post = async (query, sub) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/graphql`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${sign(sub)}` },
      body: JSON.stringify({ query }),
    });
    return response.json();
  };
  try {
    const follow = await post(`mutation { followUser(userId: "${targetId}", locale: "en") { userId isFollowing followerCount } }`, followerId);
    assert.equal(follow.errors, undefined);
    assert.deepEqual(follow.data.followUser, { userId: targetId, isFollowing: true, followerCount: 1 });
    const list = await post(`{ following(userId: "${followerId}", locale: "en") { userId displayName } }`, followerId);
    assert.deepEqual(list.data.following.map((user) => user.userId), [targetId]);
    const search = await post(`{ searchUsers(query: "target", locale: "en") { userId displayName isFollowing } }`, followerId);
    assert.equal(search.errors, undefined);
    assert.deepEqual(search.data.searchUsers, [{ userId: targetId, displayName: "Target User", isFollowing: true }]);
    const unfollow = await post(`mutation { unfollowUser(userId: "${targetId}", locale: "en") { isFollowing followerCount } }`, followerId);
    assert.deepEqual(unfollow.data.unfollowUser, { isFollowing: false, followerCount: 0 });
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await sql.unsafe("DELETE FROM user_follows WHERE follower_id IN ($1, $2) OR followed_id IN ($1, $2)", [followerId, targetId]);
    await sql.unsafe("DELETE FROM notifications WHERE user_id = $1 AND payload->>'followerId' = $2", [targetId, followerId]);
    await sql.unsafe("DELETE FROM user_profiles WHERE user_id IN ($1, $2)", [followerId, targetId]);
  }
});

test("GraphQL conversation lifecycle derives creator identity from JWT", integrationOptions, async () => {
  const { createApiServer } = await import("../server.mjs");
  const secret = "conversation-lifecycle-secret-at-least-32-bytes";
  const env = {
    AUTH_JWT_SECRET: secret,
    AUTH_JWT_ISSUER: "https://auth.integration.test",
    AUTH_JWT_AUDIENCE: "bot-thk-api",
  };
  const ownerId = `it-convo-api-owner-${randomUUID()}`;
  const recipientId = `it-convo-api-recipient-${randomUUID()}`;
  const outsiderId = `it-convo-api-outsider-${randomUUID()}`;
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const sign = (sub) => {
    const unsigned = `${encode({ alg: "HS256", typ: "JWT" })}.${encode({
      sub, iss: env.AUTH_JWT_ISSUER, aud: env.AUTH_JWT_AUDIENCE,
      exp: Math.floor(Date.now() / 1000) + 60, jti: `session-${sub}`,
    })}`;
    return `${unsigned}.${createHmac("sha256", secret).update(unsigned).digest("base64url")}`;
  };
  const server = createApiServer({ env, store });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const post = async (query, sub) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/graphql`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${sign(sub)}` },
      body: JSON.stringify({ query }),
    });
    return response.json();
  };
  let conversationId = null;
  try {
    const created = await post(
      `mutation { createConversation(participantIds: ["${recipientId}"]) { id createdBy participantIds unreadCount } }`,
      ownerId,
    );
    assert.equal(created.errors, undefined);
    conversationId = created.data.createConversation.id;
    assert.equal(created.data.createConversation.createdBy, ownerId);
    assert.ok(created.data.createConversation.participantIds.includes(ownerId));
    const marked = await post(`mutation { markConversationAsRead(conversationId: "${conversationId}") }`, recipientId);
    assert.equal(marked.data.markConversationAsRead, true);
    const foreignDelete = await post(`mutation { deleteConversation(conversationId: "${conversationId}") }`, outsiderId);
    assert.equal(foreignDelete.errors?.[0]?.extensions?.code, "FORBIDDEN");
    const updated = await post(
      `mutation { updateConversationParticipants(conversationId: "${conversationId}", addUserIds: ["${outsiderId}"]) { id participantIds } }`,
      ownerId,
    );
    assert.equal(updated.errors, undefined);
    assert.ok(updated.data.updateConversationParticipants.participantIds.includes(outsiderId));
    const deleted = await post(`mutation { deleteConversation(conversationId: "${conversationId}") }`, ownerId);
    assert.equal(deleted.data.deleteConversation, true);
    conversationId = null;
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    if (conversationId) await sql.unsafe("DELETE FROM conversations WHERE id = $1", [conversationId]);
  }
});

test("message outbox consumer creates deduplicated inbox notifications for other conversation participants", integrationOptions, async () => {
  const { createMessageNotificationDelivery } = await import("./message-notification-delivery.mjs");
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
