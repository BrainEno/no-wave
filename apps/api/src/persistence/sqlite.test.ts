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
