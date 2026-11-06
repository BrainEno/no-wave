import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before, type TestContext } from "node:test";
import { Worker } from "node:worker_threads";
import { extractMediaReferences, referencesForOwner } from "../application/media-assets.ts";
import type { TypedPersistenceAdapterContract } from "../application/persistence-ports.ts";
import { createPostgresStore } from "./postgres.ts";
import { createIsolatedPostgresTestSchema } from "./test-support/isolated-postgres-schema.ts";
import type { PgDatabase, PgRow } from "./postgres-driver.ts";
import { createPostgresProviderMigrationJournal } from "./postgres-provider-migration-journal.ts";
import { createPostgresProviderMigrationReplayer } from "./postgres-provider-migration-replayer.ts";
import { ARTICLE_MEDIA_REFS_SNAPSHOT, MIGRATION_REPLAY_SCHEMA_VERSION, validateMigrationChange, type MigrationChange } from "./provider-migration-journal.ts";
import { prepareMigrationRowPayload } from "./provider-migration-row-applier.ts";
import { prepareMigrationReplayTarget, replayNextMigrationBatch } from "./provider-migration-replay.ts";
import { createSqliteClient, runSqliteMigrations } from "./sqlite.ts";
import { createSqliteStore } from "./sqlite-store.ts";
import { createSqliteProviderMigrationJournal } from "./sqlite-provider-migration-journal.ts";
import { createSqliteProviderMigrationReplayer } from "./sqlite-provider-migration-replayer.ts";

const connectionString = process.env.TEST_DATABASE_URL;
const options = { skip: !connectionString && "Set TEST_DATABASE_URL for real cross-provider media replay tests.", timeout: 30_000 };
let sql: PgDatabase;
let postgresStore: TypedPersistenceAdapterContract;
let postgresFixture: Awaited<ReturnType<typeof createIsolatedPostgresTestSchema>>;

before(async () => {
  if (!connectionString) return;
  postgresFixture = await createIsolatedPostgresTestSchema(connectionString);
  sql = postgresFixture.sql;
  postgresStore = createPostgresStore(sql);
});
after(async () => { if (postgresFixture) await postgresFixture.cleanup(); });

type Provider = "sqlite" | "postgres";

async function fixture(t: TestContext, sourceProvider: Provider, settings: { prepare?: boolean; schemaVersion?: string; sqliteFile?: string } = {}) {
  const db = createSqliteClient({ filename: settings.sqliteFile ?? ":memory:", enableWal: Boolean(settings.sqliteFile) });
  await runSqliteMigrations(db);
  const suffix = randomUUID(), owner = `media-replay-owner-${suffix}`, sessionId = `media-replay-${suffix}`;
  const author = `media-replay-author-${suffix}`;
  t.after(async () => {
    db.close();
    // This PostgreSQL database is disposable, but cleanup is scoped to this test.
    await sql.unsafe("DELETE FROM provider_migration_sessions WHERE session_id = $1", [sessionId]);
    await sql.unsafe("DELETE FROM articles WHERE author_id = $1", [author]);
    await sql.unsafe("DELETE FROM user_profiles WHERE user_id = $1", [owner]);
    await sql.unsafe("DELETE FROM auth_accounts WHERE user_id = $1", [owner]);
  });
  const email = `media-replay-${suffix}@example.test`;
  db.prepare("INSERT INTO auth_accounts (user_id, email, password_hash) VALUES (?, ?, ?)").run(owner, email, "fixture-hash");
  await sql.unsafe("INSERT INTO auth_accounts (user_id, email, password_hash) VALUES ($1, $2, $3)", [owner, email, "fixture-hash"]);

  const targetProvider: Provider = sourceProvider === "sqlite" ? "postgres" : "sqlite";
  const sqliteStore = createSqliteStore(db);
  const source = sourceProvider === "sqlite" ? sqliteStore : postgresStore;
  const targetStore = sourceProvider === "sqlite" ? postgresStore : sqliteStore;
  const sourceJournal = sourceProvider === "sqlite" ? createSqliteProviderMigrationJournal(db) : createPostgresProviderMigrationJournal(sql);
  const target = sourceProvider === "sqlite" ? createPostgresProviderMigrationReplayer(sql) : createSqliteProviderMigrationReplayer(db);
  await sourceJournal.createSession({ sessionId, sourceProvider, targetProvider, schemaVersion: settings.schemaVersion ?? MIGRATION_REPLAY_SCHEMA_VERSION });
  await sourceJournal.transitionSession({ sessionId, expectedStatus: "prepared", nextStatus: "recording" });
  if (settings.prepare !== false) await prepareMigrationReplayTarget({ sourceJournal, targetJournal: target, sessionId, targetProvider });

  async function drain() {
    let remaining: number;
    do {
      const result = await replayNextMigrationBatch({ sourceJournal, target, sessionId, limit: 1 });
      remaining = result.remainingAtRead;
    } while (remaining > 0);
  }
  async function directTargetDelete(id: string) {
    if (targetProvider === "sqlite") db.prepare("DELETE FROM media_assets WHERE id = ?").run(id);
    else await sql.unsafe("DELETE FROM media_assets WHERE id = $1", [id]);
  }
  function asset(id: string) {
    return { id, ownerId: owner, storageKey: `fixture/${id}.webp`, contentType: "image/webp" as const, byteSize: 123, width: 10, height: 10, sha256: "a".repeat(64) };
  }
  return { db, suffix, owner, author, sessionId, sourceProvider, targetProvider, source, targetStore, sourceJournal, target, drain, directTargetDelete, asset };
}

