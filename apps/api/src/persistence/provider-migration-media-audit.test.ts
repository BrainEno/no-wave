import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { inspect } from "node:util";
import { extractMediaReferences } from "../application/media-assets.ts";
import { compareProviderMedia } from "./provider-migration-media-comparison.ts";
import { auditProviderMediaMaterialization, ProviderMediaAuditError } from "./provider-migration-media-audit.ts";
import type { PgDatabase, PgExecutor, PgRow } from "./postgres-driver.ts";
import { createPostgresStore } from "./postgres.ts";
import { createSqliteClient, runSqliteMigrations } from "./sqlite.ts";
import { createSqliteStore } from "./sqlite-store.ts";
import { createIsolatedPostgresTestSchema } from "./test-support/isolated-postgres-schema.ts";

type Provider = "sqlite" | "postgres";
const connectionString = process.env.TEST_DATABASE_URL;
const postgresOptions = { skip: !connectionString && "Set TEST_DATABASE_URL for PostgreSQL media audit tests.", timeout: 30_000 };
const sqliteOptions = { timeout: 30_000 };
const owner = "private-audit-owner";
const privateText = "secret-draft-words-not-for-the-audit-output";
const storageKey = "private-audit-object-key";
const digest = "c".repeat(64);
type Binding = string | number | null;

