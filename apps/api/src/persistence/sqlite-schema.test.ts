import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSqliteClient, runSqliteMigrations } from "./sqlite.ts";
import { createSqliteOutboxStore } from "./sqlite-outbox-store.ts";

test("SQLite domain migration creates the complete set of domain tables", async () => {
  const db = createSqliteClient({ filename: ":memory:", enableWal: false });
  try {
    const applied = await runSqliteMigrations(db);
    assert.deepEqual(applied, ["0001_domain_schema", "0002_outbox_lease_tokens", "0003_self_hosted_identity"]);
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    ).all().map((row) => row.name);
    assert.deepEqual(tables, [
      "api_schema_migrations", "article_comments", "article_likes", "article_taxonomies",
      "article_translations", "articles", "auth_access_tokens", "auth_accounts", "auth_rate_limits",
      "auth_refresh_tokens", "auth_sessions", "conversation_participants", "conversations",
      "messages", "notifications", "outbox_events", "revoked_sessions", "taxonomies",
      "taxonomy_translations", "user_follows", "user_profile_translations", "user_profiles",
    ]);
    const indexes = db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%'",
    ).all().map((row) => row.name);
    for (const required of [
      "articles_published_idx", "messages_conversation_created_idx",
      "notifications_user_created_idx", "outbox_pending_idx",
      "article_taxonomies_taxonomy_article_idx", "user_follows_follower_created_idx",
      "auth_sessions_expiry_idx", "auth_rate_limits_reset_idx", "auth_refresh_tokens_session_idx",
    ]) assert.ok(indexes.includes(required), `missing SQLite index: ${required}`);
  } finally {
    db.close();
  }
});

test("SQLite lease migration preserves pending, leased, and delivered legacy events", async () => {
  const oldMigrations = await mkdtemp(join(tmpdir(), "no-wave-sqlite-outbox-upgrade-"));
  const db = createSqliteClient({ filename: ":memory:", enableWal: false });
  try {
    await copyFile(new URL("./migrations/sqlite/0001_domain_schema.sql", import.meta.url), join(oldMigrations, "0001_domain_schema.sql"));
    assert.deepEqual(await runSqliteMigrations(db, { directory: oldMigrations }), ["0001_domain_schema"]);
    const pendingId = randomUUID();
    const leasedId = randomUUID();
    const deliveredId = randomUUID();
    const insert = db.prepare(`INSERT INTO outbox_events
      (id,event_key,event_type,aggregate_id,payload,attempts,available_at,delivered_at)
      VALUES (?,?,?,?,?,?,?,?)`);
    insert.run(pendingId, "pending", "message.created", "a", "{}", 2, "2000-01-01T00:00:00.000Z", null);
    insert.run(leasedId, "leased", "message.created", "b", "{}", 3, "2999-01-01T00:00:00.000Z", null);
    insert.run(deliveredId, "delivered", "message.created", "c", "{}", 1, "2000-01-01T00:00:00.000Z", "2020-01-01T00:00:00.000Z");
    db.prepare("INSERT INTO revoked_sessions (session_id, expires_at) VALUES (?, ?)").run("legacy-token", "2099-01-01T00:00:00.000Z");

    assert.deepEqual(await runSqliteMigrations(db), ["0002_outbox_lease_tokens", "0003_self_hosted_identity"]);
    assert.equal(db.prepare("SELECT expires_at FROM revoked_sessions WHERE session_id = ?").get("legacy-token").expires_at, "2099-01-01T00:00:00.000Z");
    assert.deepEqual(await runSqliteMigrations(db), []);
    const legacy = db.prepare("SELECT event_key, attempts, delivered_at, lease_token FROM outbox_events ORDER BY event_key").all();
    assert.deepEqual(legacy.map((row) => ({ ...row })), [
      { event_key: "delivered", attempts: 1, delivered_at: "2020-01-01T00:00:00.000Z", lease_token: null },
      { event_key: "leased", attempts: 3, delivered_at: null, lease_token: null },
      { event_key: "pending", attempts: 2, delivered_at: null, lease_token: null },
    ]);
    const store = createSqliteOutboxStore(db);
    const [pending] = await store.claimOutboxEvents({ limit: 10 });
    assert.equal(pending.id, pendingId);
    assert.equal(pending.attempts, 3);
    assert.equal(await store.markOutboxDelivered({ eventId: pending.id, leaseToken: pending.lease_token }), true);
    assert.equal((await store.claimOutboxEvents({ limit: 10 })).length, 0);
    db.prepare("UPDATE outbox_events SET available_at = ? WHERE id = ?").run("2000-01-01T00:00:00.000Z", leasedId);
    const [recovered] = await store.claimOutboxEvents({ limit: 10 });
    assert.equal(recovered.id, leasedId);
    assert.equal(recovered.attempts, 4);
    assert.equal(await store.markOutboxDelivered({ eventId: recovered.id, leaseToken: recovered.lease_token }), true);
  } finally {
    db.close();
    await rm(oldMigrations, { recursive: true, force: true });
  }
});

test("SQLite domain schema enforces localized JSON arrays and unique message idempotency", async () => {
  const db = createSqliteClient({ filename: ":memory:", enableWal: false });
  try {
    await runSqliteMigrations(db);
    db.prepare("INSERT INTO articles (id, author_id, slug) VALUES (?, ?, ?)").run("a1", "u1", "hello-world");
    assert.throws(() => db.prepare(
      "INSERT INTO article_translations (article_id, locale, title, content_blocks) VALUES (?, ?, ?, ?)",
    ).run("a1", "en", "Title", "{}"), /JSON|constraint/i);
    db.prepare(
      "INSERT INTO article_translations (article_id, locale, title, content_blocks) VALUES (?, ?, ?, ?)",
    ).run("a1", "en", "Title", "[]");
    assert.throws(() => db.prepare(
      "INSERT INTO article_translations (article_id, locale, title, content_blocks) VALUES (?, ?, ?, ?)",
    ).run("a1", "fr", "Titre", "[]"), /CHECK constraint failed/i);

    db.prepare("INSERT INTO conversations (id, created_by) VALUES (?, ?)").run("c1", "u1");
    db.prepare("INSERT INTO conversation_participants (conversation_id, user_id) VALUES (?, ?)").run("c1", "u1");
    db.prepare(
      "INSERT INTO messages (id, conversation_id, sender_id, body, idempotency_key, request_hash) VALUES (?, ?, ?, ?, ?, ?)",
    ).run("m1", "c1", "u1", "hello", "key1", "a".repeat(64));
    assert.throws(() => db.prepare(
      "INSERT INTO messages (id, conversation_id, sender_id, body, idempotency_key, request_hash) VALUES (?, ?, ?, ?, ?, ?)",
    ).run("m2", "c1", "u1", "hello again", "key1", "b".repeat(64)), /UNIQUE constraint failed/i);
  } finally {
    db.close();
  }
});