async function refs(store: TypedPersistenceAdapterContract, ids: string[]) {
  const rows = await store.listReferencesForAssets({ assetIds: ids });
  return rows.map((row) => ({
    kind: row.kind, content: row.content,
    work: row.work ? {
      articleId: row.work.articleId, slug: row.work.slug, status: row.work.status,
      deleted: Boolean(row.work.deletedAt), locale: row.work.locale,
      title: row.work.title, authorId: row.work.authorId,
    } : null,
  })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

function blocks(...ids: string[]) {
  return ids.length
    ? ids.map((id, index) => ({ id: `image-${index}`, type: "image", src: `/api/v1/media/${id}`, alt: "" }))
    : [{ id: "p", type: "paragraph", text: "The image was removed." }];
}

for (const sourceProvider of ["sqlite", "postgres"] as const) {
  const targetProvider = sourceProvider === "sqlite" ? "postgres" : "sqlite";

  test(`${sourceProvider} → ${targetProvider}: article references survive edits, translations, tombstones, restore and purge`, options, async (t) => {
    const f = await fixture(t, sourceProvider);
    const first = randomUUID(), second = randomUUID(), purged = randomUUID();
    for (const id of [first, second, purged]) await f.source.createMediaAsset(f.asset(id));
    const input = {
      authorId: f.author, slug: `media-replay-${f.suffix}`, title: "Draft image", locale: "zh-CN",
      contentBlocks: blocks(first, first), publish: false,
    };
    const article = await f.source.createArticle(input);
    const initialChanges = await f.sourceJournal.readChangeBatch({ sessionId: f.sessionId, afterSequence: 0, limit: 100 });
    const articleTransaction = initialChanges.find((change) => change.entityType === "articles" && change.entityId === article.id)?.transactionId;
    assert.ok(articleTransaction);
    const originalEnvelope = initialChanges.filter((change) => change.transactionId === articleTransaction);
    await assert.rejects(Promise.resolve().then(() => f.target.applyTransaction(originalEnvelope)), /expected sequence/i, "an article cannot overtake its assets");
    assert.equal(await f.target.getCheckpoint(f.sessionId), 0);
    await f.drain();
    assert.deepEqual(await refs(f.targetStore, [first, second]), await refs(f.source, [first, second]), "draft references must survive replay");
    assert.equal((await refs(f.targetStore, [first])).length, 1, "duplicate image blocks share one materialized reference");
    const replayedReferences = extractMediaReferences(await f.targetStore.listReferencesForAssets({ assetIds: [first] }));
    assert.deepEqual(referencesForOwner(replayedReferences, first, f.owner), [{
      kind: "work", articleId: "", slug: "", title: "", locale: "", state: "draft", redacted: true,
    }], "the image owner cannot learn another author's unpublished work");
    const authorView = referencesForOwner(replayedReferences, first, f.author)[0];
    assert.ok(authorView?.kind === "work" && !authorView.redacted && authorView.articleId === article.id);
    assert.equal(await f.targetStore.deleteUnusedMediaAsset({ id: first, ownerId: `not-${f.owner}` }), null, "ownership is still enforced");
    assert.equal((await f.targetStore.deleteUnusedMediaAsset({ id: first, ownerId: f.owner }))?.deleted, null);
    await assert.rejects(f.directTargetDelete(first), /foreign key/i, "the database must independently refuse the delete");

    await f.source.updateArticle({ articleId: article.id, actorId: f.author, ...input, locale: "en", title: "English image", contentBlocks: blocks(first, second) });
    await f.drain();
    assert.deepEqual(await refs(f.targetStore, [first, second]), await refs(f.source, [first, second]), "translations have separate references");
    await f.source.updateArticle({ articleId: article.id, actorId: f.author, ...input, title: "Edited draft", contentBlocks: blocks(second) });
    await f.drain();
    assert.deepEqual(await refs(f.targetStore, [first, second]), await refs(f.source, [first, second]), "editing one locale must not remove another locale's references");

    await f.source.deleteArticle({ articleId: article.id, actorId: f.author });
    await f.drain();
    assert.deepEqual(await refs(f.targetStore, [first, second]), await refs(f.source, [first, second]), "recoverable tombstones retain references");
    assert.ok((await refs(f.targetStore, [first])).every((row) => row.work?.deleted));
    await f.source.restoreArticle({ articleId: article.id, actorId: f.author });
    await f.drain();
    assert.deepEqual(await refs(f.targetStore, [first, second]), await refs(f.source, [first, second]), "restore keeps every locale's references");
    assert.equal((await f.targetStore.deleteUnusedMediaAsset({ id: first, ownerId: f.owner }))?.deleted, null);

    await f.source.updateArticle({ articleId: article.id, actorId: f.author, ...input, contentBlocks: blocks() });
    await f.source.updateArticle({ articleId: article.id, actorId: f.author, ...input, locale: "en", contentBlocks: blocks() });
    await f.drain();
    assert.deepEqual(await refs(f.targetStore, [first, second]), []);
    assert.deepEqual(await refs(f.source, [first, second]), []);
    const beforeDuplicate = await f.target.getCheckpoint(f.sessionId);
    await f.target.applyTransaction(originalEnvelope);
    assert.equal(await f.target.getCheckpoint(f.sessionId), beforeDuplicate, "duplicate replay never rewinds the checkpoint");
    assert.deepEqual(await refs(f.targetStore, [first, second]), [], "a duplicate old snapshot cannot restore removed references");
    assert.ok((await f.source.deleteUnusedMediaAsset({ id: first, ownerId: f.owner }))?.deleted);
    await f.drain();
    assert.equal(await f.targetStore.getMediaAsset({ id: first }), null, "unused media deletion is replayed after references are removed");

    const swept = await f.source.createArticle({ ...input, slug: `media-sweep-${f.suffix}`, contentBlocks: blocks(purged) });
    await f.source.deleteArticle({ articleId: swept.id, actorId: f.author });
    await f.drain();
    assert.equal((await refs(f.targetStore, [purged])).length, 1);
    assert.equal((await f.source.purgeExpiredArticles({ retentionDays: 30, now: new Date(Date.now() + 31 * 86_400_000), limit: 10 })).purged, 1);
    await f.drain();
    assert.deepEqual(await refs(f.targetStore, [purged]), [], "hard-delete cascade releases references");
    assert.deepEqual(await refs(f.source, [purged]), []);
    assert.ok((await f.source.deleteUnusedMediaAsset({ id: purged, ownerId: f.owner }))?.deleted);
    await f.drain();
    assert.equal(await f.targetStore.getMediaAsset({ id: purged }), null);
  });

  test(`${sourceProvider} → ${targetProvider}: profile avatar replay preserves references and roles without granting access`, options, async (t) => {
    const f = await fixture(t, sourceProvider);
    const first = randomUUID(), second = randomUUID();
    await f.source.createMediaAsset(f.asset(first));
    await f.source.createMediaAsset(f.asset(second));
    const input = { userId: f.owner, displayName: "Profile", locale: "zh-CN", avatarUrl: `/api/v1/media/${first}` };
    await f.source.upsertAuthorProfile(input);
    await f.drain();
    assert.deepEqual(await refs(f.targetStore, [first, second]), await refs(f.source, [first, second]));
    assert.equal((await f.targetStore.deleteUnusedMediaAsset({ id: first, ownerId: f.owner }))?.deleted, null);
    await assert.rejects(f.directTargetDelete(first), /foreign key/i);
    assert.equal(await f.targetStore.getUserRole({ userId: f.owner }), "member");

    await f.source.setUserRole({ actorId: `editor-${f.suffix}`, userId: f.owner, role: "editor" });
    await f.source.upsertAuthorProfile({ ...input, avatarUrl: `/api/media/${second}` });
    await f.drain();
    assert.equal(await f.targetStore.getUserRole({ userId: f.owner }), "editor", "only the source's existing role is carried over");
    assert.deepEqual(await refs(f.targetStore, [first, second]), await refs(f.source, [first, second]));
    assert.deepEqual(await refs(f.targetStore, [first]), []);
    assert.equal((await f.targetStore.deleteUnusedMediaAsset({ id: second, ownerId: f.owner }))?.deleted, null);
    await assert.rejects(f.directTargetDelete(second), /foreign key/i);

    await f.source.setUserRole({ actorId: `editor-${f.suffix}`, userId: f.owner, role: "member" });
    await f.source.upsertAuthorProfile({ ...input, avatarUrl: null });
    await f.drain();
    assert.equal(await f.targetStore.getUserRole({ userId: f.owner }), "member");
    assert.deepEqual(await refs(f.targetStore, [first, second]), []);
    assert.ok((await f.source.deleteUnusedMediaAsset({ id: second, ownerId: f.owner }))?.deleted);
    await f.drain();
    assert.equal(await f.targetStore.getMediaAsset({ id: second }), null);
  });
}

for (const sourceProvider of ["sqlite", "postgres"] as const) {
  const targetProvider = sourceProvider === "sqlite" ? "postgres" : "sqlite";

  test(`${sourceProvider} → ${targetProvider}: a missing target asset rolls back the whole article transaction and checkpoint`, options, async (t) => {
    const f = await fixture(t, sourceProvider);
    const id = randomUUID();
    await f.source.createMediaAsset(f.asset(id));
    const article = await f.source.createArticle({
      authorId: f.author, slug: `media-rollback-${f.suffix}`, title: "Protected image", locale: "en", contentBlocks: blocks(id),
    });
    const first = await replayNextMigrationBatch({ sourceJournal: f.sourceJournal, target: f.target, sessionId: f.sessionId, limit: 1 });
    assert.equal(first.lastSequence, 1, "the asset transaction is replayed before its dependent article");
    await f.directTargetDelete(id); // Simulate a missing/incomplete target dependency, not a supported cutover.
    const before = await f.target.getCheckpoint(f.sessionId);
    await assert.rejects(f.drain(), /foreign key/i);
    assert.equal(await f.target.getCheckpoint(f.sessionId), before);
    assert.ok(!(await f.targetStore.listMyArticles({ actorId: f.author, locale: "en" })).some((row) => row.id === article.id));
    assert.deepEqual(await refs(f.targetStore, [id]), []);

    await f.targetStore.createMediaAsset(f.asset(id));
    await f.drain();
    assert.deepEqual(await refs(f.targetStore, [id]), await refs(f.source, [id]));
    assert.equal((await f.targetStore.deleteUnusedMediaAsset({ id, ownerId: f.owner }))?.deleted, null);
  });

  test(`${sourceProvider} → ${targetProvider}: a legacy translation without a reference snapshot fails closed`, options, async (t) => {
    const f = await fixture(t, sourceProvider);
    const article = await f.source.createArticle({
      authorId: f.author, slug: `legacy-media-${f.suffix}`, title: "Legacy snapshot", locale: "en",
      contentBlocks: [{ id: "p", type: "paragraph", text: "Old journals did not record media references." }],
    });
    const original = await f.sourceJournal.readChangeBatch({ sessionId: f.sessionId, afterSequence: 0, limit: 100 });
    const legacyFields = new Set(["article_id", "locale", "title", "summary", "content_blocks", "content_blocks_version", "created_at", "updated_at"]);
    const legacy = original.map((change) => {
      if (change.entityType !== "article_translations") return change;
      const payload = Object.fromEntries(Object.entries(change.payload ?? {}).filter(([key]) => legacyFields.has(key)));
      return { ...change, payload, changeHash: validateMigrationChange({ ...change, payload }).changeHash };
    });
    await assert.rejects(Promise.resolve().then(() => f.target.applyTransaction(legacy)), /media|reference|schema/i);
    assert.equal(await f.target.getCheckpoint(f.sessionId), 0, "the parent and ledger must roll back too");
    assert.ok(!(await f.targetStore.listMyArticles({ actorId: f.author, locale: "en" })).some((row) => row.id === article.id));
    await f.target.applyTransaction(original);
    assert.ok((await f.targetStore.listMyArticles({ actorId: f.author, locale: "en" })).some((row) => row.id === article.id));
  });

  test(`${sourceProvider} → ${targetProvider}: an uncoordinated existing media snapshot is rejected`, options, async (t) => {
    const f = await fixture(t, sourceProvider, { prepare: false });
    const id = randomUUID();
    await f.targetStore.createMediaAsset(f.asset(id));
    const existing = await f.targetStore.createArticle({
      authorId: f.author, slug: `old-target-${f.suffix}`, title: "Existing snapshot", locale: "en", contentBlocks: blocks(id),
    });
    // Even if this local target appears consistent, its source snapshot and
    // journal watermark have not been coordinated. Do not silently reuse it.
    assert.equal((await refs(f.targetStore, [id])).length, 1);
    await assert.rejects(
      prepareMigrationReplayTarget({ sourceJournal: f.sourceJournal, targetJournal: f.target, sessionId: f.sessionId, targetProvider }),
      /baseline|snapshot|empty/i,
    );
    assert.ok((await f.targetStore.listMyArticles({ actorId: f.author, locale: "en" })).some((row) => row.id === existing.id));
    assert.equal((await f.targetStore.deleteUnusedMediaAsset({ id, ownerId: f.owner }))?.deleted, null);
  });

  test(`${sourceProvider} → ${targetProvider}: an already-checkpointed old replay session cannot resume`, options, async (t) => {
    const f = await fixture(t, sourceProvider, { prepare: false, schemaVersion: "legacy-pre-media-refs" });
    const id = randomUUID();
    await f.source.createMediaAsset(f.asset(id));
    const [change] = await f.sourceJournal.readChangeBatch({ sessionId: f.sessionId, afterSequence: 0, limit: 10 });
    await f.target.createSession({ sessionId: f.sessionId, sourceProvider, targetProvider, schemaVersion: "legacy-pre-media-refs" });
    await f.target.transitionSession({ sessionId: f.sessionId, expectedStatus: "prepared", nextStatus: "recording" });
    await f.targetStore.createMediaAsset(f.asset(id));
    if (targetProvider === "sqlite") {
      const journal = createSqliteProviderMigrationJournal(f.db);
      f.db.exec("BEGIN IMMEDIATE");
      try { journal.markAppliedInTransaction(f.db, change); f.db.exec("COMMIT"); }
      catch (error) { f.db.exec("ROLLBACK"); throw error; }
    } else {
      const journal = createPostgresProviderMigrationJournal(sql);
      await sql.begin(async (tx) => { await journal.markAppliedInTransaction(tx, change); });
    }
    assert.equal(await f.target.getCheckpoint(f.sessionId), 1);
    await assert.rejects(prepareMigrationReplayTarget({ sourceJournal: f.sourceJournal, targetJournal: f.target, sessionId: f.sessionId, targetProvider }), /schema|legacy|version/i);
    await assert.rejects(replayNextMigrationBatch({ sourceJournal: f.sourceJournal, target: f.target, sessionId: f.sessionId }), /schema|legacy|version/i);
    await assert.rejects(Promise.resolve().then(() => f.target.applyTransaction([change])), /schema|legacy|version/i);
    assert.equal(await f.target.getCheckpoint(f.sessionId), 1);
    assert.ok(await f.targetStore.getMediaAsset({ id }));
  });
}

test("old profile snapshots cannot silently discard an avatar reference or invent a role", () => {
  for (const target of ["sqlite", "postgres"] as const) {
    assert.throws(() => prepareMigrationRowPayload(target, "user_profiles", "old-profile", {
      user_id: "old-profile", avatar_url: "/api/media/abc", website_url: null,
    }), /schema|avatar|role/i);
  }
});

for (const sourceProvider of ["sqlite", "postgres"] as const) {
  const targetProvider = sourceProvider === "sqlite" ? "postgres" : "sqlite";

  test(`${sourceProvider} → ${targetProvider}: failed source capture rolls back the article and materialized references`, options, async (t) => {
    const f = await fixture(t, sourceProvider);
    const id = randomUUID(), slug = `capture-rollback-${f.suffix}`;
    await f.source.createMediaAsset(f.asset(id));
    await f.drain();
    const nextBefore = (await f.sourceJournal.getSession(f.sessionId)).nextSequence;
    const input = { authorId: f.author, slug, title: "All or nothing", locale: "en", contentBlocks: blocks(id) };
    if (sourceProvider === "sqlite") {
      f.db.exec(`CREATE TRIGGER fail_media_capture BEFORE INSERT ON provider_migration_changes
        WHEN NEW.entity_type = 'article_translations' BEGIN SELECT RAISE(ABORT, 'media capture blocked'); END`);
    } else {
      // The generated identifier contains only hex digits, and this disposable
      // trigger fails only translation capture in the test database.
      const name = `media_capture_fail_${f.suffix.replaceAll("-", "")}`;
      await sql.unsafe(`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.entity_type = 'article_translations' THEN RAISE EXCEPTION 'media capture blocked'; END IF;
        RETURN NEW; END $$`);
      await sql.unsafe(`CREATE TRIGGER ${name} BEFORE INSERT ON provider_migration_changes FOR EACH ROW EXECUTE FUNCTION ${name}()`);
    }
    try {
      await assert.rejects(Promise.resolve().then(() => f.source.createArticle(input)), /media capture blocked/i);
      assert.equal((await f.sourceJournal.getSession(f.sessionId)).nextSequence, nextBefore);
      assert.ok(!(await f.source.listMyArticles({ actorId: f.author, locale: "en" })).some((row) => row.slug === slug));
      assert.deepEqual(await refs(f.source, [id]), [], "the earlier reference insert rolls back with capture");
      assert.equal(await f.target.getCheckpoint(f.sessionId), nextBefore - 1);
    } finally {
      if (sourceProvider === "sqlite") f.db.exec("DROP TRIGGER fail_media_capture");
      else {
        const name = `media_capture_fail_${f.suffix.replaceAll("-", "")}`;
        await sql.unsafe(`DROP TRIGGER ${name} ON provider_migration_changes`);
        await sql.unsafe(`DROP FUNCTION ${name}()`);
      }
    }
    await f.source.createArticle(input);
    await f.drain();
    assert.deepEqual(await refs(f.targetStore, [id]), await refs(f.source, [id]));
  });

  test(`${sourceProvider} → ${targetProvider}: avatar replay rolls back if its asset has not arrived`, options, async (t) => {
    const f = await fixture(t, sourceProvider);
    const id = randomUUID();
    await f.source.createMediaAsset(f.asset(id));
    await f.source.upsertAuthorProfile({ userId: f.owner, displayName: "Avatar", locale: "en", avatarUrl: `/api/media/${id}` });
    const first = await replayNextMigrationBatch({ sourceJournal: f.sourceJournal, target: f.target, sessionId: f.sessionId, limit: 1 });
    await f.directTargetDelete(id);
    await assert.rejects(f.drain(), /foreign key/i);
    assert.equal(await f.target.getCheckpoint(f.sessionId), first.lastSequence);
    assert.equal(await f.targetStore.getAuthorProfile({ userId: f.owner, locale: "en" }), null);
    await f.targetStore.createMediaAsset(f.asset(id));
    await f.drain();
    assert.deepEqual(await refs(f.targetStore, [id]), await refs(f.source, [id]));
    await assert.rejects(f.directTargetDelete(id), /foreign key/i);
  });
}

test("media replay validates complete snapshots without treating metadata as a SQL column", () => {
  const entityId = JSON.stringify(["article", "en"]);
  const row = { article_id: "article", locale: "en", content_blocks: "[]" };
  for (const target of ["sqlite", "postgres"] as const) {
    for (const value of [null, {}, ["a", "a"], [""], [17]]) {
      assert.throws(() => prepareMigrationRowPayload(target, "article_translations", entityId, { ...row, [ARTICLE_MEDIA_REFS_SNAPSHOT]: value }), /reference|media|snapshot/i);
    }
    assert.throws(() => prepareMigrationRowPayload(target, "article_translations", entityId, { ...row, [ARTICLE_MEDIA_REFS_SNAPSHOT]: [], other: "not allowed" }), /unsupported columns/i);
    assert.throws(() => prepareMigrationRowPayload(target, "article_translations", JSON.stringify(["other", "en"]), { ...row, [ARTICLE_MEDIA_REFS_SNAPSHOT]: [] }), /does not match/i);
    const prepared = prepareMigrationRowPayload(target, "article_translations", entityId, { ...row, [ARTICLE_MEDIA_REFS_SNAPSHOT]: ["asset"] });
    assert.deepEqual(prepared.articleMediaRefs, ["asset"]);
    assert.ok(!prepared.columns.includes(ARTICLE_MEDIA_REFS_SNAPSHOT), "journal metadata never becomes an SQL identifier");
    assert.doesNotThrow(() => prepareMigrationRowPayload(target, "user_profiles", "profile", { user_id: "profile", role: "member", avatar_url: null, avatar_media_id: null }));
    assert.throws(() => prepareMigrationRowPayload(target, "user_profiles", "profile", { user_id: "profile", role: "member", avatar_url: null, avatar_media_id: 1 }), /avatar/i);
  }
});

for (const sourceProvider of ["sqlite", "postgres"] as const) {
  const targetProvider = sourceProvider === "sqlite" ? "postgres" : "sqlite";
  for (const existing of ["asset", "translation", "avatar"] as const) {
    test(`${sourceProvider} → ${targetProvider}: pre-existing ${existing} alone is not an attested baseline`, options, async (t) => {
      const f = await fixture(t, sourceProvider, { prepare: false });
      const id = randomUUID();
      if (existing === "asset") await f.targetStore.createMediaAsset(f.asset(id));
      if (existing === "translation") await f.targetStore.createArticle({
        authorId: f.author, slug: `old-translation-${f.suffix}`, title: "Old translation", locale: "en", contentBlocks: blocks(),
      });
      if (existing === "avatar") await f.targetStore.upsertAuthorProfile({
        userId: f.owner, displayName: "Old avatar", locale: "en", avatarUrl: `/api/media/${id}`,
      });
      await assert.rejects(prepareMigrationReplayTarget({ sourceJournal: f.sourceJournal, targetJournal: f.target, sessionId: f.sessionId, targetProvider }), /baseline|snapshot|empty/i);
    });
  }

  test(`${sourceProvider} → ${targetProvider}: the first apply rechecks the baseline after prepare`, options, async (t) => {
    const f = await fixture(t, sourceProvider);
    const unexpected = randomUUID(), incoming = randomUUID();
    await f.targetStore.createMediaAsset(f.asset(unexpected));
    await f.source.createMediaAsset(f.asset(incoming));
    await assert.rejects(f.drain(), /baseline|snapshot|empty/i);
    assert.equal(await f.target.getCheckpoint(f.sessionId), 0);
    assert.equal(await f.targetStore.getMediaAsset({ id: incoming }), null);
    await f.directTargetDelete(unexpected);
    await f.drain();
    assert.ok(await f.targetStore.getMediaAsset({ id: incoming }));
  });
}

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
type Deferred<T = void> = ReturnType<typeof deferred<T>>;

async function bounded<T>(promise: Promise<T>, description: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`Timed out waiting for ${description}`)), 10_000); }),
    ]);
  } finally { if (timer) clearTimeout(timer); }
}