async function fixture(t: TestContext, provider: Provider) {
  const directory = await mkdtemp(join(tmpdir(), "nw-media-audit-"));
  const filename = join(directory, "private-audit.sqlite");
  const db = provider === "sqlite" ? createSqliteClient({ filename, enableWal: true }) : undefined;
  const pg = provider === "postgres" ? await createIsolatedPostgresTestSchema(connectionString!) : undefined;
  t.after(async () => {
    db?.close();
    await pg?.cleanup();
    await rm(directory, { recursive: true, force: true });
  });
  if (db) await runSqliteMigrations(db);
  const sql = pg?.sql;
  async function run(sqliteQuery: string, postgresQuery: string, values: readonly Binding[] = []) {
    if (db) db.prepare(sqliteQuery).run(...values);
    else await sql!.unsafe(postgresQuery, values);
  }
  await run(
    "INSERT INTO auth_accounts (user_id, email, password_hash) VALUES (?, ?, ?)",
    "INSERT INTO auth_accounts (user_id, email, password_hash) VALUES ($1, $2, $3)",
    [owner, "audit-fixture@example.test", "fixture-only-hash"],
  );
  async function asset(id: string) {
    await run(
      "INSERT INTO media_assets (id, owner_id, storage_key, content_type, byte_size, width, height, sha256, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      "INSERT INTO media_assets (id, owner_id, storage_key, content_type, byte_size, width, height, sha256, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
      [id, owner, `${storageKey}/${id}`, "image/webp", 123, 10, 11, digest, "2025-02-28T12:30:45.123Z"],
    );
  }
  async function article(id: string, deleted = false) {
    await run(
      "INSERT INTO articles (id, author_id, slug, deleted_at) VALUES (?, ?, ?, ?)",
      "INSERT INTO articles (id, author_id, slug, deleted_at) VALUES ($1, $2, $3, $4)",
      [id, owner, `private-draft-${id}`, deleted ? "2025-02-28T12:30:45Z" : null],
    );
  }
  async function translation(articleId: string, locale: string, body: string) {
    await run(
      "INSERT INTO article_translations (article_id, locale, title, content_blocks) VALUES (?, ?, ?, ?)",
      "INSERT INTO article_translations (article_id, locale, title, content_blocks) VALUES ($1, $2, $3, $4::text::jsonb)",
      [articleId, locale, "Private title", body],
    );
  }
  async function reference(assetId: string, articleId: string, locale: string) {
    await run(
      "INSERT INTO article_media_refs (asset_id, article_id, locale) VALUES (?, ?, ?)",
      "INSERT INTO article_media_refs (asset_id, article_id, locale) VALUES ($1, $2, $3)",
      [assetId, articleId, locale],
    );
  }
  async function profile(userId: string, url: string | null, assetId: string | null) {
    await run(
      "INSERT INTO user_profiles (user_id, avatar_url, avatar_media_id) VALUES (?, ?, ?)",
      "INSERT INTO user_profiles (user_id, avatar_url, avatar_media_id) VALUES ($1, $2, $3)",
      [userId, url, assetId],
    );
  }
  function audit(settings: { pageSize?: number; maxRowsPerTable?: number; maxDurationMs?: number; maxReferencesPerDocument?: number; maxBodyBytes?: number; postgres?: PgDatabase } = {}) {
    const limits = { pageSize: settings.pageSize, maxRowsPerTable: settings.maxRowsPerTable, maxDurationMs: settings.maxDurationMs, maxReferencesPerDocument: settings.maxReferencesPerDocument, maxBodyBytes: settings.maxBodyBytes };
    return provider === "sqlite"
      ? auditProviderMediaMaterialization({ provider, sqliteFilename: filename, ...limits })
      : auditProviderMediaMaterialization({ provider, postgres: settings.postgres ?? sql!, ...limits });
  }
  return { provider, filename, db, sql, run, asset, article, translation, reference, profile, audit };
}

function body(...ids: string[]): string {
  return JSON.stringify([{ id: "private-text", type: "paragraph", text: privateText }, ...ids.map((id, i) => ({ id: `image-${i}`, type: "image", src: `/api/v1/media/${id}`, alt: "" }))]);
}
function assertPrivate(value: unknown, secrets: readonly string[]) {
  const serialized = `${inspect(value, { depth: 8 })}\n${JSON.stringify(value)}\n${value instanceof Error ? value.stack : ""}`;
  for (const secret of secrets) assert.ok(!serialized.includes(secret), "audit output must not expose private values");
}
const emptyArticles = { missingReferences: 0, unexpectedReferences: 0, referencesWithoutTranslation: 0, missingAssets: 0, danglingAssets: 0 };
const emptyAvatars = { missingReferences: 0, unexpectedLinks: 0, missingAssets: 0, danglingAssets: 0 };

for (const provider of ["sqlite", "postgres"] as const) {
  const options = provider === "postgres" ? postgresOptions : sqliteOptions;
  test(`${provider}: audit detects missing, stale, orphaned and unresolved materialized references without leaking private content`, options, async (t) => {
    const f = await fixture(t, provider);
    const [a, b, c, d, absent] = Array.from({ length: 5 }, () => randomUUID());
    const draft = randomUUID(), deleted = randomUUID();
    for (const id of [a!, b!, c!, d!]) await f.asset(id);
    await f.article(draft);
    await f.article(deleted, true);
    await f.translation(draft, "en", body(a!, a!, b!, absent!));
    await f.translation(draft, "zh-TW", body(c!));
    await f.translation(deleted, "en", body(d!));
    await f.reference(a!, draft, "en");
    await f.reference(c!, draft, "zh-TW");
    await f.reference(a!, deleted, "en");
    await f.reference(b!, draft, "fr"); // No matching translation for this materialized row.
    await f.profile("private-profile-ok", `/media/${a}`, a!);
    await f.profile("private-profile-missing", `/media/${b}`, null);
    await f.profile("private-profile-wrong", `/media/${c}`, b!);
    await f.profile("private-profile-unresolved", `/media/${absent}`, null);
    await f.profile("private-profile-stale", null, d!);
    await f.profile("private-profile-multiple", `/media/${a}/media/${b}`, a!);
    await f.profile("private-profile-empty", null, null);

    const result = await f.audit({ pageSize: 1 });
    assert.deepEqual(result, {
      kind: "media-materialization-audit",
      provider,
      scanned: { assets: 4, translations: 3, articleReferences: 4, profiles: 6 },
      articles: { missingReferences: 2, unexpectedReferences: 1, referencesWithoutTranslation: 1, missingAssets: 1, danglingAssets: 0 },
      avatars: { missingReferences: 3, unexpectedLinks: 2, missingAssets: 1, danglingAssets: 0 },
    });
    assertPrivate(result, [a!, b!, c!, d!, absent!, draft, deleted, owner, privateText, "Private title", storageKey, digest, "private-profile-wrong", f.filename]);
    if (f.db) assert.equal((f.db.prepare("SELECT count(*) AS n FROM article_media_refs").get() as { n: number }).n, 4);
    else assert.equal(Number((await f.sql!.unsafe<{ n: string }>("SELECT count(*) AS n FROM article_media_refs"))[0]!.n), 4);
  });

  test(`${provider}: valid media references honor duplicate IDs, case, locales, drafts and tombstones`, options, async (t) => {
    const f = await fixture(t, provider);
    const a = randomUUID(), b = randomUUID(), draft = randomUUID(), deleted = randomUUID();
    for (const id of [a, b]) await f.asset(id);
    await f.article(draft);
    await f.article(deleted, true);
    await f.translation(draft, "en", body(a.toUpperCase(), a, a));
    await f.translation(draft, "zh-CN", body(b));
    await f.translation(deleted, "en", body(b));
    await f.reference(a, draft, "en");
    await f.reference(b, draft, "zh-CN");
    await f.reference(b, deleted, "en");
    await f.profile("private-avatar-profile", `https://private.example.test/api/media/${a.toUpperCase()}`, a);
    const result = await f.audit({ pageSize: 1, maxReferencesPerDocument: 1 });
    assert.deepEqual(result.scanned, { assets: 2, translations: 3, articleReferences: 3, profiles: 1 });
    assert.deepEqual(result.articles, emptyArticles);
    assert.deepEqual(result.avatars, emptyAvatars);
    assert.ok(!("safe" in result) && !("ready" in result) && !("inSync" in result));
  });

  test(`${provider}: ordinary article and avatar writers produce an audit-clean snapshot`, options, async (t) => {
    const f = await fixture(t, provider);
    const store = f.db ? createSqliteStore(f.db) : createPostgresStore(f.sql!);
    const a = randomUUID(), b = randomUUID();
    for (const id of [a, b]) await store.createMediaAsset({ id, ownerId: owner, storageKey: `${storageKey}/${id}`, contentType: "image/webp", byteSize: 123, width: 10, height: 11, sha256: digest });
    await store.upsertAuthorProfile({ userId: owner, displayName: "Private writer", locale: "en", avatarUrl: `/api/media/${a}` });
    const image = (id: string) => [{ id: "image", type: "image" as const, src: `/api/v1/media/${id}`, alt: "" }];
    const input = { authorId: owner, slug: `audit-writer-${randomUUID()}`, title: "Private writer draft", locale: "en", contentBlocks: image(a), publish: false };
    const article = await store.createArticle(input);
    await store.updateArticle({ ...input, actorId: owner, articleId: article.id, locale: "zh-TW", contentBlocks: image(b) });
    await store.upsertAuthorProfile({ userId: owner, displayName: "Private writer", locale: "en", avatarUrl: `/api/media/${b}` });
    await store.deleteArticle({ actorId: owner, articleId: article.id });
    const result = await f.audit({ pageSize: 1 });
    assert.deepEqual(result.scanned, { assets: 2, translations: 2, articleReferences: 2, profiles: 1 });
    assert.deepEqual(result.articles, emptyArticles);
    assert.deepEqual(result.avatars, emptyAvatars);
    assertPrivate(result, [a, b, article.id, owner, storageKey, digest]);
  });

  test(`${provider}: streaming join counts orphan references before, between and after translations`, options, async (t) => {
    const f = await fixture(t, provider);
    const [a, b, c] = Array.from({ length: 3 }, () => randomUUID());
    const articles = [1, 2, 3, 4].map((n) => `00000000-0000-4000-8000-00000000000${n}`);
    for (const id of [a!, b!, c!]) await f.asset(id);
    for (const id of articles) await f.article(id);
    await f.translation(articles[1]!, "en", body(a!));
    await f.translation(articles[1]!, "zh-TW", body(b!));
    await f.translation(articles[2]!, "en", body(c!));
    await f.reference(a!, articles[0]!, "en");
    await f.reference(a!, articles[1]!, "en");
    await f.reference(b!, articles[1]!, "fr");
    await f.reference(a!, articles[1]!, "zh-TW");
    await f.reference(c!, articles[3]!, "en");
    const result = await f.audit({ pageSize: 1 });
    assert.deepEqual(result.scanned, { assets: 3, translations: 3, articleReferences: 5, profiles: 0 });
    assert.deepEqual(result.articles, { ...emptyArticles, missingReferences: 2, unexpectedReferences: 1, referencesWithoutTranslation: 3 });
  });

  test(`${provider}: JSON representation and bytewise locale ordering are explicit`, options, async (t) => {
    const f = await fixture(t, provider);
    const id = randomUUID(), article = randomUUID();
    await f.asset(id); await f.article(article);
    // Exercise bytewise merge ordering even for legacy out-of-domain locales.
    if (f.db) f.db.exec("PRAGMA ignore_check_constraints = ON");
    else await f.sql!.unsafe("ALTER TABLE article_translations DROP CONSTRAINT article_translations_locale_check");
    // SQLite's historical scan sees literal JSON text, while PostgreSQL's
    // JSONB-to-text rendering has already decoded these escapes.
    const escaped = `[{"id":"image","type":"image","src":"\\u002fmedia\\u002f${id}","alt":""}]`;
    await f.translation(article, "é-private", escaped);
    await f.translation(article, "z-private", body(id));
    await f.translation(article, "a-private", body(id));
    await f.reference(id, article, "z-private");
    await f.reference(id, article, "a-private");
    const result = await f.audit({ pageSize: 1 });
    assert.equal(result.scanned.translations, 3);
    assert.equal(result.articles.missingReferences, provider === "sqlite" ? 0 : 1);
    assert.equal(result.articles.unexpectedReferences, 0);
    assert.equal(result.articles.referencesWithoutTranslation, 0);
    const store = f.db ? createSqliteStore(f.db) : createPostgresStore(f.sql!);
    const legacyScan = extractMediaReferences(await store.listMediaScanRows());
    assert.equal(legacyScan.get(id)?.length, provider === "sqlite" ? 2 : 3, "audit and the actual raw media scan see the same paths");
    assertPrivate(result, [id, article, "é-private", privateText]);
  });

  test(`${provider}: malformed or non-array bodies fail without exposing content`, options, async (t) => {
    const f = await fixture(t, provider);
    const article = randomUUID(); await f.article(article);
    // Simulate legacy data with disabled constraints only in the disposable fixture.
    if (f.db) f.db.exec("PRAGMA ignore_check_constraints = ON");
    else await f.sql!.unsafe("ALTER TABLE article_translations DROP CONSTRAINT article_translations_content_blocks_check");
    const invalid = provider === "sqlite" ? '["private-broken-json' : '"private-non-array-body"';
    await f.translation(article, "en", invalid);
    await assert.rejects(f.audit(), (error: unknown) => {
      assert.ok(error instanceof ProviderMediaAuditError);
      assert.equal(error.code, "INVALID_DATA");
      assertPrivate(error, [article, invalid, f.filename]);
      return true;
    });
  });

  test(`${provider}: broken foreign-key relationships are counted but never repaired`, options, async (t) => {
    const f = await fixture(t, provider);
    const absent = randomUUID(), article = randomUUID();
    await f.article(article);
    await f.translation(article, "en", body(absent));
    if (f.db) f.db.exec("PRAGMA foreign_keys = OFF");
    else {
      // Disposable schema only: simulate a pre-existing, unverifiable legacy
      // target without requiring a superuser or touching any production data.
      await f.sql!.unsafe("ALTER TABLE article_media_refs DROP CONSTRAINT article_media_refs_asset_id_fkey");
      await f.sql!.unsafe("ALTER TABLE user_profiles DROP CONSTRAINT user_profiles_avatar_media_id_fkey");
    }
    await f.reference(absent, article, "en");
    await f.reference(absent, article, "fr"); // Also dangling without a translation.
    await f.profile("private-dangling-profile", `/media/${absent}`, absent);
    const result = await f.audit();
    assert.deepEqual(result.articles, { ...emptyArticles, missingAssets: 1, danglingAssets: 2, referencesWithoutTranslation: 1 });
    assert.deepEqual(result.avatars, { ...emptyAvatars, missingAssets: 1, danglingAssets: 1 });
    assertPrivate(result, [absent, article, privateText, "private-dangling-profile"]);
  });

  test(`${provider}: row, body and reference limits fail closed and release the snapshot`, options, async (t) => {
    const f = await fixture(t, provider);
    const a = randomUUID(), b = randomUUID(), article = randomUUID();
    await f.asset(a); await f.asset(b); await f.article(article);
    await f.translation(article, "en", body(a, b));
    await f.reference(a, article, "en"); await f.reference(b, article, "en");
    await assert.rejects(f.audit({ pageSize: 1, maxRowsPerTable: 1 }), (error: unknown) => {
      assert.ok(error instanceof ProviderMediaAuditError);
      assert.equal(error.code, "ROW_LIMIT_EXCEEDED");
      assertPrivate(error, [a, b, article, privateText, f.filename]);
      return true;
    });
    await assert.rejects(f.audit({ maxReferencesPerDocument: 1 }), (error: unknown) => error instanceof ProviderMediaAuditError && error.code === "REFERENCE_LIMIT_EXCEEDED");
    await assert.rejects(f.audit({ maxBodyBytes: 16 }), (error: unknown) => error instanceof ProviderMediaAuditError && error.code === "INVALID_DATA");
    assert.deepEqual((await f.audit()).articles, emptyArticles, "a failed run must not leave a live snapshot or partial result");
    if (f.sql) await f.sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL lock_timeout = '150ms'");
      await tx.unsafe("LOCK TABLE article_translations IN ACCESS EXCLUSIVE MODE");
    });
  });

  test(`${provider}: the distinct-reference bound also applies to multi-ID avatar URLs`, options, async (t) => {
    const f = await fixture(t, provider);
    const a = randomUUID(), b = randomUUID();
    await f.asset(a); await f.asset(b);
    await f.profile("private-multi-id-profile", `/media/${a}/media/${b}`, a);
    await assert.rejects(f.audit({ maxReferencesPerDocument: 1 }), (error: unknown) => {
      assert.ok(error instanceof ProviderMediaAuditError);
      assert.equal(error.code, "REFERENCE_LIMIT_EXCEEDED");
      assertPrivate(error, [a, b, "private-multi-id-profile", f.filename]);
      return true;
    });
    assert.equal((await f.audit({ maxReferencesPerDocument: 2 })).avatars.missingReferences, 1);
  });

  test(`${provider}: body limit is enforced in UTF-8 bytes at the exact stored-representation boundary`, options, async (t) => {
    const f = await fixture(t, provider);
    const article = randomUUID(); await f.article(article);
    const content = JSON.stringify([{ id: "unicode", type: "paragraph", text: "漢字🙂".repeat(8) }]);
    await f.translation(article, "en", content);
    const bytes = f.db ? Buffer.byteLength(content, "utf8") : Number((await f.sql!.unsafe<{ n: number }>("SELECT octet_length(content_blocks::text) AS n FROM article_translations"))[0]!.n);
    assert.ok(bytes > content.length, "the guard is bytes, not JavaScript characters");
    assert.deepEqual((await f.audit({ maxBodyBytes: bytes })).articles, emptyArticles);
    await assert.rejects(f.audit({ maxBodyBytes: bytes - 1 }), (error: unknown) => error instanceof ProviderMediaAuditError && error.code === "INVALID_DATA");
  });

  test(`${provider}: oversized avatar URL fails without returning a partial count`, options, async (t) => {
    const f = await fixture(t, provider);
    const longUrl = `https://private.example.test/${"x".repeat(16_384)}`;
    await f.profile("private-large-avatar", longUrl, null);
    await assert.rejects(f.audit(), (error: unknown) => {
      assert.ok(error instanceof ProviderMediaAuditError);
      assert.equal(error.code, "INVALID_DATA");
      assertPrivate(error, [longUrl, "private-large-avatar", f.filename]);
      return true;
    });
  });

  test(`${provider}: asset IDs outside the supported canonical UUID domain fail instead of being silently skipped`, options, async (t) => {
    const f = await fixture(t, provider);
    for (const bad of ["private-noncanonical-asset-id", "A1234567-1111-4000-8000-111111111111", "a1234567-1111-0000-8000-111111111111"]) {
      await f.asset(bad);
      await assert.rejects(f.audit(), (error: unknown) => {
        assert.ok(error instanceof ProviderMediaAuditError);
        assert.equal(error.code, "INVALID_DATA");
        assertPrivate(error, [bad, owner, storageKey, f.filename]);
        return true;
      });
      // Only delete this fabricated row in the isolated test fixture.
      await f.run("DELETE FROM media_assets WHERE id = ?", "DELETE FROM media_assets WHERE id = $1", [bad]);
    }
  });
}

