import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";
import { Worker } from "node:worker_threads";
import { ConversationAccessError } from "../domain/errors.ts";
import { runMigrations } from "./migrate.ts";
import { createPostgresClient, createPostgresStore } from "./postgres.ts";
import { createIsolatedPostgresTestSchema } from "./test-support/isolated-postgres-schema.ts";
import { createPostgresProviderMigrationJournal } from "./postgres-provider-migration-journal.ts";
import { createPostgresProviderMigrationReplayer } from "./postgres-provider-migration-replayer.ts";
import { createSqliteProviderMigrationJournal } from "./sqlite-provider-migration-journal.ts";
import { createSqliteProviderMigrationReplayer } from "./sqlite-provider-migration-replayer.ts";
import { MIGRATION_REPLAY_SCHEMA_VERSION } from "./provider-migration-journal.ts";
import { prepareMigrationReplayTarget, replayNextMigrationBatch } from "./provider-migration-replay.ts";
import { prepareMigrationRowPayload } from "./provider-migration-row-applier.ts";
import { createSqliteClient, runSqliteMigrations } from "./sqlite.ts";
import { createSqliteConversationStore } from "./sqlite-conversation-store.ts";

const connectionString = process.env.TEST_DATABASE_URL;
const postgresOptions = { skip: !connectionString && "Set TEST_DATABASE_URL to run PostgreSQL integration tests." };
let sql;
let postgresStore;
before(async () => {
  if (!connectionString) return;
  sql = await createPostgresClient({ connectionString, max: 8 });
  await runMigrations(sql);
  postgresStore = createPostgresStore(sql);
});
after(async () => { if (sql) await sql.end({ timeout: 5 }); });
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
async function unread(store, conversationId: string, actorId: string) {
  const conversation = (await store.listConversations({ actorId })).find((item) => item.id === conversationId);
  assert.ok(conversation, "conversation must be visible to the active member");
  assert.equal((await store.getConversation({ conversationId, actorId })).unreadCount, conversation.unreadCount);
  return conversation.unreadCount;
}
async function cleanupPostgres(conversationId: string) {
  await sql.unsafe("DELETE FROM outbox_events WHERE aggregate_id IN (SELECT id::text FROM messages WHERE conversation_id = $1)", [conversationId]);
  await sql.unsafe("DELETE FROM conversations WHERE id = $1", [conversationId]);
}

test("SQLite counts a message saved after a mark even at exactly the same millisecond", async (t) => {
  const db = createSqliteClient({ filename: ":memory:", enableWal: false });
  try {
    await runSqliteMigrations(db);
    const store = createSqliteConversationStore(db);
    const conversation = await store.createConversation({ actorId: "alice", participantIds: ["bob", "carol"] });
    await store.markConversationAsRead({ conversationId: conversation.id, actorId: "bob" });
    await store.markConversationAsRead({ conversationId: conversation.id, actorId: "carol" });
    const marker = db.prepare("SELECT last_read_at FROM conversation_participants WHERE conversation_id = ? AND user_id = ?").get(conversation.id, "bob").last_read_at as string;
    t.mock.timers.enable({ apis: ["Date"], now: new Date(marker) });
    const input = { conversationId: conversation.id, senderId: "alice", body: "same millisecond", idempotencyKey: "same-millisecond" };
    const sent = await store.persistMessage(input);
    assert.equal(sent.createdAt, marker);
    assert.equal(await unread(store, conversation.id, "bob"), 1);
    assert.equal(await unread(store, conversation.id, "carol"), 1);
    assert.equal(await unread(store, conversation.id, "alice"), 0, "one's own message is not unread");
    await store.markConversationAsRead({ conversationId: conversation.id, actorId: "bob" });
    assert.equal(await unread(store, conversation.id, "bob"), 0);
    assert.equal(await unread(store, conversation.id, "carol"), 1, "a mark only affects its actor");
    assert.equal((await store.persistMessage(input)).duplicate, true);
    assert.equal(await unread(store, conversation.id, "bob"), 0, "a duplicate send cannot resurrect a read message");
    await store.persistMessage({ ...input, body: "later, same clock", idempotencyKey: "second" });
    assert.equal(await unread(store, conversation.id, "bob"), 1);
    await assert.rejects(store.markConversationAsRead({ conversationId: conversation.id, actorId: "intruder" }), ConversationAccessError);
    assert.equal(await unread(store, conversation.id, "bob"), 1);
  } finally { db.close(); }
});