// Pause after the real PostgreSQL transaction has done all its work, before it
// commits. The competing connection is observed through pg_blocking_pids.
function holdBeforeCommit(db: PgDatabase, ready: Deferred<number>, release: Deferred): PgDatabase {
  return {
    unsafe: (...args) => db.unsafe(...args), end: (...args) => db.end(...args),
    begin: (work) => db.begin(async (tx) => {
      const [backend] = await tx.unsafe<{ pid: number }>("SELECT pg_backend_pid() AS pid");
      const result = await work(tx);
      ready.resolve(backend.pid);
      await release.promise;
      return result;
    }),
  };
}

function observeAttempt(db: PgDatabase, prefix: string, attempting: Deferred<number>): PgDatabase {
  return {
    unsafe: (...args) => db.unsafe(...args), end: (...args) => db.end(...args),
    begin: (work) => db.begin(async (tx) => {
      const [backend] = await tx.unsafe<{ pid: number }>("SELECT pg_backend_pid() AS pid");
      return work({
        unsafe<TRow = PgRow>(query: string, parameters?: readonly unknown[]): Promise<TRow[]> {
          if (query.startsWith(prefix)) attempting.resolve(backend.pid);
          return tx.unsafe<TRow>(query, parameters);
        },
      });
    }),
  };
}

