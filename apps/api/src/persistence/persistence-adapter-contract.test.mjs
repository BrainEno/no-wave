import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { randomUUID } from "node:crypto";
import { IdempotencyConflictError, ConversationAccessError } from "../domain/errors.mjs";
import { createPostgresClient, createPostgresStore } from "./postgres.mjs";
import { runMigrations } from "./migrate.mjs";
import { createSqliteClient, runSqliteMigrations } from "./sqlite.mjs";
import { createSqliteStore } from "./sqlite-store.mjs";
import { dispatchOutboxBatch } from "./outbox-worker.mjs";

const connectionString = process.env.TEST_DATABASE_URL;
let postgresSql;
let postgresStore;

before(async () => {
  if (!connectionString) return;
  postgresSql = await createPostgresClient({ connectionString, max: 4 });
  await runMigrations(postgresSql);
  postgresStore = createPostgresStore(postgresSql);
});

after(async () => {
  if (postgresSql) await postgresSql.end({ timeout: 5 });
});

async function sqliteFixture() {
  const db = createSqliteClient({ filename: ":memory:", enableWal: false });
  await runSqliteMigrations(db);
  return {
    store: createSqliteStore(db),
    async cleanup(conversationId) {
      if (conversationId) {
        const messages = db.prepare("SELECT id FROM messages WHERE conversation_id = ?").all(conversationId);
        for (const message of messages) {
          db.prepare("DELETE FROM outbox_events WHERE event_key = ?").run(`message:${message.id}`);
        }
        db.prepare("DELETE FROM conversations WHERE id = ?").run(conversationId);
      }
      db.close();
    },
  };
}

async function postgresFixture() {
  return {
    store: postgresStore,
    async cleanup(conversationId) {
      if (!conversationId) return;
      const messages = await postgresSql.unsafe(
        "SELECT id FROM messages WHERE conversation_id = $1",
        [conversationId],
      );
      for (const message of messages) {
        await postgresSql.unsafe("DELETE FROM outbox_events WHERE event_key = $1", [`message:${message.id}`]);
      }
      await postgresSql.unsafe("DELETE FROM conversations WHERE id = $1", [conversationId]);
    },
  };
}

/** Run identical behavior assertions against each persistence adapter. */
function registerAdapterContracts(adapterName, fixture, options = {}) {
  test(`${adapterName}: message persistence is idempotent and rejects payload conflicts`, options, async () => {
    const runtime = await fixture();
    const suffix = randomUUID();
    let conversationId;
    try {
      const conversation = await runtime.store.createConversation({
        actorId: `sender-${suffix}`,
        participantIds: [`recipient-${suffix}`],
      });
      conversationId = conversation.id;
      const input = {
        conversationId,
        senderId: `sender-${suffix}`,
        body: "contract message",
        idempotencyKey: `key-${suffix}`,
      };
      const first = await runtime.store.persistMessage(input);
      const retry = await runtime.store.persistMessage(input);
      assert.equal(first.duplicate, false);
      assert.equal(retry.duplicate, true);
      assert.equal(retry.id, first.id);
      await assert.rejects(
        runtime.store.persistMessage({ ...input, body: "conflicting payload" }),
        IdempotencyConflictError,
      );
    } finally {
      await runtime.cleanup(conversationId);
    }
  });

  test(`${adapterName}: message persistence denies non-participants without creating messages`, options, async () => {
    const runtime = await fixture();
    const suffix = randomUUID();
    let conversationId;
    try {
      const conversation = await runtime.store.createConversation({
        actorId: `member-${suffix}`,
        participantIds: [`other-${suffix}`],
      });
      conversationId = conversation.id;
      await assert.rejects(
        runtime.store.persistMessage({
          conversationId,
          senderId: `outsider-${suffix}`,
          body: "must not persist",
          idempotencyKey: `key-${suffix}`,
        }),
        ConversationAccessError,
      );
      const history = await runtime.store.listConversationMessages({
        conversationId,
        actorId: `member-${suffix}`,
        limit: 10,
      });
      assert.deepEqual(history, []);
    } finally {
      await runtime.cleanup(conversationId);
    }
  });

  test(`${adapterName}: outbox dispatch delivers a persisted message exactly once`, options, async () => {
    const runtime = await fixture();
    const suffix = randomUUID();
    let conversationId;
    try {
      const conversation = await runtime.store.createConversation({
        actorId: `sender-${suffix}`,
        participantIds: [`recipient-${suffix}`],
      });
      conversationId = conversation.id;
      const message = await runtime.store.persistMessage({
        conversationId,
        senderId: `sender-${suffix}`,
        body: "deliver through the shared worker",
        idempotencyKey: `key-${suffix}`,
      });
      const delivered = [];
      const result = await dispatchOutboxBatch({
        store: runtime.store,
        deliver: async (event) => delivered.push(event),
        limit: 10,
        leaseSeconds: 30,
      });
      assert.deepEqual(result, { claimed: 1, delivered: 1, failed: 0 });
      assert.equal(delivered.length, 1);
      assert.equal(delivered[0].event_key, `message:${message.id}`);
      assert.equal(await runtime.store.markOutboxDelivered({ eventId: delivered[0].id }), false);
      assert.deepEqual(await runtime.store.claimOutboxEvents({ limit: 10 }), []);
    } finally {
      await runtime.cleanup(conversationId);
    }
  });
}

registerAdapterContracts("SQLite", sqliteFixture);
registerAdapterContracts(
  "PostgreSQL",
  postgresFixture,
  { skip: !connectionString && "Set TEST_DATABASE_URL to run PostgreSQL persistence contracts." },
);