test("cross-provider equality cannot conceal the same missing reference from each single-database audit", postgresOptions, async (t) => {
  const sqlite = await fixture(t, "sqlite"), postgres = await fixture(t, "postgres");
  const id = randomUUID(), article = randomUUID();
  for (const f of [sqlite, postgres]) {
    await f.asset(id); await f.article(article); await f.translation(article, "en", body(id));
  }
  const comparison = await compareProviderMedia({ sqliteFilename: sqlite.filename, postgres: postgres.sql!, sourceProvider: "sqlite" });
  assert.deepEqual(comparison.assets, { equal: 1, different: 0, sourceOnly: 0, targetOnly: 0 });
  assert.deepEqual(comparison.articleReferences, { equal: 0, sourceOnly: 0, targetOnly: 0 });
  assert.deepEqual(comparison.avatars, { equal: 0, different: 0, sourceOnly: 0, targetOnly: 0 });
  assert.equal((await sqlite.audit()).articles.missingReferences, 1);
  assert.equal((await postgres.audit()).articles.missingReferences, 1);
});

test("SQLite audit pins the entire snapshot before a concurrent WAL writer edits content and avatars", sqliteOptions, async (t) => {
  const f = await fixture(t, "sqlite");
  const a = randomUUID(), b = randomUUID(), article = randomUUID();
  await f.asset(a); await f.asset(b); await f.article(article);
  await f.translation(article, "en", body(a)); await f.reference(a, article, "en");
  await f.profile("private-snapshot-profile", `/media/${a}`, a);
  const pending = f.audit({ pageSize: 1 });
  f.db!.prepare("UPDATE article_translations SET content_blocks = ? WHERE article_id = ? AND locale = ?").run(body(b), article, "en");
  f.db!.prepare("UPDATE user_profiles SET avatar_url = ? WHERE user_id = ?").run(`/media/${b}`, "private-snapshot-profile");
  const snapshot = await pending;
  assert.deepEqual(snapshot.articles, emptyArticles);
  assert.deepEqual(snapshot.avatars, emptyAvatars);
  const after = await f.audit();
  assert.deepEqual(after.articles, { ...emptyArticles, missingReferences: 1, unexpectedReferences: 1 });
  assert.deepEqual(after.avatars, { ...emptyAvatars, missingReferences: 1, unexpectedLinks: 1 });
});