async function waitUntilBlockedBy(waiter: number, blocker: number): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const [row] = await sql.unsafe<{ blocked: boolean }>("SELECT $2::integer = ANY(pg_blocking_pids($1::integer)) AS blocked", [waiter, blocker]);
    if (row.blocked) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("The competing PostgreSQL transaction did not wait on the held lock.");
}

for (const winner of ["replay", "delete"] as const) {
  test(`PostgreSQL target: ${winner} commits first when replay and media deletion overlap`, options, async (t) => {
    const f = await fixture(t, "sqlite");
    const id = randomUUID();
    await f.source.createMediaAsset(f.asset(id));
    const article = await f.source.createArticle({
      authorId: f.author, slug: `media-race-${f.suffix}`, title: "Race image", locale: "en", contentBlocks: blocks(id),
    });
    const first = await replayNextMigrationBatch({ sourceJournal: f.sourceJournal, target: f.target, sessionId: f.sessionId, limit: 1 });
    const envelope = await f.sourceJournal.readChangeBatch({ sessionId: f.sessionId, afterSequence: first.lastSequence, limit: 100 });
    assert.equal(envelope.length, 2);
    assert.equal(envelope[0].transactionId, envelope[1].transactionId);
    const ready = deferred<number>(), release = deferred(), attempting = deferred<number>();
    const held = holdBeforeCommit(sql, ready, release);
    let applying: Promise<void> | undefined;
    let deleting: Promise<Awaited<ReturnType<TypedPersistenceAdapterContract["deleteUnusedMediaAsset"]>>> | undefined;
    try {
      if (winner === "replay") {
        applying = createPostgresProviderMigrationReplayer(held).applyTransaction(envelope);
        void applying.catch(() => {});
        const blocker = await bounded(ready.promise, "the replay transaction to hold its reference");
        const deleter = createPostgresStore(observeAttempt(sql, "SELECT * FROM media_assets WHERE id", attempting));
        deleting = deleter.deleteUnusedMediaAsset({ id, ownerId: f.owner });
        void deleting.catch(() => {});
        const waiter = await bounded(attempting.promise, "the competing delete to request its lock");
        await waitUntilBlockedBy(waiter, blocker);
        release.resolve();
        await bounded(applying, "replay to commit");
        assert.equal((await bounded(deleting, "delete to finish"))?.deleted, null);
        assert.deepEqual(await refs(f.targetStore, [id]), await refs(f.source, [id]));
        await assert.rejects(f.directTargetDelete(id), /foreign key/i);
      } else {
        deleting = createPostgresStore(held).deleteUnusedMediaAsset({ id, ownerId: f.owner });
        void deleting.catch(() => {});
        const blocker = await bounded(ready.promise, "the delete to hold the asset lock");
        const target = createPostgresProviderMigrationReplayer(observeAttempt(sql, "INSERT INTO article_media_refs", attempting));
        applying = target.applyTransaction(envelope);
        void applying.catch(() => {});
        const waiter = await bounded(attempting.promise, "the replay to insert its reference");
        await waitUntilBlockedBy(waiter, blocker);
        release.resolve();
        assert.ok((await bounded(deleting, "delete to commit"))?.deleted);
        await assert.rejects(bounded(applying, "replay to fail closed"), /foreign key/i);
        assert.equal(await f.target.getCheckpoint(f.sessionId), first.lastSequence);
        assert.ok(!(await f.targetStore.listMyArticles({ actorId: f.author, locale: "en" })).some((row) => row.id === article.id));
        assert.equal(await f.targetStore.getMediaAsset({ id }), null);
      }
    } finally {
      release.resolve();
      await Promise.allSettled([...(applying ? [applying] : []), ...(deleting ? [deleting] : [])]);
    }
  });
}

