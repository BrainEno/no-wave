import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createSqliteClient, runSqliteMigrations } from "./sqlite.ts";

test("SQLite client enables foreign keys and a bounded busy timeout", () => {
  const db = createSqliteClient({ filename: ":memory:", timeoutMs: 1250 });
  try {
    assert.equal(db.prepare("PRAGMA foreign_keys").get().foreign_keys, 1);
    assert.equal(db.prepare("PRAGMA busy_timeout").get().timeout, 1250);
  } finally {
    db.close();
  }
});

test("SQLite client rejects invalid configuration before opening a database", () => {
  assert.throws(() => createSqliteClient({ filename: "" }), /filename is required/);
  assert.throws(() => createSqliteClient({ filename: ":memory:", timeoutMs: -1 }), /timeoutMs/);
});

test("SQLite binding and row types stay explicit across null, number, text, and blobs", () => {
  const db = createSqliteClient({ filename: ":memory:", enableWal: false });
  try {
    const binary = new Uint8Array([0, 127, 255]);
    const json = JSON.stringify({ ok: true, count: 2 });
    const row = db.prepare(`
      SELECT
        typeof(?1) AS null_type, ?1 AS null_value,
        typeof(?2) AS integer_type, ?2 AS integer_value,
        typeof(?3) AS real_type, ?3 AS real_value,
        typeof(?4) AS text_type, ?4 AS text_value,
        typeof(?5) AS blob_type, ?5 AS blob_value
    `).get(null, 42, 1.25, json, binary);

    assert.equal(row.null_type, "null");
    assert.equal(row.null_value, null);
    assert.equal(row.integer_type, "integer");
    assert.equal(row.integer_value, 42);
    assert.equal(row.real_type, "real");
    assert.equal(row.real_value, 1.25);
    assert.equal(row.text_type, "text");
    assert.equal(row.text_value, json);
    assert.equal(JSON.parse(row.text_value).ok, true);
    assert.equal(row.blob_type, "blob");
    assert.deepEqual([...row.blob_value], [0, 127, 255]);

    // node:sqlite's SQLInputValue does not accept JS booleans. Domain booleans
    // must be mapped deliberately (normally to SQLite's 0/1 integer storage).
    assert.throws(() => db.prepare("SELECT ? AS value").get(true), TypeError);
    const booleanStorage = db.prepare("SELECT ? AS false_value, ? AS true_value").get(0, 1);
    assert.deepEqual({ ...booleanStorage }, { false_value: 0, true_value: 1 });
  } finally {
    db.close();
  }
});

test("SQLite migrations are versioned, repeatable, and recorded atomically", async () => {
  const root = await mkdtemp(join(tmpdir(), "no-wave-sqlite-"));
  const migrations = join(root, "migrations");
  const dbPath = join(root, "test.sqlite");
  await mkdir(migrations);
  await writeFile(
    join(migrations, "0001_create_notes.sql"),
    "CREATE TABLE notes (id TEXT PRIMARY KEY, body TEXT NOT NULL);",
  );
  const db = createSqliteClient({ filename: dbPath, enableWal: false });
  try {
    assert.deepEqual(await runSqliteMigrations(db, { directory: migrations }), ["0001_create_notes"]);
    assert.deepEqual(await runSqliteMigrations(db, { directory: migrations }), []);
    assert.deepEqual(
      db.prepare("SELECT version FROM api_schema_migrations ORDER BY version").all()
        .map((row) => ({ version: row.version })),
      [{ version: "0001_create_notes" }],
    );
    db.prepare("INSERT INTO notes (id, body) VALUES (?, ?)").run("n1", "hello");
    assert.equal(db.prepare("SELECT body FROM notes WHERE id = ?").get("n1").body, "hello");
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a failed SQLite migration rolls back both schema changes and version record", async () => {
  const root = await mkdtemp(join(tmpdir(), "no-wave-sqlite-"));
  const migrations = join(root, "migrations");
  await mkdir(migrations);
  await writeFile(
    join(migrations, "0001_broken.sql"),
    "CREATE TABLE should_rollback (id TEXT PRIMARY KEY); THIS IS NOT SQL;",
  );
  const db = createSqliteClient({ filename: join(root, "test.sqlite"), enableWal: false });
  try {
    await assert.rejects(runSqliteMigrations(db, { directory: migrations }), /SQLite migration 0001_broken failed/);
    assert.equal(
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get("should_rollback"),
      undefined,
    );
    assert.equal(db.prepare("SELECT version FROM api_schema_migrations").all().length, 0);
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});