test("PostgreSQL audit holds one read-only snapshot despite concurrent edits", postgresOptions, async (t) => {
  const f = await fixture(t, "postgres");
  const a = randomUUID(), b = randomUUID(), article = randomUUID();
  await f.asset(a); await f.asset(b); await f.article(article);
  await f.translation(article, "en", body(a)); await f.reference(a, article, "en");
  await f.profile("private-snapshot-profile", `/media/${a}`, a);
  let changed = false, isolation = "", readOnly = "";
  const wrapped: PgDatabase = {
    unsafe: f.sql!.unsafe.bind(f.sql), end: f.sql!.end.bind(f.sql),
    begin: (work) => f.sql!.begin(async (tx) => work({
      async unsafe<T = PgRow>(query: string, parameters?: readonly unknown[]): Promise<T[]> {
        const result = await tx.unsafe<T>(query, parameters);
        if (/^\s*SET\s+TRANSACTION/i.test(query)) {
          isolation = (await tx.unsafe<{ transaction_isolation: string }>("SHOW transaction_isolation"))[0]!.transaction_isolation;
          readOnly = (await tx.unsafe<{ transaction_read_only: string }>("SHOW transaction_read_only"))[0]!.transaction_read_only;
        }
        if (!changed && /^\s*SELECT 1 FROM media_assets/i.test(query)) {
          changed = true;
          await f.sql!.unsafe("UPDATE article_translations SET content_blocks = $1::text::jsonb WHERE article_id = $2", [body(b), article]);
          await f.sql!.unsafe("UPDATE user_profiles SET avatar_url = $1 WHERE user_id = $2", [`/media/${b}`, "private-snapshot-profile"]);
        }
        return result;
      },
    })),
  };
  const snapshot = await f.audit({ postgres: wrapped, pageSize: 1 });
  assert.ok(changed); assert.equal(isolation, "repeatable read"); assert.equal(readOnly, "on");
  assert.deepEqual(snapshot.articles, emptyArticles); assert.deepEqual(snapshot.avatars, emptyAvatars);
  const after = await f.audit();
  assert.deepEqual(after.articles, { ...emptyArticles, missingReferences: 1, unexpectedReferences: 1 });
  assert.deepEqual(after.avatars, { ...emptyAvatars, missingReferences: 1, unexpectedLinks: 1 });
});

