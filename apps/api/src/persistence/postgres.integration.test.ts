import assert from "node:assert/strict";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test, { after, before } from "node:test";
import { createPostgresClient, createPostgresStore } from "./postgres.ts";
import { ConversationAccessError, IdempotencyConflictError } from "../domain/errors.ts";
import { runMigrations } from "./migrate.ts";
import { dispatchOutboxBatch } from "./outbox-worker.ts";
import { createMessageNotificationDelivery } from "./message-notification-delivery.ts";

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
  assert.equal(first.discovered, 16);
  assert.equal(second.applied.length, 0);
  const versions = ["0001_initial_domain_schema", "0002_article_content", "0003_author_profiles", "0004_article_engagement", "0005_article_taxonomies", "0006_conversation_lifecycle", "0007_user_follows", "0008_literary_work_types_and_zh_cn", "0009_public_article_search_trigram_indexes", "0010_outbox_lease_tokens", "0011_self_hosted_identity", "0012_article_content_versions", "0013_comment_content_versions", "0014_provider_migration_journal", "0015_media_assets", "0016_article_comment_idempotency"];
  const rows = await sql.unsafe("SELECT version FROM api_schema_migrations WHERE version = ANY($1::text[])", [versions]);
  assert.deepEqual(rows.map((row) => row.version).sort(), versions);
});

test("PostgreSQL comment idempotency migration preserves existing comments", integrationOptions, async () => {
  const migration = await readFile(new URL("./migrations/0016_article_comment_idempotency.sql", import.meta.url), "utf8");
  const commentId = randomUUID();
  await sql.begin(async (tx) => {
    // A temporary legacy-shaped table verifies the migration adds nullable columns without dropping rows.
    await tx.unsafe("CREATE TEMP TABLE article_comments (id uuid PRIMARY KEY, author_id text NOT NULL) ON COMMIT DROP");
    await tx.unsafe("INSERT INTO article_comments (id, author_id) VALUES ($1, $2)", [commentId, "legacy-author"]);
    await tx.unsafe(migration);
    const rows = await tx.unsafe("SELECT idempotency_key_hash, request_hash FROM article_comments WHERE id = $1", [commentId]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].idempotency_key_hash, null);
    assert.equal(rows[0].request_hash, null);
    await assert.rejects(tx.unsafe(
      "INSERT INTO article_comments (id, author_id, idempotency_key_hash, request_hash) VALUES ($1, $2, $3, $4)",
      [randomUUID(), "legacy-author", "a".repeat(64), "b".repeat(64)],
    ).then(() => tx.unsafe(
      "INSERT INTO article_comments (id, author_id, idempotency_key_hash, request_hash) VALUES ($1, $2, $3, $4)",
      [randomUUID(), "legacy-author", "a".repeat(64), "c".repeat(64)],
    )));
  });
});

test("PostgreSQL media metadata persists normalized image fields and enforces ownership constraints", integrationOptions, async () => {
  const ownerId = randomUUID();
  const assetId = randomUUID();
  const email = "it-media-" + ownerId + "@example.test";
  await sql.unsafe("INSERT INTO auth_accounts (user_id, email, password_hash) VALUES ($1, $2, $3)", [ownerId, email, "integration-test-password-hash"]);
  try {
    const input = {
      id: assetId,
      ownerId,
      storageKey: "assets/" + ownerId + "/" + assetId + ".webp",
      contentType: "image/webp",
      byteSize: 1234,
      width: 400,
      height: 300,
      sha256: "a".repeat(64),
    };
    const created = await store.createMediaAsset(input);
    assert.deepEqual({
      id: created.id,
      ownerId: created.ownerId,
      storageKey: created.storageKey,
      contentType: created.contentType,
      byteSize: created.byteSize,
      width: created.width,
      height: created.height,
      sha256: created.sha256,
    }, input);
    assert.equal(typeof created.createdAt, "string");
    assert.deepEqual(await store.getMediaAsset({ id: assetId }), created);
    assert.equal(await store.getMediaAsset({ id: "not-a-uuid" }), null);
    await assert.rejects(store.createMediaAsset(input));
    await assert.rejects(sql.unsafe(
      "INSERT INTO media_assets (id, owner_id, storage_key, content_type, byte_size, width, height, sha256) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
      [randomUUID(), randomUUID(), "assets/missing-owner.webp", "image/webp", 10, 10, 10, "b".repeat(64)],
    ));
    assert.equal((await sql.unsafe("SELECT id FROM media_assets WHERE id = $1", [assetId])).length, 1);
  } finally {
    await sql.unsafe("DELETE FROM media_assets WHERE owner_id = $1", [ownerId]);
    await sql.unsafe("DELETE FROM auth_accounts WHERE user_id = $1", [ownerId]);
  }
});

