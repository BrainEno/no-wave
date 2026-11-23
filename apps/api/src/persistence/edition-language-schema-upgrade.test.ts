import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { inferEditionLocale } from "../domain/edition-language.ts";
import { runMigrations } from "./migrate.ts";
import { runSqliteMigrations } from "./sqlite.ts";
import { integrityOptions, integrityProviders, notificationIntegrityFixture } from "./test-support/notification-integrity-fixture.ts";

const AUTHOR = "language-author";
const ASSET = "language-asset-0000";
const paragraph = (text: string) => ({ id: "body", type: "paragraph", text });

/**
 * Each case is an edition an earlier import wrote as zh-CN, and whether the
 * backfill must relabel it. `rule` is what the importer would now decide for
 * the same text; for a Notion-imported work with no English edition the two
 * must agree, or a re-import would plan a different locale from the stored one.
 */
const CASES = [
  { name: "english", title: "The Face in the Wall", summary: "", blocks: [paragraph("It came through the plaster.")], linked: true, expected: "en" },
  { name: "english-image", title: "Walls", summary: "", blocks: [{ id: "img", type: "image", src: `/api/media/${ASSET}`, alt: "plaster" }, paragraph("Through.")], linked: true, expected: "en", media: true },
  { name: "list-only", title: "1984", summary: "", blocks: [{ id: "list", type: "list", ordered: false, items: ["one", "two"] }], linked: true, expected: "en" },
  { name: "chinese-title", title: "墙中脸", summary: "", blocks: [paragraph("It came through the plaster.")], linked: true, expected: "zh-CN" },
  { name: "chinese-attribution", title: "Walls", summary: "", blocks: [{ id: "q", type: "quote", text: "Plaster.", attribution: "卡夫卡" }], linked: true, expected: "zh-CN" },
  { name: "chinese-summary", title: "Walls", summary: "穿墙", blocks: [paragraph("Plaster.")], linked: true, expected: "zh-CN" },
  { name: "numbers-only", title: "2026", summary: "", blocks: [paragraph("1, 2, 3")], linked: true, expected: "zh-CN" },
  // Written in the desk: the author chose the locale, and it is kept.
  { name: "desk-english", title: "A desk draft", summary: "", blocks: [paragraph("Typed by hand.")], linked: false, expected: "zh-CN" },
] as const;

async function migrationsBefore(provider: "sqlite" | "postgres", version: string) {
  const directory = await mkdtemp(join(tmpdir(), "nw-edition-language-"));
  const source = new URL(provider === "sqlite" ? "./migrations/sqlite/" : "./migrations/", import.meta.url);
  for (const name of await readdir(source)) {
    if (/^\d{4}_.+\.sql$/.test(name) && name < `${version}.sql`) await copyFile(new URL(name, source), join(directory, name));
  }
  return { directory, source };
}