test("PostgreSQL audit prevents a concurrent truncate of the as-yet unread translation table", postgresOptions, async (t) => {
  const f = await fixture(t, "postgres");
  const id = randomUUID(), article = randomUUID();
  await f.asset(id); await f.article(article); await f.translation(article, "en", body(id)); await f.reference(id, article, "en");
  let blocked = false;
  const wrapped: PgDatabase = {
    unsafe: f.sql!.unsafe.bind(f.sql), end: f.sql!.end.bind(f.sql),
    begin: (work) => f.sql!.begin(async (tx) => work({
      async unsafe<T = PgRow>(query: string, parameters?: readonly unknown[]): Promise<T[]> {
        const result = await tx.unsafe<T>(query, parameters);
        if (/^\s*SELECT 1 FROM media_assets/i.test(query)) {
          try {
            await f.sql!.begin(async (writer) => {
              await writer.unsafe("SET LOCAL lock_timeout = '150ms'");
              await writer.unsafe("TRUNCATE TABLE article_translations");
            });
          } catch (error) {
            blocked = Boolean(error && typeof error === "object" && "code" in error && error.code === "55P03");
          }
        }
        return result;
      },
    })),
  };
  const result = await f.audit({ postgres: wrapped });
  assert.ok(blocked);
  assert.deepEqual(result.articles, emptyArticles);
});