for (const provider of ["sqlite", "postgres"] as const) {
  test(`${provider}: new and rejoined participants start after existing messages; existing members retain their watermarks`, provider === "postgres" ? postgresOptions : {}, async () => {
    const db = provider === "sqlite" ? createSqliteClient({ filename: ":memory:", enableWal: false }) : null;
    if (db) await runSqliteMigrations(db);
    const store = db ? createSqliteConversationStore(db) : postgresStore;
    const suffix = randomUUID();
    const alice = `alice-${suffix}`, bob = `bob-${suffix}`, carol = `carol-${suffix}`;
    const conversation = await store.createConversation({ actorId: alice, participantIds: [bob] });
    const send = (key: string) => store.persistMessage({ conversationId: conversation.id, senderId: alice, body: key, idempotencyKey: `${suffix}-${key}` });
    try {
      await send("before-join");
      assert.equal(await unread(store, conversation.id, bob), 1);
      await store.updateConversationParticipants({ conversationId: conversation.id, actorId: alice, addUserIds: [carol] });
      assert.equal(await unread(store, conversation.id, carol), 0);
      assert.equal(await unread(store, conversation.id, bob), 1);
      await send("after-join");
      assert.equal(await unread(store, conversation.id, carol), 1);
      await store.updateConversationParticipants({ conversationId: conversation.id, actorId: alice, addUserIds: [carol], removeUserIds: [bob] });
      assert.equal(await unread(store, conversation.id, carol), 1, "adding an already-active member must not reset unread");
      await assert.rejects(store.markConversationAsRead({ conversationId: conversation.id, actorId: bob }), ConversationAccessError);
      await send("while-bob-left");
      await store.updateConversationParticipants({ conversationId: conversation.id, actorId: alice, addUserIds: [bob] });
      assert.equal(await unread(store, conversation.id, bob), 0);
      assert.equal(await unread(store, conversation.id, carol), 2);
      await send("after-rejoin");
      assert.equal(await unread(store, conversation.id, bob), 1);
      assert.equal(await unread(store, conversation.id, carol), 3);
      await store.markConversationAsRead({ conversationId: conversation.id, actorId: bob });
      assert.equal(await unread(store, conversation.id, carol), 3);
    } finally {
      if (db) db.close(); else await cleanupPostgres(conversation.id);
    }
  });
}

for (const provider of ["sqlite", "postgres"] as const) {
  test(`${provider}: message pages and the latest message follow persistence order when clocks disagree`, provider === "postgres" ? postgresOptions : {}, async () => {
    const db = provider === "sqlite" ? createSqliteClient({ filename: ":memory:", enableWal: false }) : null;
    if (db) await runSqliteMigrations(db);
    const store = db ? createSqliteConversationStore(db) : postgresStore;
    const suffix = randomUUID(), alice = `alice-${suffix}`, bob = `bob-${suffix}`;
    const conversation = await store.createConversation({ actorId: alice, participantIds: [bob] });
    try {
      const first = await store.persistMessage({ conversationId: conversation.id, senderId: alice, body: "first", idempotencyKey: `first-${suffix}` });
      const second = await store.persistMessage({ conversationId: conversation.id, senderId: alice, body: "second", idempotencyKey: `second-${suffix}` });
      // Model clock skew and out-of-order transaction timestamps, without relying
      // on wall-clock sleeps or the random UUID ordering of equal timestamps.
      if (db) {
        db.prepare("UPDATE messages SET created_at = ? WHERE id = ?").run("2099-01-01T00:00:00.000Z", first.id);
        db.prepare("UPDATE messages SET created_at = ? WHERE id = ?").run("2001-01-01T00:00:00.000Z", second.id);
      } else {
        await sql.unsafe("UPDATE messages SET created_at = '2099-01-01Z' WHERE id = $1", [first.id]);
        await sql.unsafe("UPDATE messages SET created_at = '2001-01-01Z' WHERE id = $1", [second.id]);
      }
      assert.equal(await unread(store, conversation.id, bob), 2);
      assert.equal((await store.getConversation({ conversationId: conversation.id, actorId: bob })).lastMessage.id, second.id);
      const latest = await store.listConversationMessages({ conversationId: conversation.id, actorId: bob, limit: 1 });
      assert.deepEqual(latest.map((message) => message.id), [second.id]);
      const older = await store.listConversationMessages({ conversationId: conversation.id, actorId: bob, limit: 1, before: second.id });
      assert.deepEqual(older.map((message) => message.id), [first.id]);
    } finally { if (db) db.close(); else await cleanupPostgres(conversation.id); }
  });
}

