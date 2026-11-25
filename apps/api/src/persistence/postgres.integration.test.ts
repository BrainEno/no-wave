import assert from "node:assert/strict";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";

import { ConversationAccessError, IdempotencyConflictError } from "../domain/errors.ts";
import { runMigrations } from "./migrate.ts";
import { dispatchOutboxBatch } from "./outbox-worker.ts";
import { createMessageNotificationDelivery } from "./message-notification-delivery.ts";
import { integrationOptions, sql, store, registerPostgresIntegration } from "./test-support/postgres-integration-fixtures.ts";

registerPostgresIntegration();

test("migrations are repeatable and record applied versions once", integrationOptions, async () => {
  const first = await runMigrations(sql);
  const second = await runMigrations(sql);
  // Compared against the files on disk rather than a transcribed list. The list
  // used to be hand-maintained, and it failed twice in a row by being one entry
  // behind a new migration — a check that reports "24 !== 25" tells you the
  // fixture is stale, not that anything is wrong. What this test is actually
  // about is that every migration on disk is applied exactly once and that
  // nothing else is recorded.
  const onDisk = (await readdir(new URL("./migrations/", import.meta.url)))
    .filter((name) => /^\d{4}_.*\.sql$/.test(name))
    .map((name) => name.slice(0, -".sql".length))
    .sort();
  assert.equal(first.discovered, onDisk.length);
  assert.equal(second.applied.length, 0, "a second run applies nothing");
  const rows = await sql.unsafe(
    "SELECT version FROM api_schema_migrations WHERE version = ANY($1::text[])",
    [onDisk],
  );
  assert.deepEqual(rows.map((row) => row.version).sort(), onDisk);
  const total = await sql.unsafe("SELECT count(*)::int AS n FROM api_schema_migrations");
  assert.equal(total[0].n, onDisk.length, "and no version is recorded that is not a file");
});

/**
 * The body-search column and its index (migration 0027, audit F-23).
 *
 * The search used to match `jsonb_array_elements(...) ->>'text'` inside the
 * query, which no index can serve, so every body search scanned every published
 * translation of the locale. What is asserted here is the shape that makes it
 * indexable — a stored generated column and a trigram index over it — and that
 * the planner will actually use it for the predicate the store sends, which is
 * the part a schema-only check would miss if the two expressions drifted.
 */
test("the body search is backed by a generated column and a trigram index", integrationOptions, async () => {
  const [column] = await sql.unsafe(
    `SELECT is_generated, generation_expression
       FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'article_translations' AND column_name = 'content_search_text'`,
  );
  assert.ok(column, "article_translations.content_search_text exists");
  assert.equal(column.is_generated, "ALWAYS", "the column is generated, so no write path can leave it stale");
  assert.match(column.generation_expression, /jsonb_path_query_array/, "it is built from the blocks, not a copy of them");
  // Every field a reader wrote, not just the prose (#245): a bullet or a line of
  // code is often the only place a term appears in a technical work.
  // The catalog renders the path with quoted keys, so match the field, not the SQL.
  assert.match(column.generation_expression, /items/, "list items are body text");
  assert.match(column.generation_expression, /code/, "a code block is body text");

  const [index] = await sql.unsafe(
    `SELECT indexdef FROM pg_indexes
      WHERE schemaname = current_schema() AND tablename = 'article_translations'
        AND indexname = 'article_translations_content_search_trgm_idx'`,
  );
  assert.ok(index, "the trigram index exists");
  assert.match(index.indexdef, /USING gin/);
  assert.match(index.indexdef, /gin_trgm_ops/);

  // With sequential scans disabled the planner can only answer this predicate
  // from the trigram index: a plan without it means the index cannot serve the
  // query, which is exactly the bug migration 0027 exists to remove.
  let plan: string[] = [];
  await sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL enable_seqscan = off");
    const rows = await tx.unsafe(
      "EXPLAIN SELECT 1 FROM article_translations WHERE content_search_text ILIKE $1",
      ["%searchable%"],
    );
    plan = rows.map((row: Record<string, string>) => row["QUERY PLAN"]);
  });
  assert.match(plan.join("\n"), /article_translations_content_search_trgm_idx/);
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
    const index = await tx.unsafe("SELECT to_regclass('pg_temp.article_comments_author_idempotency_key_idx') AS index_name");
    assert.ok(index[0].index_name, "migration must create the scoped idempotency unique index");
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
    assert.deepEqual(success, { claimed: 1, delivered: 1, failed: 0, deadLettered: 0 });
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
    assert.deepEqual(failure, { claimed: 1, delivered: 0, failed: 1, deadLettered: 0 });
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
      sub, iss: env.AUTH_JWT_ISSUER, aud: env.AUTH_JWT_AUDIENCE, iat: now, exp: now + 60, sid: `session-${sub}`, jti: `token-${sub}`,
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
      method: "POST", headers: { ...json(sender), "idempotency-key": `rest-conversation-${suffix}` },
      body: JSON.stringify({ participantIds: [recipient] }),
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
    assert.deepEqual(recovery, { claimed: 1, delivered: 1, failed: 0, deadLettered: 0 });
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
        workType: "other",
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