test("PostgreSQL audit sends no private content or ID as SQL parameters and sanitizes errors", postgresOptions, async (t) => {
  const f = await fixture(t, "postgres");
  const id = randomUUID(), article = randomUUID();
  await f.asset(id); await f.article(article); await f.translation(article, "en", body(id)); await f.reference(id, article, "en");
  const observations: [string, readonly unknown[] | undefined][] = [];
  const wrapped: PgDatabase = {
    unsafe: f.sql!.unsafe.bind(f.sql), end: f.sql!.end.bind(f.sql),
    begin: (work) => f.sql!.begin(async (tx) => work({
      async unsafe<T = PgRow>(query: string, parameters?: readonly unknown[]): Promise<T[]> {
        observations.push([query, parameters]);
        return tx.unsafe<T>(query, parameters);
      },
    })),
  };
  const result = await f.audit({ postgres: wrapped, pageSize: 1 });
  assert.deepEqual(result.articles, emptyArticles);
  assertPrivate(observations, [id, article, owner, privateText, storageKey, digest]);
  const statements = observations.map(([query]) => query);
  assert.ok(statements.some((query) => /^FETCH FORWARD 1 FROM nw_media_comparison_auditTranslations/i.test(query)), "a translation cursor page holds only one body");
  assert.ok(!statements.some((query) => /\b(?:storage_key|sha256|title|slug)\b/i.test(query)), "audit does not select unrelated private metadata");
  const broken: PgDatabase = {
    unsafe: f.sql!.unsafe.bind(f.sql), end: f.sql!.end.bind(f.sql),
    async begin() { throw new Error("private-failure-with-query-values"); },
  };
  await assert.rejects(f.audit({ postgres: broken }), (error: unknown) => {
    assert.ok(error instanceof ProviderMediaAuditError);
    assert.equal(error.code, "DATABASE_READ_FAILED");
    assertPrivate(error, ["private-failure-with-query-values", f.filename]);
    assert.ok(!("cause" in error));
    return true;
  });
});