type SqliteRaceOutcome =
  | { ok: true; result: { deleted?: unknown; usedBy?: unknown[] } | undefined }
  | { ok: false; name: string; message: string };
function sqliteRaceWorker(input: { filename: string; operation: "replay" | "delete" | "update"; assetId: string; ownerId: string; changes: MigrationChange[]; update?: { articleId: string; actorId: string; slug: string; title: string; locale: string; contentBlocks: { id: string; type: string; src: string; alt: string }[] }; gate?: SharedArrayBuffer }) {
  const beginning = deferred(), holding = deferred(), done = deferred<SqliteRaceOutcome>();
  let outcome: SqliteRaceOutcome | undefined;
  const worker = new Worker(new URL("./test-support/sqlite-media-replay-race-worker.ts", import.meta.url), { workerData: input });
  const finish = (value: SqliteRaceOutcome) => {
    if (outcome) return;
    outcome = value;
    beginning.resolve(); holding.resolve(); done.resolve(value);
  };
  worker.on("message", (message: { type: string; result?: { deleted?: unknown; usedBy?: unknown[] }; name?: string; message?: string }) => {
    if (message.type === "before-begin") beginning.resolve();
    if (message.type === "before-commit") holding.resolve();
    if (message.type === "done") finish({ ok: true, result: message.result });
    if (message.type === "error") finish({ ok: false, name: message.name ?? "Error", message: message.message ?? "Worker failed" });
  });
  worker.on("error", (error) => finish({ ok: false, name: error.name, message: error.message }));
  worker.on("exit", (code) => finish({ ok: false, name: "WorkerExit", message: `Worker exited before reporting its result (${code})` }));
  return {
    worker,
    async beginning() { await bounded(beginning.promise, "the SQLite transaction to begin"); },
    async holding() {
      await bounded(holding.promise, "the SQLite transaction to hold its write lock");
      if (outcome?.ok === false) throw new Error(`${outcome.name}: ${outcome.message}`);
    },
    done: () => bounded(done.promise, "the SQLite worker result"),
  };
}