test("PostgreSQL identity migration preserves legacy revocations and pending outbox rows", integrationOptions, async () => {
  const migration = await readFile(new URL("./migrations/0011_self_hosted_identity.sql", import.meta.url), "utf8");
  const schema = `identity_migration_${randomUUID().replaceAll("-", "")}`;
  const rollback = new Error("rollback disposable migration fixture");
  await assert.rejects(sql.begin(async (tx) => {
    // Transaction rollback removes this isolated test schema and all fixtures.
    await tx.unsafe(`CREATE SCHEMA ${schema}`);
    await tx.unsafe(`SET LOCAL search_path TO ${schema}`);
    await tx.unsafe("CREATE TABLE revoked_sessions (session_id text PRIMARY KEY, expires_at timestamptz NOT NULL)");
    await tx.unsafe("CREATE TABLE outbox_events (event_key text PRIMARY KEY, payload jsonb NOT NULL)");
    await tx.unsafe("INSERT INTO revoked_sessions VALUES ('legacy-token', '2099-01-01Z')");
    await tx.unsafe("INSERT INTO outbox_events VALUES ('legacy-pending', '{\"messageId\":\"legacy\"}'::jsonb)");
    await tx.unsafe(migration);
    assert.equal((await tx.unsafe("SELECT session_id FROM revoked_sessions WHERE session_id = 'legacy-token'")).length, 1);
    assert.equal((await tx.unsafe("SELECT event_key FROM outbox_events WHERE event_key = 'legacy-pending'")).length, 1);
    assert.equal((await tx.unsafe("SELECT user_id FROM auth_accounts")).length, 0);
    throw rollback;
  }), (error) => error === rollback);
});