test("SQLite rejects malformed UTF-8 content rather than scanning replacement characters", sqliteOptions, async (t) => {
  const f = await fixture(t, "sqlite");
  const article = randomUUID(); await f.article(article); await f.translation(article, "en", body());
  f.db!.exec("PRAGMA ignore_check_constraints = ON");
  f.db!.prepare("UPDATE article_translations SET content_blocks = CAST(x'80' AS TEXT) WHERE article_id = ?").run(article);
  await assert.rejects(f.audit(), (error: unknown) => {
    assert.ok(error instanceof ProviderMediaAuditError);
    assert.equal(error.code, "INVALID_DATA");
    assertPrivate(error, [article, f.filename]);
    return true;
  });
});

test("SQLite fails closed for a non-UTF-8 database encoding", async () => {
  const directory = await mkdtemp(join(tmpdir(), "nw-audit-encoding-"));
  const filename = join(directory, "private-utf16.sqlite");
  const db = new DatabaseSync(filename);
  try {
    db.exec("PRAGMA encoding = 'UTF-16'; CREATE TABLE media_assets (id TEXT)");
    assert.match((db.prepare("PRAGMA encoding").get() as { encoding: string }).encoding, /^UTF-16/);
    await assert.rejects(auditProviderMediaMaterialization({ provider: "sqlite", sqliteFilename: filename }), (error: unknown) => {
      assert.ok(error instanceof ProviderMediaAuditError);
      assert.equal(error.code, "INVALID_DATA");
      assertPrivate(error, [filename]);
      return true;
    });
  } finally { db.close(); await rm(directory, { recursive: true, force: true }); }
});

test("PostgreSQL translation RLS cannot silently hide private articles", postgresOptions, async (t) => {
  const f = await fixture(t, "postgres");
  const id = randomUUID(), article = randomUUID();
  await f.asset(id); await f.article(article); await f.translation(article, "en", body(id)); await f.reference(id, article, "en");
  const [role] = await f.sql!.unsafe<{ rolsuper: boolean; rolbypassrls: boolean }>("SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user");
  const needsRestrictedRole = role!.rolsuper || role!.rolbypassrls;
  async function assumeRestrictedRole(tx: PgExecutor) { if (needsRestrictedRole) await tx.unsafe("SET LOCAL ROLE pg_read_all_data"); }
  const restricted: PgDatabase = {
    unsafe: f.sql!.unsafe.bind(f.sql), end: f.sql!.end.bind(f.sql),
    begin: (work) => f.sql!.begin(async (tx) => { await assumeRestrictedRole(tx); return work(tx); }),
  };
  assert.deepEqual((await f.audit({ postgres: restricted })).articles, emptyArticles, "the same read-only role works before enabling the policy");
  await f.sql!.unsafe("ALTER TABLE article_translations ENABLE ROW LEVEL SECURITY");
  await f.sql!.unsafe("ALTER TABLE article_translations FORCE ROW LEVEL SECURITY");
  await f.sql!.unsafe("CREATE POLICY hidden_private_translation ON article_translations FOR SELECT USING (false)");
  try {
    const visible = await f.sql!.begin(async (tx) => {
      await assumeRestrictedRole(tx);
      const [row] = await tx.unsafe<{ n: string }>("SELECT count(*) AS n FROM article_translations");
      return Number(row!.n);
    });
    assert.equal(visible, 0, "this role can read the table but RLS hides its row");
    await assert.rejects(f.audit({ postgres: restricted }), (error: unknown) => {
      assert.ok(error instanceof ProviderMediaAuditError);
      assert.equal(error.code, "DATABASE_READ_FAILED");
      assertPrivate(error, [id, article, privateText, owner]);
      return true;
    });
  } finally {
    await f.sql!.unsafe("DROP POLICY hidden_private_translation ON article_translations");
    await f.sql!.unsafe("ALTER TABLE article_translations NO FORCE ROW LEVEL SECURITY");
    await f.sql!.unsafe("ALTER TABLE article_translations DISABLE ROW LEVEL SECURITY");
  }
  assert.deepEqual((await f.audit({ postgres: restricted })).articles, emptyArticles);
});