for (const provider of integrityProviders) {
  const version = provider === "sqlite" ? "0027_edition_language" : "0040_edition_language";

  test(`${provider}: imported English editions are relabelled en with their link and media references; everything else is kept`, integrityOptions(provider), async (t) => {
    const { directory } = await migrationsBefore(provider, version);
    const f = await notificationIntegrityFixture(t, provider, { migrationDirectory: directory });
    t.after(() => rm(directory, { recursive: true, force: true }));
    await f.query("INSERT INTO auth_accounts (user_id, email, password_hash) VALUES (?, ?, ?)", [AUTHOR, "language@example.test", "fixture-password-hash"]);
    await f.query("INSERT INTO media_assets (id, owner_id, storage_key, content_type, byte_size, width, height, sha256) VALUES (?, ?, ?, 'image/webp', 1, 1, 1, ?)",
      [ASSET, AUTHOR, `media/${ASSET}`, "0".repeat(64)]);

    const ids = new Map<string, string>();
    for (const item of CASES) {
      const created = await f.store.createArticle({
        authorId: AUTHOR, slug: `language-${item.name}-${randomUUID().slice(0, 8)}`, title: item.title, summary: item.summary,
        locale: "zh-CN", publish: true, contentBlocks: item.blocks as never,
      });
      ids.set(item.name, created.id);
      if (item.linked) {
        await f.query("INSERT INTO external_content_links (provider, external_id, locale, article_id, owner_id, digest) VALUES ('notion', ?, 'zh-CN', ?, ?, 'digest')",
          [`page-${item.name}`, created.id, AUTHOR]);
        assert.equal(inferEditionLocale({ title: item.title, summary: item.summary, contentBlocks: item.blocks }), item.expected, `the importer and the backfill agree on ${item.name}`);
      }
    }
    // A bilingual work keeps both editions as they are, even though its zh-CN
    // edition reads as English: there can be only one en edition.
    const pair = await f.store.createArticle({ authorId: AUTHOR, slug: `language-pair-${randomUUID().slice(0, 8)}`, title: "Draft", locale: "zh-CN", publish: true, contentBlocks: [paragraph("Draft body")] });
    await f.store.updateArticle({ articleId: pair.id, actorId: AUTHOR, slug: pair.slug, locale: "en", title: "Walls", publish: true, contentBlocks: [paragraph("Through the plaster")] });
    await f.query("INSERT INTO external_content_links (provider, external_id, locale, article_id, owner_id, digest) VALUES ('notion', 'page-pair', 'zh-CN', ?, ?, 'digest'), ('notion', 'page-pair-en', 'en', ?, ?, 'digest')",
      [pair.id, AUTHOR, pair.id, AUTHOR]);

    const imageId = ids.get("english-image")!;
    await f.query("DELETE FROM article_media_refs WHERE article_id = ?", [imageId]);
    await f.query("INSERT INTO article_media_refs (asset_id, article_id, locale) VALUES (?, ?, 'zh-CN')", [ASSET, imageId]);
    const works = await f.query("SELECT id, slug, status, published_at FROM articles ORDER BY id");

    if (f.db) assert.deepEqual(await runSqliteMigrations(f.db), [version]);
    else assert.deepEqual((await runMigrations(f.sql!)).applied, [version]);

    for (const item of CASES) {
      const id = ids.get(item.name)!;
      assert.deepEqual(await f.query("SELECT locale FROM article_translations WHERE article_id = ?", [id]), [{ locale: item.expected }], item.name);
      if (item.linked) {
        assert.deepEqual(await f.query("SELECT locale FROM external_content_links WHERE article_id = ?", [id]), [{ locale: item.expected }], `${item.name} link`);
      }
    }
    assert.deepEqual(await f.query("SELECT locale FROM article_media_refs WHERE article_id = ?", [imageId]), [{ locale: "en" }], "the image stays protected");
    assert.deepEqual(await f.query("SELECT locale FROM article_translations WHERE article_id = ? ORDER BY locale", [pair.id]), [{ locale: "en" }, { locale: "zh-CN" }]);
    assert.deepEqual(await f.query("SELECT id, slug, status, published_at FROM articles ORDER BY id"), works, "no work is lost, moved or unpublished");

    // The English home now has the work and the Chinese one does not.
    const english = await f.store.listPublishedArticles({ locale: "en", limit: 50 });
    const chinese = await f.store.listPublishedArticles({ locale: "zh-CN", limit: 50 });
    const englishIds = new Set(english.map((item) => item.id));
    const chineseIds = new Set(chinese.map((item) => item.id));
    assert.ok(englishIds.has(ids.get("english")!) && !chineseIds.has(ids.get("english")!));
    assert.ok(chineseIds.has(ids.get("chinese-title")!) && !englishIds.has(ids.get("chinese-title")!));

    if (f.db) assert.deepEqual(await runSqliteMigrations(f.db), []);
    else assert.deepEqual((await runMigrations(f.sql!)).applied, []);
  });

  test(`${provider}: the edition relabel refuses to run during a provider capture`, integrityOptions(provider), async (t) => {
    const { directory, source } = await migrationsBefore(provider, version);
    const f = await notificationIntegrityFixture(t, provider, { migrationDirectory: directory });
    t.after(() => rm(directory, { recursive: true, force: true }));
    await f.query("INSERT INTO provider_migration_sessions (session_id, source_provider, target_provider, schema_version, status) VALUES (?, 'sqlite', 'postgres', 'old', 'recording')", ["active-capture"]);
    const created = await f.store.createArticle({ authorId: AUTHOR, slug: `language-guard-${randomUUID().slice(0, 8)}`, title: "Walls", locale: "zh-CN", contentBlocks: [paragraph("Plaster.")] });
    await f.query("INSERT INTO external_content_links (provider, external_id, locale, article_id, owner_id, digest) VALUES ('notion', 'page-guard', 'zh-CN', ?, ?, 'digest')", [created.id, AUTHOR]);
    await copyFile(new URL(`${version}.sql`, source), join(directory, `${version}.sql`));
    if (f.db) await assert.rejects(runSqliteMigrations(f.db, { directory }), /finish or abort active provider migration/i);
    else await assert.rejects(runMigrations(f.sql!, { directory }), /finish or abort active provider migration/i);
    assert.deepEqual(await f.query("SELECT locale FROM article_translations WHERE article_id = ?", [created.id]), [{ locale: "zh-CN" }], "a refused relabel is atomic");
  });
}
