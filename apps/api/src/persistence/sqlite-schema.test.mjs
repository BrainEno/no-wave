import assert from "node:assert/strict";
import test from "node:test";
import { createSqliteClient, runSqliteMigrations } from "./sqlite.mjs";

test("SQLite domain migration creates the complete set of domain tables", async () => {
  const db = createSqliteClient({ filename: ":memory:", enableWal: false });
  try {
    const applied = await runSqliteMigrations(db);
    assert.deepEqual(applied, ["0001_domain_schema"]);
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    ).all().map((row) => row.name);
    assert.deepEqual(tables, [
      "api_schema_migrations", "article_comments", "article_likes", "article_taxonomies",
      "article_translations", "articles", "conversation_participants", "conversations",
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
    ]) assert.ok(indexes.includes(required), `missing SQLite index: ${required}`);
  } finally {
    db.close();
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