test("PostgreSQL audit preserves stricter statement timeouts and rejects non-UTF-8 clients", postgresOptions, async (t) => {
  const f = await fixture(t, "postgres");
  const id = randomUUID(); await f.asset(id);
  let timeout = "";
  const strict: PgDatabase = {
    unsafe: f.sql!.unsafe.bind(f.sql), end: f.sql!.end.bind(f.sql),
    begin: (work) => f.sql!.begin(async (tx) => {
      await tx.unsafe("SET LOCAL statement_timeout = '2s'");
      return work({
        async unsafe<T = PgRow>(query: string, parameters?: readonly unknown[]): Promise<T[]> {
          const result = await tx.unsafe<T>(query, parameters);
          if (/^\s*SELECT 1 FROM media_assets/i.test(query)) timeout = (await tx.unsafe<{ statement_timeout: string }>("SHOW statement_timeout"))[0]!.statement_timeout;
          return result;
        },
      });
    }),
  };
  assert.equal((await f.audit({ postgres: strict })).scanned.assets, 1);
  assert.equal(timeout, "2s");
  const wrongEncoding: PgDatabase = {
    unsafe: f.sql!.unsafe.bind(f.sql), end: f.sql!.end.bind(f.sql),
    begin: (work) => f.sql!.begin(async (tx) => { await tx.unsafe("SET LOCAL client_encoding = 'LATIN1'"); return work(tx); }),
  };
  await assert.rejects(f.audit({ postgres: wrongEncoding }), (error: unknown) => error instanceof ProviderMediaAuditError && error.code === "INVALID_DATA");
  assert.equal((await f.audit()).scanned.assets, 1);
});

test("PostgreSQL elapsed deadline fails closed after an in-flight operation returns", postgresOptions, async (t) => {
  const f = await fixture(t, "postgres");
  const id = randomUUID(); await f.asset(id);
  const slow: PgDatabase = {
    unsafe: f.sql!.unsafe.bind(f.sql), end: f.sql!.end.bind(f.sql),
    begin: (work) => f.sql!.begin(async (tx) => work({
      async unsafe<T = PgRow>(query: string, parameters?: readonly unknown[]): Promise<T[]> {
        const result = await tx.unsafe<T>(query, parameters);
        if (/^\s*SELECT 1 FROM media_assets/i.test(query)) await new Promise((resolve) => setTimeout(resolve, 80));
        return result;
      },
    })),
  };
  await assert.rejects(f.audit({ postgres: slow, maxDurationMs: 40 }), (error: unknown) => {
    assert.ok(error instanceof ProviderMediaAuditError);
    assert.equal(error.code, "TIME_LIMIT_EXCEEDED");
    assertPrivate(error, [id, owner, f.filename]);
    return true;
  });
  assert.equal((await f.audit()).scanned.assets, 1);
});

test("invalid options and missing SQLite files fail without opening or creating a database", async () => {
  const directory = await mkdtemp(join(tmpdir(), "nw-audit-options-"));
  const filename = join(directory, "private-missing.sqlite");
  try {
    for (const settings of [{ pageSize: 0 }, { pageSize: 501 }, { maxRowsPerTable: 100_001 }, { maxDurationMs: 0 }, { maxReferencesPerDocument: 0 }, { maxReferencesPerDocument: 5_001 }, { maxBodyBytes: 0 }, { maxBodyBytes: 4_194_305 }]) {
      await assert.rejects(auditProviderMediaMaterialization({ provider: "sqlite", sqliteFilename: filename, ...settings }), (error: unknown) => error instanceof ProviderMediaAuditError && error.code === "INVALID_OPTIONS");
    }
    for (const sqliteFilename of [":memory:", "file::memory:?cache=shared"]) {
      await assert.rejects(auditProviderMediaMaterialization({ provider: "sqlite", sqliteFilename }), (error: unknown) => error instanceof ProviderMediaAuditError && error.code === "INVALID_OPTIONS");
    }
    await assert.rejects(auditProviderMediaMaterialization({ provider: "sqlite", sqliteFilename: filename }), (error: unknown) => {
      assert.ok(error instanceof ProviderMediaAuditError);
      assert.equal(error.code, "DATABASE_READ_FAILED");
      assertPrivate(error, [filename]);
      return true;
    });
    await assert.rejects(access(filename));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