for (const winner of ["replay", "delete"] as const) {
  test(`SQLite target: ${winner} commits first when replay and media deletion overlap`, options, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "nw-media-replay-race-"));
    const filename = join(directory, "target.sqlite");
    const f = await fixture(t, "postgres", { sqliteFile: filename });
    t.after(() => rm(directory, { recursive: true, force: true }));
    const id = randomUUID(), workers: Worker[] = [], gate = new SharedArrayBuffer(4);
    await f.source.createMediaAsset(f.asset(id));
    const article = await f.source.createArticle({
      authorId: f.author, slug: `media-race-${f.suffix}`, title: "Race image", locale: "en", contentBlocks: blocks(id),
    });
    const first = await replayNextMigrationBatch({ sourceJournal: f.sourceJournal, target: f.target, sessionId: f.sessionId, limit: 1 });
    const envelope = await f.sourceJournal.readChangeBatch({ sessionId: f.sessionId, afterSequence: first.lastSequence, limit: 100 });
    assert.equal(envelope.length, 2);
    const common = { filename, assetId: id, ownerId: f.owner, changes: envelope };
    try {
      const firstWorker = sqliteRaceWorker({ ...common, operation: winner, gate }); workers.push(firstWorker.worker);
      await firstWorker.holding();
      const observer = createSqliteClient({ filename, timeoutMs: 0, enableWal: false });
      try { assert.throws(() => observer.exec("BEGIN IMMEDIATE"), /locked|busy/i, "the first transaction holds SQLite's write lock"); }
      finally { if (observer.isTransaction) observer.exec("ROLLBACK"); observer.close(); }
      const secondWorker = sqliteRaceWorker({ ...common, operation: winner === "replay" ? "delete" : "replay" }); workers.push(secondWorker.worker);
      await secondWorker.beginning();
      Atomics.store(new Int32Array(gate), 0, 1); Atomics.notify(new Int32Array(gate), 0);
      const firstResult = await firstWorker.done(), secondResult = await secondWorker.done();
      if (firstResult.ok === false) throw new Error(`${firstResult.name}: ${firstResult.message}`);
      if (winner === "replay") {
        if (secondResult.ok === false) throw new Error(`${secondResult.name}: ${secondResult.message}`);
        assert.equal(secondResult.result?.deleted, null);
        assert.deepEqual(await refs(f.targetStore, [id]), await refs(f.source, [id]));
        await assert.rejects(f.directTargetDelete(id), /foreign key/i);
      } else {
        assert.ok(firstResult.result?.deleted);
        assert.ok(secondResult.ok === false && /foreign key/i.test(secondResult.message));
        assert.equal(await f.target.getCheckpoint(f.sessionId), first.lastSequence);
        assert.ok(!(await f.targetStore.listMyArticles({ actorId: f.author, locale: "en" })).some((row) => row.id === article.id));
        assert.equal(await f.targetStore.getMediaAsset({ id }), null);
      }
    } finally {
      Atomics.store(new Int32Array(gate), 0, 1); Atomics.notify(new Int32Array(gate), 0);
      await Promise.all(workers.map((worker) => worker.terminate()));
    }
  });
}