for (const provider of ["sqlite", "postgres"] as const) {
  test(`${provider}: concurrent sends, duplicate retries and pagination preserve every unread message`, provider === "postgres" ? postgresOptions : {}, async () => {
    const db = provider === "sqlite" ? createSqliteClient({ filename: ":memory:", enableWal: false }) : null;
    if (db) await runSqliteMigrations(db);
    const store = db ? createSqliteConversationStore(db) : postgresStore;
    const suffix = randomUUID(), alice = `alice-${suffix}`, bob = `bob-${suffix}`;
    const conversation = await store.createConversation({ actorId: alice, participantIds: [bob] });
    try {
      const send = (key: string) => store.persistMessage({ conversationId: conversation.id, senderId: alice, body: key, idempotencyKey: `${suffix}-${key}` });
      const messages = await Promise.all(Array.from({ length: 12 }, (_, index) => send(`message-${index}`)));
      const duplicateResults = await Promise.all(Array.from({ length: 5 }, () => send("retry")));
      assert.equal(duplicateResults.filter((message) => !message.duplicate).length, 1);
      assert.equal(new Set(duplicateResults.map((message) => message.id)).size, 1);
      assert.equal(await unread(store, conversation.id, bob), 13);
      let before: string | null = null;
      const seen: string[] = [];
      for (;;) {
        const page = await store.listConversationMessages({ conversationId: conversation.id, actorId: bob, limit: 5, before });
        seen.push(...page.map((message) => message.id));
        if (page.length < 5) break;
        before = page[0].id;
      }
      assert.equal(seen.length, 13);
      assert.equal(new Set(seen).size, 13);
      assert.deepEqual(new Set(seen), new Set([...messages.map((message) => message.id), duplicateResults[0].id]));
      await store.markConversationAsRead({ conversationId: conversation.id, actorId: bob });
      assert.equal(await unread(store, conversation.id, bob), 0);
      await send("after-mark");
      assert.equal(await unread(store, conversation.id, bob), 1);
    } finally { if (db) db.close(); else await cleanupPostgres(conversation.id); }
  });
}

function sqliteWorker(filename: string, conversationId: string, operation: "send" | "mark", gate?: SharedArrayBuffer) {
  const started = deferred(), holding = deferred(), done = deferred();
  let failure: Error | null = null, finished = false;
  const worker = new Worker(new URL("./test-support/sqlite-read-race-worker.ts", import.meta.url), {
    workerData: { filename, conversationId, operation, key: randomUUID(), gate },
  });
  worker.on("message", (message) => {
    if (message.type === "started") started.resolve();
    if (message.type === "before-commit") holding.resolve();
    if (message.type === "done") { finished = true; done.resolve(); }
    if (message.type === "error") { failure = new Error(message.message); started.resolve(); holding.resolve(); done.resolve(); }
  });
  worker.on("error", (error) => { failure = error; started.resolve(); holding.resolve(); done.resolve(); });
  worker.on("exit", (code) => { if (code !== 0 && !finished && !failure) failure = new Error(`SQLite race worker exited ${code}`); started.resolve(); holding.resolve(); done.resolve(); });
  const wait = async (promise: Promise<void>) => { await promise; if (failure) throw failure; };
  return { worker, started: () => wait(started.promise), holding: () => wait(holding.promise), done: () => wait(done.promise) };
}

