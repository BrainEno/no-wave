import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runMigrations } from "./migrate.ts";
import { runSqliteMigrations } from "./sqlite.ts";
import { integrityOptions, integrityProviders, notificationIntegrityFixture } from "./test-support/notification-integrity-fixture.ts";

/** The nine types before ADR 0054, and the one of 小说 / 诗歌 / 其他文体 each folds into. */
const FOLD = {
  novel: "novel", short_story: "novel", serial: "novel",
  poetry: "poetry",
  essay: "other", criticism: "other", literary_criticism: "other", nonfiction: "other", other: "other",
} as const;

for (const provider of integrityProviders) {
  test(`${provider}: folding the work types keeps every work, moves each to its group and refuses the old values afterwards`, integrityOptions(provider), async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "nw-work-type-upgrade-"));
    const source = new URL(provider === "sqlite" ? "./migrations/sqlite/" : "./migrations/", import.meta.url);
    const version = provider === "sqlite" ? "0026_three_work_types" : "0039_three_work_types";
    for (const name of await readdir(source)) {
      if (/^\d{4}_.+\.sql$/.test(name) && name < `${version}.sql`) await copyFile(new URL(name, source), join(directory, name));
    }
    const f = await notificationIntegrityFixture(t, provider, { migrationDirectory: directory });
    t.after(() => rm(directory, { recursive: true, force: true }));

    // One real work per old type. Today's store already refuses the folded
    // values, so each work is created as a novel and given its old type below
    // the contract, which the pre-0054 schema still allows.
    const ids = new Map<string, string>();
    for (const workType of Object.keys(FOLD)) {
      const created = await f.store.createArticle({
        authorId: "fold-author", slug: `fold-${workType.replaceAll("_", "-")}-${randomUUID()}`, title: `作品 ${workType}`,
        locale: "zh-CN", publish: true, workType: "novel", contentBlocks: [{ id: "body", type: "paragraph", text: "正文" }],
      });
      await f.query("UPDATE articles SET work_type = ? WHERE id = ?", [workType, created.id]);
      ids.set(workType, created.id);
    }
    const before = await f.query("SELECT id, slug, status, created_at, updated_at, published_at FROM articles ORDER BY id");

    // Later migrations run in the same pass; they do not touch work types.
    const pending = provider === "sqlite" ? [version, "0027_edition_language"] : [version, "0040_edition_language"];
    if (f.db) assert.deepEqual(await runSqliteMigrations(f.db), pending);
    else assert.deepEqual((await runMigrations(f.sql!)).applied, pending);

    // Nothing lost, nothing else touched: only the type moved.
    assert.deepEqual(await f.query("SELECT id, slug, status, created_at, updated_at, published_at FROM articles ORDER BY id"), before);
    for (const [oldType, id] of ids) {
      const [row] = await f.query("SELECT work_type FROM articles WHERE id = ?", [id]);
      assert.equal(row!.work_type, FOLD[oldType as keyof typeof FOLD], `${oldType} must fold into ${FOLD[oldType as keyof typeof FOLD]}`);
    }

    // The database refuses the folded values by itself, on insert and update.
    const someId = ids.get("novel")!;
    for (const folded of ["short_story", "serial", "essay", "nonfiction"]) {
      await assert.rejects(f.query("UPDATE articles SET work_type = ? WHERE id = ?", [folded, someId]), undefined, folded);
    }
    await assert.rejects(f.query(
      "INSERT INTO articles (id, author_id, slug, work_type) VALUES (?, ?, ?, ?)",
      [randomUUID(), "fold-author", `fold-insert-${randomUUID()}`, "essay"],
    ));
    // …and still takes the three survivors.
    await f.query("UPDATE articles SET work_type = ? WHERE id = ?", ["poetry", someId]);
    assert.equal((await f.query("SELECT work_type FROM articles WHERE id = ?", [someId]))[0]!.work_type, "poetry");

    if (f.db) assert.deepEqual(await runSqliteMigrations(f.db), []);
    else assert.deepEqual((await runMigrations(f.sql!)).applied, []);
  });

  test(`${provider}: the work-type fold refuses to run during a provider capture`, integrityOptions(provider), async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "nw-work-type-guard-"));
    const source = new URL(provider === "sqlite" ? "./migrations/sqlite/" : "./migrations/", import.meta.url);
    const version = provider === "sqlite" ? "0026_three_work_types" : "0039_three_work_types";
    for (const name of await readdir(source)) {
      if (/^\d{4}_.+\.sql$/.test(name) && name < `${version}.sql`) await copyFile(new URL(name, source), join(directory, name));
    }
    const f = await notificationIntegrityFixture(t, provider, { migrationDirectory: directory });
    t.after(() => rm(directory, { recursive: true, force: true }));
    await f.query("INSERT INTO provider_migration_sessions (session_id, source_provider, target_provider, schema_version, status) VALUES (?, 'sqlite', 'postgres', 'old', 'recording')", ["active-capture"]);
    const created = await f.store.createArticle({
      authorId: "fold-author", slug: `fold-guard-${randomUUID()}`, title: "短篇", locale: "zh-CN", workType: "novel",
      contentBlocks: [{ id: "body", type: "paragraph", text: "正文" }],
    });
    await f.query("UPDATE articles SET work_type = ? WHERE id = ?", ["short_story", created.id]);
    // The fold source is copied after the guard row exists, so the next run sees it.
    await copyFile(new URL(`${version}.sql`, source), join(directory, `${version}.sql`));
    if (f.db) await assert.rejects(runSqliteMigrations(f.db, { directory }), /finish or abort active provider migration/i);
    else await assert.rejects(runMigrations(f.sql!, { directory }), /finish or abort active provider migration/i);
    assert.equal((await f.query("SELECT work_type FROM articles WHERE id = ?", [created.id]))[0]!.work_type, "short_story", "a refused fold is atomic");
  });
}