test("PostgreSQL source: overlapping translation edits capture the committed reference sets in order", options, async (t) => {
  const f = await fixture(t, "postgres");
  const [initial, firstId, secondId] = [randomUUID(), randomUUID(), randomUUID()];
  for (const id of [initial, firstId, secondId]) await f.source.createMediaAsset(f.asset(id));
  const slug = `source-edit-race-${f.suffix}`;
  const article = await f.source.createArticle({ authorId: f.author, slug, title: "Initial", locale: "en", contentBlocks: blocks(initial) });
  await f.drain();
  const ready = deferred<number>(), release = deferred(), attempting = deferred<number>();
  let first: Promise<unknown> | undefined, second: Promise<unknown> | undefined;
  try {
    first = Promise.resolve(createPostgresStore(holdBeforeCommit(sql, ready, release)).updateArticle({
      articleId: article.id, actorId: f.author, slug, title: "First", locale: "en", contentBlocks: blocks(firstId),
    }));
    void first.catch(() => {});
    const blocker = await bounded(ready.promise, "the first source edit to hold its transaction");
    second = Promise.resolve(createPostgresStore(observeAttempt(sql, "SELECT author_id, deleted_at FROM articles", attempting)).updateArticle({
      articleId: article.id, actorId: f.author, slug, title: "Second", locale: "en", contentBlocks: blocks(secondId),
    }));
    void second.catch(() => {});
    const waiter = await bounded(attempting.promise, "the second source edit to request its article lock");
    await waitUntilBlockedBy(waiter, blocker);
    release.resolve();
    await bounded(first, "the first source edit to commit");
    await bounded(second, "the second source edit to commit");
    await f.drain();
    assert.deepEqual(await refs(f.targetStore, [initial, firstId, secondId]), await refs(f.source, [initial, firstId, secondId]));
    assert.equal((await refs(f.targetStore, [secondId])).length, 1);
    assert.deepEqual(await refs(f.targetStore, [initial, firstId]), []);
  } finally {
    release.resolve();
    await Promise.allSettled([...(first ? [first] : []), ...(second ? [second] : [])]);
  }
});

test("SQLite source: overlapping translation edits serialize their reference snapshots and journal order", options, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "nw-media-source-race-"));
  const filename = join(directory, "source.sqlite");
  const f = await fixture(t, "sqlite", { sqliteFile: filename });
  t.after(() => rm(directory, { recursive: true, force: true }));
  const [initial, firstId, secondId] = [randomUUID(), randomUUID(), randomUUID()];
  for (const id of [initial, firstId, secondId]) await f.source.createMediaAsset(f.asset(id));
  const slug = `source-edit-race-${f.suffix}`;
  const article = await f.source.createArticle({ authorId: f.author, slug, title: "Initial", locale: "en", contentBlocks: blocks(initial) });
  await f.drain();
  const workers: Worker[] = [], gate = new SharedArrayBuffer(4);
  const common = { filename, operation: "update" as const, assetId: initial, ownerId: f.owner, changes: [] };
  const update = (id: string, title: string) => ({
    articleId: article.id, actorId: f.author, slug, title, locale: "en",
    contentBlocks: [{ id: "image", type: "image", src: `/api/v1/media/${id}`, alt: "" }],
  });
  try {
    const first = sqliteRaceWorker({ ...common, update: update(firstId, "First"), gate }); workers.push(first.worker);
    await first.holding();
    const observer = createSqliteClient({ filename, timeoutMs: 0, enableWal: false });
    try { assert.throws(() => observer.exec("BEGIN IMMEDIATE"), /locked|busy/i); }
    finally { if (observer.isTransaction) observer.exec("ROLLBACK"); observer.close(); }
    const second = sqliteRaceWorker({ ...common, update: update(secondId, "Second") }); workers.push(second.worker);
    await second.beginning();
    Atomics.store(new Int32Array(gate), 0, 1); Atomics.notify(new Int32Array(gate), 0);
    const firstResult = await first.done(), secondResult = await second.done();
    if (firstResult.ok === false) throw new Error(`${firstResult.name}: ${firstResult.message}`);
    if (secondResult.ok === false) throw new Error(`${secondResult.name}: ${secondResult.message}`);
    await f.drain();
    assert.deepEqual(await refs(f.targetStore, [initial, firstId, secondId]), await refs(f.source, [initial, firstId, secondId]));
    assert.equal((await refs(f.targetStore, [secondId])).length, 1);
    assert.deepEqual(await refs(f.targetStore, [initial, firstId]), []);
  } finally {
    Atomics.store(new Int32Array(gate), 0, 1); Atomics.notify(new Int32Array(gate), 0);
    await Promise.all(workers.map((worker) => worker.terminate()));
  }
});

for (const sourceProvider of ["sqlite", "postgres"] as const) {
  const targetProvider = sourceProvider === "sqlite" ? "postgres" : "sqlite";
  test(`${sourceProvider} → ${targetProvider}: a translation tombstone clears only that locale's references`, options, async (t) => {
    const f = await fixture(t, sourceProvider);
    const id = randomUUID();
    await f.source.createMediaAsset(f.asset(id));
    const article = await f.source.createArticle({
      authorId: f.author, slug: `locale-delete-${f.suffix}`, title: "Chinese", locale: "zh-CN", contentBlocks: blocks(id),
    });
    await f.source.updateArticle({ articleId: article.id, actorId: f.author, slug: `locale-delete-${f.suffix}`, title: "English", locale: "en", contentBlocks: blocks(id) });
    await f.drain();
    assert.equal((await refs(f.targetStore, [id])).length, 2);
    // There is no public locale-delete operation today. Construct its captured
    // delete envelope with matching source mutations in one real transaction,
    // exercising the applier's contract without claiming a new API exists.
    const change = { sessionId: f.sessionId, changeId: randomUUID(), transactionId: randomUUID(),
      entityType: "article_translations", entityId: JSON.stringify([article.id, "en"]), operation: "delete" as const, payload: null };
    if (sourceProvider === "sqlite") {
      const journal = createSqliteProviderMigrationJournal(f.db);
      f.db.exec("BEGIN IMMEDIATE");
      try {
        f.db.prepare("DELETE FROM article_media_refs WHERE article_id = ? AND locale = ?").run(article.id, "en");
        f.db.prepare("DELETE FROM article_translations WHERE article_id = ? AND locale = ?").run(article.id, "en");
        journal.appendChangeInTransaction(f.db, change);
        f.db.exec("COMMIT");
      } catch (error) { f.db.exec("ROLLBACK"); throw error; }
    } else {
      const journal = createPostgresProviderMigrationJournal(sql);
      await sql.begin(async (tx) => {
        await tx.unsafe("DELETE FROM article_media_refs WHERE article_id = $1 AND locale = $2", [article.id, "en"]);
        await tx.unsafe("DELETE FROM article_translations WHERE article_id = $1 AND locale = $2", [article.id, "en"]);
        await journal.appendChangeInTransaction(tx, change);
      });
    }
    await f.drain();
    const targetRefs = await refs(f.targetStore, [id]);
    assert.deepEqual(targetRefs, await refs(f.source, [id]));
    assert.equal(targetRefs.length, 1);
    assert.equal(targetRefs[0].work?.locale, "zh-CN");
    await assert.rejects(f.directTargetDelete(id), /foreign key/i);
  });
}