test("SQLite serializes in-flight sends and marks across connections and persists the outcome", async () => {
  const directory = await mkdtemp(join(tmpdir(), "nw-read-race-"));
  const filename = join(directory, "race.sqlite");
  let db = createSqliteClient({ filename });
  const workers: Worker[] = [];
  try {
    await runSqliteMigrations(db);
    const store = createSqliteConversationStore(db);
    for (const first of ["send", "mark"] as const) {
      const conversation = await store.createConversation({ actorId: "alice", participantIds: ["bob"] });
      const gate = new SharedArrayBuffer(4);
      const held = sqliteWorker(filename, conversation.id, first, gate); workers.push(held.worker);
      await held.started(); await held.holding();
      const next = sqliteWorker(filename, conversation.id, first === "send" ? "mark" : "send"); workers.push(next.worker);
      await next.started();
      try {
        assert.equal(await Promise.race([next.done().then(() => true), delay(150).then(() => false)]), false, "the second writer must wait for the first commit");
      } finally {
        Atomics.store(new Int32Array(gate), 0, 1);
        Atomics.notify(new Int32Array(gate), 0);
      }
      await held.done(); await next.done();
      assert.equal(await unread(store, conversation.id, "bob"), first === "send" ? 0 : 1);
    }
    db.close();
    db = createSqliteClient({ filename });
    const reopened = createSqliteConversationStore(db);
    assert.deepEqual((await reopened.listConversations({ actorId: "bob" })).map((c) => c.unreadCount).sort(), [0, 1]);
  } finally {
    await Promise.all(workers.map((worker) => worker.terminate()));
    if (db.isTransaction) db.exec("ROLLBACK");
    db.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("PostgreSQL counts a later message at exactly the read timestamp across connections", postgresOptions, async () => {
  const suffix = randomUUID(), alice = `alice-${suffix}`, bob = `bob-${suffix}`;
  const conversation = await postgresStore.createConversation({ actorId: alice, participantIds: [bob] });
  let secondConnection;
  try {
    await postgresStore.markConversationAsRead({ conversationId: conversation.id, actorId: bob });
    const message = await postgresStore.persistMessage({ conversationId: conversation.id, senderId: alice, body: "same timestamp", idempotencyKey: suffix });
    // Force the exact equality that a finite-precision clock can produce. The
    // message was actually saved after the mark; only its clock value is set.
    await sql.unsafe(`UPDATE messages SET created_at = (
      SELECT last_read_at FROM conversation_participants WHERE conversation_id = $1 AND user_id = $2
    ) WHERE id = $3`, [conversation.id, bob, message.id]);
    const [row] = await sql.unsafe(`SELECT m.created_at = cp.last_read_at AS same_timestamp
      FROM messages m JOIN conversation_participants cp ON cp.conversation_id = m.conversation_id
      WHERE m.id = $1 AND cp.user_id = $2`, [message.id, bob]);
    assert.equal(row.same_timestamp, true);
    secondConnection = await createPostgresClient({ connectionString, max: 1 });
    const reopened = createPostgresStore(secondConnection);
    assert.equal(await unread(reopened, conversation.id, bob), 1);
    await assert.rejects(Promise.resolve().then(() => reopened.markConversationAsRead({ conversationId: conversation.id, actorId: `outsider-${suffix}` })), ConversationAccessError);
    assert.equal(await unread(reopened, conversation.id, bob), 1);
  } finally {
    if (secondConnection) await secondConnection.end({ timeout: 5 });
    await cleanupPostgres(conversation.id);
  }
});

// The first transaction can start before a mark yet acquire its conversation
// lock only after the mark commits. `now()` then predates that mark in PostgreSQL.
test("PostgreSQL counts a later committed send whose transaction began before the mark", postgresOptions, async () => {
  const suffix = randomUUID(), alice = `alice-${suffix}`, bob = `bob-${suffix}`;
  const conversation = await postgresStore.createConversation({ actorId: alice, participantIds: [bob] });
  const begun = deferred(), release = deferred();
  let pending;
  try {
    const delayed = createPostgresStore({
      unsafe: (...args) => sql.unsafe(...args),
      end: (...args) => sql.end(...args),
      begin: (work) => sql.begin(async (tx) => {
        await tx.unsafe("SELECT now()");
        begun.resolve();
        await release.promise;
        return work(tx);
      }),
    });
    pending = delayed.persistMessage({ conversationId: conversation.id, senderId: alice, body: "starts early, commits late", idempotencyKey: suffix });
    await begun.promise;
    await sql.unsafe("SELECT pg_sleep(0.02)");
    await postgresStore.markConversationAsRead({ conversationId: conversation.id, actorId: bob });
    release.resolve();
    const message = await pending;
    const [row] = await sql.unsafe(`SELECT m.created_at <= cp.last_read_at AS timestamp_before_mark
      FROM messages m JOIN conversation_participants cp ON cp.conversation_id = m.conversation_id
      WHERE m.id = $1 AND cp.user_id = $2`, [message.id, bob]);
    assert.equal(row.timestamp_before_mark, true, "the test must exercise an older transaction timestamp");
    assert.equal(await unread(postgresStore, conversation.id, bob), 1);
  } finally {
    release.resolve();
    if (pending) await pending.catch(() => {});
    await cleanupPostgres(conversation.id);
  }
});

test("PostgreSQL mark waits for an in-flight message and includes it atomically", postgresOptions, async () => {
  const suffix = randomUUID(), alice = `alice-${suffix}`, bob = `bob-${suffix}`, carol = `carol-${suffix}`;
  const conversation = await postgresStore.createConversation({ actorId: alice, participantIds: [bob, carol] });
  const written = deferred(), release = deferred();
  let pending, mark;
  try {
    const delayed = createPostgresStore({
      unsafe: (...args) => sql.unsafe(...args),
      end: (...args) => sql.end(...args),
      begin: (work) => sql.begin(async (tx) => {
        const result = await work(tx);
        written.resolve();
        await release.promise;
        return result;
      }),
    });
    pending = delayed.persistMessage({ conversationId: conversation.id, senderId: alice, body: "not yet committed", idempotencyKey: suffix });
    await written.promise;
    const denied = postgresStore.markConversationAsRead({ conversationId: conversation.id, actorId: `outsider-${suffix}` });
    const deniedPromptly = await Promise.race([
      denied.then(() => "unexpected-success", (error) => error instanceof ConversationAccessError ? "denied" : "unexpected-error"),
      // Allow for a busy CI runner; this is testing that the outsider does not
      // wait on the deliberately held lock, not benchmarking query latency.
      delay(1500).then(() => "blocked"),
    ]);
    assert.equal(deniedPromptly, "denied", "an outsider should not wait on or hold a private conversation lock");
    mark = postgresStore.markConversationAsRead({ conversationId: conversation.id, actorId: bob });
    const finishedWhileSendHeld = await Promise.race([mark.then(() => true, () => true), delay(150).then(() => false)]);
    assert.equal(finishedWhileSendHeld, false, "mark must wait for the send's conversation lock");
    release.resolve();
    await pending; await mark;
    assert.equal(await unread(postgresStore, conversation.id, bob), 0);
    assert.equal(await unread(postgresStore, conversation.id, carol), 1);
  } finally {
    release.resolve();
    if (pending) await pending.catch(() => {});
    if (mark) await mark.catch(() => {});
    await cleanupPostgres(conversation.id);
  }
});

test("PostgreSQL rechecks membership when removal races with a read mark", postgresOptions, async () => {
  const suffix = randomUUID(), alice = `alice-${suffix}`, bob = `bob-${suffix}`;
  const conversation = await postgresStore.createConversation({ actorId: alice, participantIds: [bob] });
  const removed = deferred(), release = deferred();
  let pending, mark;
  try {
    const delayed = createPostgresStore({
      unsafe: (...args) => sql.unsafe(...args),
      end: (...args) => sql.end(...args),
      begin: (work) => sql.begin(async (tx) => {
        const result = await work(tx);
        removed.resolve();
        await release.promise;
        return result;
      }),
    });
    pending = delayed.updateConversationParticipants({ conversationId: conversation.id, actorId: alice, removeUserIds: [bob] });
    await removed.promise;
    mark = postgresStore.markConversationAsRead({ conversationId: conversation.id, actorId: bob });
    const outcome = mark.then(() => "allowed", (error) => error instanceof ConversationAccessError ? "denied" : "error");
    assert.equal(await Promise.race([outcome, delay(150).then(() => "blocked")]), "blocked");
    release.resolve();
    await pending;
    assert.equal(await outcome, "denied", "a removed member must not advance the watermark");
    assert.equal(await postgresStore.getConversation({ conversationId: conversation.id, actorId: bob }), null);
  } finally {
    release.resolve();
    if (pending) await pending.catch(() => {});
    if (mark) await mark.catch(() => {});
    await cleanupPostgres(conversation.id);
  }
});

for (const provider of ["sqlite", "postgres"] as const) {
  test(`${provider}: a failed outbox write rolls back the message and read ordering`, provider === "postgres" ? postgresOptions : {}, async () => {
    const db = provider === "sqlite" ? createSqliteClient({ filename: ":memory:", enableWal: false }) : null;
    if (db) await runSqliteMigrations(db);
    const store = db ? createSqliteConversationStore(db) : postgresStore;
    const suffix = randomUUID(), alice = `alice-${suffix}`, bob = `bob-${suffix}`;
    const conversation = await store.createConversation({ actorId: alice, participantIds: [bob] });
    const send = (target, key: string) => target.persistMessage({ conversationId: conversation.id, senderId: alice, body: key, idempotencyKey: `${suffix}-${key}` });
    try {
      await send(store, "before");
      await store.markConversationAsRead({ conversationId: conversation.id, actorId: bob });
      let failingStore = store;
      if (db) {
        db.exec("CREATE TRIGGER fail_message_outbox BEFORE INSERT ON outbox_events BEGIN SELECT RAISE(ABORT, 'outbox failed'); END");
      } else {
        failingStore = createPostgresStore({
          unsafe: (...args) => sql.unsafe(...args),
          end: (...args) => sql.end(...args),
          begin: (work) => sql.begin((tx) => work({ unsafe: (query, ...args) => query.startsWith("INSERT INTO outbox_events") ? Promise.reject(new Error("outbox failed")) : tx.unsafe(query, ...args) })),
        });
      }
      await assert.rejects(send(failingStore, "failed"), /outbox failed/);
      if (db) db.exec("DROP TRIGGER fail_message_outbox");
      assert.equal(await unread(store, conversation.id, bob), 0);
      assert.deepEqual((await store.listConversationMessages({ conversationId: conversation.id, actorId: bob })).map((message) => message.body), ["before"]);
      await send(store, "after");
      assert.equal(await unread(store, conversation.id, bob), 1);
      assert.deepEqual((await store.listConversationMessages({ conversationId: conversation.id, actorId: bob })).map((message) => message.body), ["before", "after"]);
    } finally { if (db) db.close(); else await cleanupPostgres(conversation.id); }
  });
}

test("SQLite upgrade preserves historical read counts and refuses unsequenced legacy writers", async () => {
  const directory = await mkdtemp(join(tmpdir(), "nw-read-upgrade-"));
  const oldDirectory = join(directory, "old-migrations");
  await mkdir(oldDirectory);
  const db = createSqliteClient({ filename: join(directory, "legacy.sqlite") });
  try {
    const source = new URL("./migrations/sqlite/", import.meta.url);
    for (const name of await readdir(source)) {
      if (/^\d{4}_.*\.sql$/.test(name) && name < "0017_") await copyFile(new URL(name, source), join(oldDirectory, name));
    }
    await runSqliteMigrations(db, { directory: oldDirectory });
    db.prepare("INSERT INTO conversations (id, created_by) VALUES (?, ?)").run("legacy", "alice");
    const insertMember = db.prepare("INSERT INTO conversation_participants (conversation_id, user_id, last_read_at) VALUES ('legacy', ?, ?)");
    insertMember.run("alice", null); insertMember.run("bob", "2024-01-02T00:00:00.000Z"); insertMember.run("carol", null);
    const insertMessage = db.prepare("INSERT INTO messages (id, conversation_id, sender_id, body, idempotency_key, request_hash, created_at) VALUES (?, 'legacy', ?, ?, ?, ?, ?)");
    for (const [sender, key, date] of [
      ["alice", "early", "2024-01-01T00:00:00.000Z"],
      ["alice", "equal-a", "2024-01-02T00:00:00.000Z"],
      ["alice", "equal-b", "2024-01-02T00:00:00.000Z"],
      ["bob", "bob-own", "2024-01-03T00:00:00.000Z"],
      ["alice", "later", "2024-01-04T00:00:00.000Z"],
    ]) insertMessage.run(randomUUID(), sender, key, key, "a".repeat(64), date);
    const legacyCounts = new Map(db.prepare(`SELECT cp.user_id,
      (SELECT count(*) FROM messages m WHERE m.conversation_id = cp.conversation_id AND m.sender_id <> cp.user_id AND (cp.last_read_at IS NULL OR m.created_at > cp.last_read_at)) AS n
      FROM conversation_participants cp WHERE cp.conversation_id = 'legacy'`).all().map((row) => [row.user_id, row.n]));
    assert.deepEqual(Object.fromEntries(legacyCounts), { alice: 1, bob: 1, carol: 5 });
    db.prepare("INSERT INTO provider_migration_sessions (session_id, source_provider, target_provider, schema_version, status) VALUES (?, 'sqlite', 'postgres', 'old', 'recording')").run("active-upgrade");
    await assert.rejects(runSqliteMigrations(db), /finish or abort active provider migration/i);
    assert.equal(db.prepare("SELECT count(*) AS n FROM pragma_table_info('messages') WHERE name = 'conversation_sequence'").get().n, 0, "a refused upgrade is atomic");
    db.prepare("UPDATE provider_migration_sessions SET status = 'aborted' WHERE session_id = ?").run("active-upgrade");
    assert.deepEqual(await runSqliteMigrations(db), ["0017_conversation_read_order"]);
    assert.deepEqual(await runSqliteMigrations(db), []);
    const store = createSqliteConversationStore(db);
    for (const [actor, count] of legacyCounts) assert.equal(await unread(store, "legacy", actor as string), count);
    assert.throws(() => insertMessage.run(randomUUID(), "alice", "old-writer", "old-writer", "a".repeat(64), "2024-01-05T00:00:00.000Z"), /sequence|constraint/i);
    await store.markConversationAsRead({ conversationId: "legacy", actorId: "bob" });
    await store.persistMessage({ conversationId: "legacy", senderId: "alice", body: "new", idempotencyKey: "new" });
    assert.equal(await unread(store, "legacy", "bob"), 1);
  } finally { db.close(); await rm(directory, { recursive: true, force: true }); }
});

test("PostgreSQL upgrades a real legacy schema and preserves existing read state", postgresOptions, async () => {
  const directory = await mkdtemp(join(tmpdir(), "nw-read-pg-upgrade-"));
  const migrations = new URL("./migrations/", import.meta.url);
  const schema = `read_upgrade_${randomUUID().replaceAll("-", "")}`;
  const rollback = new Error("discard isolated legacy migration fixture");
  try {
    for (const name of await readdir(migrations)) {
      if (/^\d{4}_.*\.sql$/.test(name) && name < "0026_") await copyFile(new URL(name, migrations), join(directory, name));
    }
    // Run the real pre-upgrade migrations in a private schema. Savepoints let
    // the normal migration runner operate inside one transaction, which rolls
    // back all schema and fixture data rather than dropping shared resources.
    await assert.rejects(sql.begin(async (tx) => {
      await tx.unsafe(`CREATE SCHEMA ${schema}`);
      await tx.unsafe(`SET LOCAL search_path TO ${schema}, public`);
      const scoped = {
        unsafe: (...args) => tx.unsafe(...args),
        begin: (work) => tx.savepoint(work),
      };
      await runMigrations(scoped, { directory });
      await tx.unsafe("INSERT INTO conversations (id, created_by) VALUES ('legacy', 'alice'), ('empty', 'alice')");
      await tx.unsafe(`INSERT INTO conversation_participants (conversation_id, user_id, last_read_at) VALUES
        ('legacy', 'alice', NULL), ('legacy', 'bob', '2024-01-02Z'), ('legacy', 'carol', NULL), ('empty', 'bob', NULL)`);
      for (const [sender, key, date] of [
        ["alice", "early", "2024-01-01Z"],
        ["alice", "equal-a", "2024-01-02Z"],
        ["alice", "equal-b", "2024-01-02Z"],
        ["bob", "bob-own", "2024-01-03Z"],
        ["alice", "later", "2024-01-04Z"],
      ]) {
        await tx.unsafe(`INSERT INTO messages (id, conversation_id, sender_id, body, idempotency_key, request_hash, created_at)
          VALUES ($1, 'legacy', $2, $3, $3, $4, $5)`, [randomUUID(), sender, key, "a".repeat(64), date]);
      }
      const beforeCounts = await tx.unsafe(`SELECT cp.conversation_id, cp.user_id,
        (SELECT count(*)::int FROM messages m WHERE m.conversation_id = cp.conversation_id AND m.sender_id <> cp.user_id AND (cp.last_read_at IS NULL OR m.created_at > cp.last_read_at)) AS n
        FROM conversation_participants cp ORDER BY cp.conversation_id, cp.user_id`);
      assert.deepEqual(beforeCounts.map((row) => row.n), [0, 1, 1, 5]);
      await tx.unsafe(`INSERT INTO provider_migration_sessions (session_id, source_provider, target_provider, schema_version, status)
        VALUES ('active-upgrade', 'postgres', 'sqlite', 'old', 'recording')`);
      await assert.rejects(runMigrations(scoped), /finish or abort active provider migration/i);
      const versions = await tx.unsafe("SELECT version FROM api_schema_migrations WHERE version = '0026_conversation_read_order'");
      assert.equal(versions.length, 0, "a refused upgrade must not be recorded");
      await tx.unsafe("UPDATE provider_migration_sessions SET status = 'aborted' WHERE session_id = 'active-upgrade'");
      // The legacy fixture stops before 0026, so the upgrade applies every
      // migration after it — discovered from disk, not transcribed, so adding
      // one is a one-line change here rather than a silent skip.
      assert.deepEqual((await runMigrations(scoped)).applied, [
        "0026_conversation_read_order",
        "0027_searchable_article_body_text",
      ]);
      assert.deepEqual((await runMigrations(scoped)).applied, []);
      const afterCounts = await tx.unsafe(`SELECT cp.conversation_id, cp.user_id,
        (SELECT count(*)::int FROM messages m WHERE m.conversation_id = cp.conversation_id AND m.sender_id <> cp.user_id AND m.conversation_sequence > cp.last_read_sequence) AS n
        FROM conversation_participants cp ORDER BY cp.conversation_id, cp.user_id`);
      assert.deepEqual(afterCounts.map((row) => ({ ...row })), beforeCounts.map((row) => ({ ...row })));
      await assert.rejects(tx.savepoint((nested) => nested.unsafe(`INSERT INTO messages
        (id, conversation_id, sender_id, body, idempotency_key, request_hash) VALUES ($1, 'legacy', 'alice', 'old', 'old', $2)`, [randomUUID(), "a".repeat(64)])));
      // This scoped executor borrows the enclosing test transaction; it does not own a pool to close.
      const upgraded = createPostgresStore({ ...scoped, end: async () => {} });
      assert.equal(await unread(upgraded, "legacy", "bob"), 1);
      await upgraded.markConversationAsRead({ conversationId: "legacy", actorId: "bob" });
      await upgraded.persistMessage({ conversationId: "legacy", senderId: "alice", body: "new", idempotencyKey: "new" });
      assert.equal(await unread(upgraded, "legacy", "bob"), 1);
      throw rollback;
    }), (error) => error === rollback);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("old conversation snapshots fail closed rather than silently dropping read ordering", () => {
  assert.throws(() => prepareMigrationRowPayload("sqlite", "conversations", "legacy", { id: "legacy", created_by: "alice" }), /read.*order|sequence|schema/i);
  assert.throws(() => prepareMigrationRowPayload("postgres", "conversation_participants", JSON.stringify(["legacy", "bob"]), { conversation_id: "legacy", user_id: "bob" }), /read.*order|sequence|schema/i);
  assert.throws(() => prepareMigrationRowPayload("sqlite", "messages", "m", { id: "m", conversation_id: "legacy" }), /read.*order|sequence|schema/i);
});

for (const sourceProvider of ["sqlite", "postgres"] as const) {
  test(`${sourceProvider} journal replay preserves message order, read state and the next target write`, postgresOptions, async () => {
    const db = createSqliteClient({ filename: ":memory:", enableWal: false });
    await runSqliteMigrations(db);
    const sqliteStore = createSqliteConversationStore(db);
    const sqliteJournal = createSqliteProviderMigrationJournal(db);
    const postgresJournal = createPostgresProviderMigrationJournal(sql);
    const sourceJournal = sourceProvider === "sqlite" ? sqliteJournal : postgresJournal;
    const isolated = sourceProvider === "sqlite" ? await createIsolatedPostgresTestSchema(connectionString!) : null;
    const target = isolated ? createPostgresProviderMigrationReplayer(isolated.sql) : createSqliteProviderMigrationReplayer(db);
    const sourceStore = sourceProvider === "sqlite" ? sqliteStore : postgresStore;
    const targetStore = isolated ? createPostgresStore(isolated.sql) : sqliteStore;
    const targetProvider = sourceProvider === "sqlite" ? "postgres" : "sqlite";
    const suffix = randomUUID(), alice = `replay-alice-${suffix}`, bob = `replay-bob-${suffix}`, sessionId = `read-order-${suffix}`;
    let conversation;
    try {
      await sourceJournal.createSession({ sessionId, sourceProvider, targetProvider, schemaVersion: MIGRATION_REPLAY_SCHEMA_VERSION });
      await sourceJournal.transitionSession({ sessionId, expectedStatus: "prepared", nextStatus: "recording" });
      await prepareMigrationReplayTarget({ sourceJournal, targetJournal: target, sessionId, targetProvider });
      conversation = await sourceStore.createConversation({ actorId: alice, participantIds: [bob], idempotencyKey: `open-${suffix}` });
      const first = { conversationId: conversation.id, senderId: alice, body: "first", idempotencyKey: `first-${suffix}` };
      await sourceStore.persistMessage(first);
      await sourceStore.markConversationAsRead({ conversationId: conversation.id, actorId: bob });
      await sourceStore.persistMessage({ ...first, body: "second", idempotencyKey: `second-${suffix}` });
      assert.equal(await unread(sourceStore, conversation.id, bob), 1);
      const replayed = await replayNextMigrationBatch({ sourceJournal, target, sessionId, limit: 1000 });
      assert.equal(replayed.remainingAtRead, 0);
      assert.equal(await unread(targetStore, conversation.id, bob), 1);
      const reopened = await targetStore.createConversation({ actorId: alice, participantIds: [bob], idempotencyKey: `open-${suffix}` });
      assert.equal(reopened.id, conversation.id, "conversation creation retries survive provider replay");
      assert.equal((await targetStore.persistMessage(first)).duplicate, true);
      assert.equal(await unread(targetStore, conversation.id, bob), 1);
      await targetStore.persistMessage({ ...first, body: "after replay", idempotencyKey: `third-${suffix}` });
      assert.equal(await unread(targetStore, conversation.id, bob), 2);
    } finally {
      if (isolated) await isolated.cleanup();
      else {
        if (conversation) await cleanupPostgres(conversation.id);
        await sql.unsafe("DELETE FROM provider_migration_sessions WHERE session_id = $1", [sessionId]);
      }
      db.close();
    }
  });
}