test("PostgreSQL lease migration preserves legacy pending and delivered events", integrationOptions, async () => {
  const migration = await readFile(new URL("./migrations/0010_outbox_lease_tokens.sql", import.meta.url), "utf8");
  await sql.begin(async (tx) => {
    // A temporary legacy-shaped table shadows only this connection's table.
    await tx.unsafe(`CREATE TEMP TABLE outbox_events (
      event_key text PRIMARY KEY, attempts integer NOT NULL,
      available_at timestamptz NOT NULL, delivered_at timestamptz
    ) ON COMMIT DROP`);
    await tx.unsafe(`INSERT INTO outbox_events (event_key, attempts, available_at, delivered_at) VALUES
      ('pending', 2, '2000-01-01Z', NULL),
      ('leased', 3, '2999-01-01Z', NULL),
      ('delivered', 1, '2000-01-01Z', '2020-01-01Z')`);
    await tx.unsafe(migration);
    const rows = await tx.unsafe("SELECT event_key, attempts, delivered_at, lease_token FROM outbox_events ORDER BY event_key");
    assert.deepEqual(rows.map((row) => ({
      eventKey: row.event_key, attempts: row.attempts,
      delivered: row.delivered_at !== null, leaseToken: row.lease_token,
    })), [
      { eventKey: "delivered", attempts: 1, delivered: true, leaseToken: null },
      { eventKey: "leased", attempts: 3, delivered: false, leaseToken: null },
      { eventKey: "pending", attempts: 2, delivered: false, leaseToken: null },
    ]);
  });
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

for (const action of ["acknowledge", "reschedule"]) {
  test(`PostgreSQL checks lease expiry after a blocked ${action} acquires its row lock`, { ...integrationOptions, timeout: 10000 }, async () => {
    const eventId = randomUUID();
    await sql.unsafe(
      "INSERT INTO outbox_events (id, event_key, event_type, aggregate_id, payload) VALUES ($1, $2, 'test', 'test', '{}'::jsonb)",
      [eventId, `lease-lock-${eventId}`],
    );
    let unlock = () => {};
    let holding;
    try {
      const [lease] = await store.claimOutboxEvents({ limit: 1, leaseSeconds: 1 });
      assert.equal(lease.id, eventId);
      let signalLocked;
      const locked = new Promise((resolve) => { signalLocked = resolve; });
      const release = new Promise((resolve) => { unlock = resolve; });
      holding = sql.begin(async (tx) => {
        await tx.unsafe("SELECT id FROM outbox_events WHERE id = $1 FOR UPDATE", [eventId]);
        signalLocked();
        await release;
      });
      await locked;
      const change = action === "acknowledge"
        ? store.markOutboxDelivered({ eventId, leaseToken: lease.lease_token })
        : store.rescheduleOutboxEvent({ eventId, leaseToken: lease.lease_token });
      // Wait until this specific lease has expired while the other transaction
      // holds the row; PostgreSQL's clock is authoritative for its lease.
      await sql.unsafe(
        "SELECT pg_sleep(GREATEST(0, EXTRACT(EPOCH FROM available_at - clock_timestamp())) + 0.05) FROM outbox_events WHERE id = $1",
        [eventId],
      );
      unlock();
      assert.equal(await change, false);
      await holding;
      const [row] = await sql.unsafe("SELECT delivered_at, lease_token FROM outbox_events WHERE id = $1", [eventId]);
      assert.equal(row.delivered_at, null);
      assert.equal(row.lease_token, lease.lease_token);
    } finally {
      unlock();
      if (holding) await holding;
      await sql.unsafe("DELETE FROM outbox_events WHERE id = $1", [eventId]);
    }
  });
}

test("REST messages recover an interrupted notification delivery without duplicating a private inbox", integrationOptions, async () => {
  const { createApiServer } = await import("../server.ts");
  const secret = randomBytes(32).toString("base64url");
  const env = {
    AUTH_JWT_SECRET: secret,
    AUTH_JWT_ISSUER: "https://auth.integration.test",
    AUTH_JWT_AUDIENCE: "bot-thk-api",
  };
  const suffix = randomUUID();
  const sender = `rest-sender-${suffix}`;
  const recipient = `rest-recipient-${suffix}`;
  const outsider = `rest-outsider-${suffix}`;
  const sign = (sub) => {
    const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const now = Math.floor(Date.now() / 1000);
    const unsigned = `${encode({ alg: "HS256", typ: "application/vnd.bot-thk.access+jwt" })}.${encode({
      sub, iss: env.AUTH_JWT_ISSUER, aud: env.AUTH_JWT_AUDIENCE, iat: now, exp: now + 60, jti: `session-${sub}`,
    })}`;
    return `${unsigned}.${createHmac("sha256", secret).update(unsigned).digest("base64url")}`;
  };
  const server = createApiServer({ env, store });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}/api/v1`;
  const auth = (user) => ({ authorization: `Bearer ${sign(user)}` });
  const json = (user) => ({ ...auth(user), "content-type": "application/json" });
  let conversationId;
  try {
    const created = await fetch(`${baseUrl}/conversations`, {
      method: "POST", headers: json(sender), body: JSON.stringify({ participantIds: [recipient] }),
    });
    assert.equal(created.status, 201);
    conversationId = (await created.json()).data.id;
    const messageUrl = `${baseUrl}/conversations/${conversationId}/messages`;
    const send = (body) => fetch(messageUrl, {
      method: "POST", headers: { ...json(sender), "idempotency-key": `rest-message-${suffix}` },
      body: JSON.stringify({ body }),
    });
    const sent = await send("offline message");
    assert.equal(sent.status, 201);
    const message = (await sent.json()).data;
    assert.equal(message.senderId, sender);
    const repeated = await send("offline message");
    assert.equal(repeated.status, 201);
    assert.equal((await repeated.json()).data.id, message.id);
    assert.equal((await send("different content")).status, 409);

    const deniedHistory = await fetch(messageUrl, { headers: auth(outsider) });
    assert.equal(deniedHistory.status, 403);
    const history = await fetch(messageUrl, { headers: auth(recipient) });
    assert.equal(history.status, 200);
    assert.deepEqual((await history.json()).data.map((item) => item.id), [message.id]);
    const beforeDelivery = await fetch(`${baseUrl}/me/notifications`, { headers: auth(recipient) });
    assert.deepEqual((await beforeDelivery.json()).data, []);

    // Simulate a worker crash after persisting the inbox but before acknowledging
    // the event; once its lease expires a new worker must safely replay it.
    const [abandoned] = await store.claimOutboxEvents({ limit: 1 });
    assert.equal(abandoned.event_key, `message:${message.id}`);
    await createMessageNotificationDelivery({ store })(abandoned);
    await sql.unsafe("UPDATE outbox_events SET available_at = '2000-01-01Z' WHERE id = $1", [abandoned.id]);
    const recovery = await dispatchOutboxBatch({ store, limit: 1, deliver: createMessageNotificationDelivery({ store }) });
    assert.deepEqual(recovery, { claimed: 1, delivered: 1, failed: 0 });
    assert.equal(await store.markOutboxDelivered({ eventId: abandoned.id, leaseToken: abandoned.lease_token }), false);

    const inboxResponse = await fetch(`${baseUrl}/me/notifications`, { headers: auth(recipient) });
    assert.equal(inboxResponse.status, 200);
    assert.match(inboxResponse.headers.get("cache-control"), /no-store/i);
    const inbox = (await inboxResponse.json()).data;
    assert.equal(inbox.length, 1);
    assert.equal(inbox[0].eventKey, `message:${message.id}`);
    assert.deepEqual(JSON.parse(inbox[0].payload), {
      type: "message.created", messageId: message.id, conversationId, senderId: sender,
    });
    const otherInbox = await fetch(`${baseUrl}/me/notifications`, { headers: auth(outsider) });
    assert.deepEqual((await otherInbox.json()).data, []);
    const otherRead = await fetch(`${baseUrl}/me/notifications/${inbox[0].id}/read`, { method: "PUT", headers: auth(outsider) });
    assert.equal((await otherRead.json()).data, null);
    const unread = await fetch(`${baseUrl}/me/notifications/unread-count`, { headers: auth(recipient) });
    assert.equal((await unread.json()).data, 1);
    const read = await fetch(`${baseUrl}/me/notifications/${inbox[0].id}/read`, { method: "PUT", headers: auth(recipient) });
    assert.ok((await read.json()).data.readAt);
    const afterRead = await fetch(`${baseUrl}/me/notifications/unread-count`, { headers: auth(recipient) });
    assert.equal((await afterRead.json()).data, 0);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    if (conversationId) {
      await sql.unsafe("DELETE FROM notifications WHERE user_id = ANY($1::text[])", [[sender, recipient, outsider]]);
      await sql.unsafe("DELETE FROM outbox_events WHERE aggregate_id IN (SELECT id::text FROM messages WHERE conversation_id = $1)", [conversationId]);
      await sql.unsafe("DELETE FROM conversations WHERE id = $1", [conversationId]);
    }
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


test("public article search treats LIKE metacharacters as literal text", integrationOptions, async () => {
  const ownerId = `it-search-owner-${randomUUID()}`;
  const token = `literal-${randomUUID().replaceAll("-", "")}`;
  const contentBlocks = [{ id: "body", type: "paragraph", text: "Search escaping fixture." }];
  const articles = [];
  try {
    for (const [suffix, marker] of [["literal", "%"], ["wildcard", "x"]]) {
      articles.push(await store.createArticle({
        authorId: ownerId,
        slug: `it-search-literal-${token}-${suffix}`,
        title: `${token}${marker}literal match`,
        summary: "search escaping fixture",
        locale: "en",
        contentBlocks,
        publish: true,
        workType: "essay",
      }));
    }

    const matches = await store.listPublishedArticles({
      locale: "en",
      query: `${token}%literal`,
      limit: 10,
      offset: 0,
    });
    assert.deepEqual(matches.map((article) => article.id), [articles[0].id]);
  } finally {
    for (const article of articles) {
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

    await store.updateConversationParticipants({
      conversationId: conversation.id, actorId: ownerId,
      addUserIds: [addId], removeUserIds: [recipientId],
    });
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