test("SQLite target refuses replay while foreign-key enforcement is disabled", options, async (t) => {
  const f = await fixture(t, "postgres");
  const id = randomUUID();
  await f.source.createMediaAsset(f.asset(id));
  await f.source.createArticle({ authorId: f.author, slug: `fk-disabled-${f.suffix}`, title: "Foreign key", locale: "en", contentBlocks: blocks(id) });
  f.db.exec("PRAGMA foreign_keys = OFF");
  try {
    await assert.rejects(f.drain(), /foreign.key|constraint/i);
    assert.equal(await f.target.getCheckpoint(f.sessionId), 0, "an unsafe connection cannot advance a checkpoint");
    assert.equal(await f.targetStore.getMediaAsset({ id }), null);
  } finally { f.db.exec("PRAGMA foreign_keys = ON"); }
  await f.drain();
  assert.deepEqual(await refs(f.targetStore, [id]), await refs(f.source, [id]));
  await assert.rejects(f.directTargetDelete(id), /foreign key/i);
});

test("SQLite target rechecks foreign keys after a checkpoint has advanced", options, async (t) => {
  const f = await fixture(t, "postgres");
  const id = randomUUID();
  await f.source.createMediaAsset(f.asset(id));
  await f.source.createArticle({ authorId: f.author, slug: `fk-resume-${f.suffix}`, title: "Foreign key resume", locale: "en", contentBlocks: blocks(id) });
  const first = await replayNextMigrationBatch({ sourceJournal: f.sourceJournal, target: f.target, sessionId: f.sessionId, limit: 1 });
  f.db.exec("PRAGMA foreign_keys = OFF");
  try {
    await assert.rejects(f.drain(), /foreign.key|constraint/i);
    assert.equal(await f.target.getCheckpoint(f.sessionId), first.lastSequence);
    assert.deepEqual(await refs(f.targetStore, [id]), []);
  } finally { f.db.exec("PRAGMA foreign_keys = ON"); }
  await f.drain();
  assert.deepEqual(await refs(f.targetStore, [id]), await refs(f.source, [id]));
  await assert.rejects(f.directTargetDelete(id), /foreign key/i);
});

test("PostgreSQL target refuses replay while replication mode disables foreign-key triggers", options, async (t) => {
  const f = await fixture(t, "sqlite");
  const id = randomUUID();
  await f.source.createMediaAsset(f.asset(id));
  await f.source.createArticle({ authorId: f.author, slug: `pg-fk-disabled-${f.suffix}`, title: "Foreign key", locale: "en", contentBlocks: blocks(id) });
  const [assetChange] = await f.sourceJournal.readChangeBatch({ sessionId: f.sessionId, afterSequence: 0, limit: 1 });
  const [permissions] = await sql.unsafe<{ can_set: boolean }>("SELECT has_parameter_privilege(current_user, 'session_replication_role', 'SET') AS can_set");
  function replicaTarget(simulate: boolean) {
    const replicaConnection: PgDatabase = {
      unsafe: (...args) => sql.unsafe(...args), end: (...args) => sql.end(...args),
      begin: (work) => sql.begin(async (tx) => {
        if (!simulate && permissions.can_set) {
          // Exercise the real server setting when the disposable test role may set it.
          await tx.unsafe("SET LOCAL session_replication_role = replica");
          return work(tx);
        }
        // PostgreSQL refuses the unsafe setting for an unprivileged role. Still
        // exercise the guard by simulating only its setting query; every other
        // statement uses the real transaction, and no check is skipped.
        return work({
          unsafe<TRow = PgRow>(query: string, parameters?: readonly unknown[]): Promise<TRow[]> {
            if (query === "SELECT current_setting('session_replication_role') AS role") return Promise.resolve([{ role: "replica" } as TRow]);
            return tx.unsafe<TRow>(query, parameters);
          },
        });
      }),
    };
    return createPostgresProviderMigrationReplayer(replicaConnection);
  }
  const unsafeTargets = [replicaTarget(false), replicaTarget(true)];
  const rejectedUnsafeConnection = (error: unknown) => (error as { code?: string }).code === "FOREIGN_KEYS_DISABLED";
  for (const target of unsafeTargets) await assert.rejects(target.applyTransaction([assetChange]), rejectedUnsafeConnection);
  assert.equal(await f.target.getCheckpoint(f.sessionId), 0);
  assert.equal(await f.targetStore.getMediaAsset({ id }), null);
  const first = await replayNextMigrationBatch({ sourceJournal: f.sourceJournal, target: f.target, sessionId: f.sessionId, limit: 1 });
  const articleChanges = await f.sourceJournal.readChangeBatch({ sessionId: f.sessionId, afterSequence: first.lastSequence, limit: 1 });
  for (const target of unsafeTargets) await assert.rejects(target.applyTransaction(articleChanges), rejectedUnsafeConnection);
  assert.equal(await f.target.getCheckpoint(f.sessionId), first.lastSequence);
  assert.deepEqual(await refs(f.targetStore, [id]), []);
  await f.drain();
  assert.deepEqual(await refs(f.targetStore, [id]), await refs(f.source, [id]));
  await assert.rejects(f.directTargetDelete(id), /foreign key/i);
});

test("SQLite target refuses a dangling pre-existing reference even after foreign keys are re-enabled", options, async (t) => {
  const f = await fixture(t, "postgres");
  const id = randomUUID();
  await f.source.createMediaAsset(f.asset(id));
  // Simulate an old target populated without FK enforcement. Enabling the
  // pragma does not retroactively check or remove already-invalid rows.
  f.db.exec("PRAGMA foreign_keys = OFF");
  try {
    f.db.prepare("INSERT INTO article_media_refs (asset_id, article_id, locale) VALUES (?, ?, ?)").run(id, randomUUID(), "en");
  } finally { f.db.exec("PRAGMA foreign_keys = ON"); }
  await assert.rejects(f.drain(), (error: unknown) => (error as { code?: string }).code === "UNVERIFIED_MEDIA_BASELINE");
  assert.equal(await f.target.getCheckpoint(f.sessionId), 0);
  assert.equal(await f.targetStore.getMediaAsset({ id }), null);
});
