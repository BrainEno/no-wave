import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import type { CommitNotionImportWorkInput } from "../../application/notion-import-plan.ts";
import type { UpdateArticleInput } from "../../application/persistence-ports.ts";
import sharp from "sharp";
import { createApplicationServices } from "../../application/services.ts";
import { createMediaAssetService } from "../../application/media-assets.ts";
import { importNotionBundle } from "../../application/notion-import.ts";
import { createNotionImportPlanCodec, NOTION_IMPORT_PLAN_TTL_MS } from "../../application/notion-import-plan.ts";
import { createApiServer } from "../../server.ts";
import { createSqliteClient, runSqliteMigrations } from "../../persistence/sqlite.ts";
import { createSqliteStore } from "../../persistence/sqlite-store.ts";
import { createSqliteProviderMigrationJournal } from "../../persistence/sqlite-provider-migration-journal.ts";
import { createPostgresProviderMigrationJournal } from "../../persistence/postgres-provider-migration-journal.ts";
import { transferProviderData } from "../../persistence/provider-migration-transfer.ts";
import { MIGRATION_REPLAY_SCHEMA_VERSION } from "../../persistence/provider-migration-journal.ts";
import type { PgDatabase, PgRow } from "../../persistence/postgres-driver.ts";
import { createPostgresStore } from "../../persistence/postgres.ts";
import { createIsolatedPostgresTestSchema } from "../../persistence/test-support/isolated-postgres-schema.ts";

const env = {
  AUTH_JWT_SECRET: "version-protection-test-only-secret-at-least-thirty-two-bytes",
  AUTH_JWT_ISSUER: "https://auth.example.test",
  AUTH_JWT_AUDIENCE: "bot-thk-api",
};
function token(sub: string): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const unsigned = `${encode({ alg: "HS256", typ: "application/vnd.bot-thk.access+jwt" })}.${encode({
    sub, iss: env.AUTH_JWT_ISSUER, aud: env.AUTH_JWT_AUDIENCE, iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 600, sid: `session-${sub}`, jti: randomUUID(),
  })}`;
  return `${unsigned}.${createHmac("sha256", env.AUTH_JWT_SECRET).update(unsigned).digest("base64url")}`;
}
const richText = (content: string) => ({ type: "text", plain_text: content, text: { content } });
function page(id = randomUUID(), body = "source body") {
  return { id, properties: {
    Page: { type: "title", title: [richText("Conditional import")] },
    Published: { type: "checkbox", checkbox: true },
  }, blocks: [{ object: "block", id: "p", type: "paragraph", has_children: false,
    paragraph: { rich_text: [richText(body)] } }] };
}
const bundle = (...pages: ReturnType<typeof page>[]) => ({ version: 1, database: { id: "version-test" }, pages });

async function fixture(provider: "sqlite" | "postgres") {
  const db = provider === "sqlite" ? createSqliteClient({ filename: ":memory:", enableWal: false }) : null;
  const pg = provider === "postgres" ? await createIsolatedPostgresTestSchema(process.env.TEST_DATABASE_URL!) : null;
  const sql = pg?.sql ?? null;
  if (db) await runSqliteMigrations(db);
  const store = db ? createSqliteStore(db) : createPostgresStore(sql!);
  const author = randomUUID();
  const server = createApiServer({ store, env, logger: () => {} });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}/api/v1`;
  const call = async (path: string, body?: unknown, actor = author, method = "POST", status = 200) => {
    const response = await fetch(base + path, { method, headers: {
      "content-type": "application/json", authorization: `Bearer ${token(actor)}`,
    }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const result = await response.json();
    assert.equal(response.status, status, JSON.stringify(result));
    return result;
  };
  const preview = async (source: unknown, actor = author) => (await call("/imports/notion", { bundle: source }, actor)).data;
  const apply = async (source: unknown, planToken: string, actor = author) =>
    (await call("/imports/notion", { bundle: source, apply: true, planToken }, actor)).data;
  const importFresh = async (source: unknown) => apply(source, (await preview(source)).planToken);
  const own = async () => (await call("/me/articles?allLocales=true", undefined, author, "GET")).data;
  return { db, sql, store, author, call, preview, apply, importFresh, own,
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (db) db.close();
      if (pg) await pg.cleanup();
    },
  };
}

async function applicationImport(f: Awaited<ReturnType<typeof fixture>>, source: unknown) {
  const deps = createApplicationServices({ persistence: f.store, env });
  const preview = await importNotionBundle({ actorId: f.author, bundle: source, apply: false, deps });
  return importNotionBundle({ actorId: f.author, bundle: source, apply: true, planToken: preview.planToken, deps });
}

async function recordingJournal(f: Awaited<ReturnType<typeof fixture>>, provider: "sqlite" | "postgres") {
  const journal = f.db ? createSqliteProviderMigrationJournal(f.db) : createPostgresProviderMigrationJournal(f.sql!);
  const sessionId = randomUUID();
  await journal.createSession({ sessionId, sourceProvider: provider, targetProvider: provider === "sqlite" ? "postgres" : "sqlite", schemaVersion: MIGRATION_REPLAY_SCHEMA_VERSION });
  await journal.transitionSession({ sessionId, expectedStatus: "prepared", nextStatus: "recording" });
  return { journal, sessionId };
}

for (const provider of ["sqlite", "postgres"] as const) {
  const options = { skip: provider === "postgres" && !process.env.TEST_DATABASE_URL && "Set TEST_DATABASE_URL to run PostgreSQL integration tests." };

  test(`conditional article updates reject an old work revision, including another locale (${provider})`, options, async () => {
    const f = await fixture(provider);
    try {
      await f.importFresh(bundle(page()));
      const [article] = await f.own();
      assert.match(article.revision, /^\d+$/);
      const write = { slug: article.slug, title: "edited in desk", contentBlocks: [{ id: "p", type: "paragraph", text: "desk body" }],
        locale: "zh-CN", publish: true, expectedRevision: article.revision };
      const updated = (await f.call(`/articles/${article.id}`, write, f.author, "PUT")).data;
      assert.ok(BigInt(updated.revision) > BigInt(article.revision));
      const rejected = await f.call(`/articles/${article.id}`, { ...write, title: "stale overwrite" }, f.author, "PUT", 409);
      assert.equal(rejected.error.code, "ARTICLE_VERSION_CONFLICT");
      await f.call(`/articles/${article.id}`, { ...write, locale: "en" }, f.author, "PUT", 409);
      assert.equal((await f.own()).length, 1, "a stale write cannot add a translation");
      assert.equal((await f.own())[0].title, "edited in desk");
    } finally { await f.close(); }
  });

  test(`full bigint work revisions survive reads, writes and journal capture (${provider})`, options, async () => {
    const f = await fixture(provider);
    try {
      const article = await f.store.createArticle({ authorId: f.author, slug: "big-revision", title: "initial",
        contentBlocks: [{ id: "p", type: "paragraph", text: "initial" }] });
      const revision = "9007199254740993";
      if (f.db) f.db.prepare("UPDATE articles SET import_revision = ? WHERE id = ?").run(BigInt(revision), article.id);
      else await f.sql!.unsafe("UPDATE articles SET import_revision = $1::bigint WHERE id = $2", [revision, article.id]);
      const { journal, sessionId } = await recordingJournal(f, provider);
      assert.equal((await f.own())[0].revision, revision);
      const result = await f.call(`/articles/${article.id}`, { slug: article.slug, title: "bigint edit", contentBlocks: [{ id: "p", type: "paragraph", text: "changed" }],
        publish: false, expectedRevision: revision }, f.author, "PUT");
      assert.equal(result.data.revision, "9007199254740995");
      await f.store.deleteArticle({ articleId: article.id, actorId: f.author });
      await f.store.restoreArticle({ articleId: article.id, actorId: f.author });
      assert.equal((await f.own())[0].revision, "9007199254740997");
      const changes = await journal.readChangeBatch({ sessionId, afterSequence: 0, limit: 100 });
      assert.equal(changes.filter((change) => change.entityType === "articles").length, 3);
    } finally { await f.close(); }
  });

  test(`an exhausted work revision rolls back rather than rounding or wrapping (${provider})`, options, async () => {
    const f = await fixture(provider);
    try {
      const article = await f.store.createArticle({ authorId: f.author, slug: "max-revision", title: "initial",
        contentBlocks: [{ id: "p", type: "paragraph", text: "initial" }] });
      const revision = "9223372036854775807";
      if (f.db) f.db.prepare("UPDATE articles SET import_revision = ? WHERE id = ?").run(BigInt(revision), article.id);
      else await f.sql!.unsafe("UPDATE articles SET import_revision = $1::bigint WHERE id = $2", [revision, article.id]);
      const { journal, sessionId } = await recordingJournal(f, provider);
      await assert.rejects(async () => f.store.updateArticle({ articleId: article.id, actorId: f.author, slug: article.slug,
        title: "must not write", contentBlocks: article.contentBlocks, expectedRevision: revision }));
      const kept = await f.store.getMyArticle({ articleId: article.id, actorId: f.author });
      assert.equal(kept!.title, "initial");
      assert.equal(kept!.revision, revision);
      assert.deepEqual(await journal.readChangeBatch({ sessionId, afterSequence: 0, limit: 100 }), []);
    } finally { await f.close(); }
  });

  test(`apply requires an authentic preview of exactly this selection and actor (${provider})`, options, async () => {
    const f = await fixture(provider);
    try {
      const source = bundle(page());
      const missing = await f.call("/imports/notion", { bundle: source, apply: true }, f.author, "POST", 409);
      assert.equal(missing.error.code, "IMPORT_PLAN_INVALID");
      const dry = await f.preview(source);
      assert.equal(typeof dry.planToken, "string");
      for (const [chosen, planToken, actor] of [
        [bundle(page()), dry.planToken, f.author],
        [source, `${dry.planToken}x`, f.author],
        [source, dry.planToken, `${f.author}-other`],
      ] as const) {
        const rejected = await f.call("/imports/notion", { bundle: chosen, apply: true, planToken }, actor, "POST", 409);
        assert.equal(rejected.error.code, "IMPORT_PLAN_INVALID");
      }
      const codec = createNotionImportPlanCodec(env.AUTH_JWT_SECRET);
      const authentic = codec.verify(dry.planToken);
      for (const invalid of [
        { ...authentic, generation: "different-database-generation" },
        { ...authentic, issuedAt: Date.now() - NOTION_IMPORT_PLAN_TTL_MS - 1000, expiresAt: Date.now() - 1000 },
      ]) {
        await f.call("/imports/notion", { bundle: source, apply: true, planToken: codec.sign(invalid) }, f.author, "POST", 409);
      }
      assert.deepEqual(await f.own(), []);
      assert.equal((await f.apply(source, dry.planToken)).summary.create, 1);
    } finally { await f.close(); }
  });

  test(`a preview cannot overwrite later edits, and unrelated works can still commit (${provider})`, options, async () => {
    const f = await fixture(provider);
    try {
      const first = page();
      await f.importFresh(bundle(first));
      const [article] = await f.own();
      const changed = bundle(page(first.id, "new source body"), page());
      const dry = await f.preview(changed);
      await f.call(`/articles/${article.id}`, { slug: "renamed-after-preview", title: "keep my edit", locale: "zh-CN",
        contentBlocks: [{ id: "p", type: "paragraph", text: "keep my body" }], publish: true, expectedRevision: article.revision }, f.author, "PUT");
      const result = await f.apply(changed, dry.planToken);
      assert.equal(result.summary.refused, 1);
      assert.equal(result.summary.create, 1);
      assert.match(result.pages.find((p: { externalId: string }) => p.externalId === first.id).detail, /preview again/i);
      const kept = (await f.own()).find((a: { id: string }) => a.id === article.id);
      assert.equal(kept.title, "keep my edit");
      assert.equal(kept.slug, "renamed-after-preview");
      assert.match(JSON.stringify(kept.contentBlocks), /keep my body/);
    } finally { await f.close(); }
  });

  test(`two previews cannot both create the same source, and a work's editions commit together (${provider})`, options, async () => {
    const f = await fixture(provider);
    try {
      const zh = page();
      const en = page();
      Object.assign(zh.properties, { Date: { type: "date", date: { start: "2026-10-08", end: null } }, English: { type: "relation", relation: [{ id: en.id }] } });
      const source = bundle(zh, en);
      const [a, b] = await Promise.all([f.preview(source), f.preview(source)]);
      const results = await Promise.all([f.apply(source, a.planToken), f.apply(source, b.planToken)]);
      assert.deepEqual(results.map((r) => r.summary.create).sort(), [0, 1]);
      assert.deepEqual(results.map((r) => r.summary.refused).sort(), [0, 2]);
      const editions = await f.own();
      assert.equal(editions.length, 2);
      assert.equal(new Set(editions.map((a: { id: string }) => a.id)).size, 1);
      assert.equal(editions[0].revision, editions[1].revision);
      const newer = bundle(page(zh.id, "updated primary"), en);
      Object.assign(newer.pages[0]!.properties, { Date: { type: "date", date: { start: "2026-10-08", end: null } }, English: { type: "relation", relation: [{ id: en.id }] } });
      assert.equal((await f.importFresh(newer)).summary.update, 1, "an unchanged translation does not conflict with its own primary");
    } finally { await f.close(); }
  });

  for (const change of ["body", "rename", "taxonomy", "new translation", "delete/restore"] as const) {
    test(`a ${change} change invalidates an existing import preview (${provider})`, options, async () => {
      const f = await fixture(provider);
      try {
        const initial = page();
        await f.importFresh(bundle(initial));
        const [article] = await f.own();
        const changed = page(initial.id, "new imported body");
        const tagName = `conflict-${randomUUID()}`;
        Object.assign(changed.properties, { Tags: { type: "multi_select", multi_select: [{ name: tagName }] } });
        const source = bundle(changed);
        const dry = await f.preview(source);
        if (change === "delete/restore") {
          await f.store.deleteArticle({ articleId: article.id, actorId: f.author });
          await f.store.restoreArticle({ articleId: article.id, actorId: f.author });
        } else {
          const tags = change === "taxonomy" ? [(await f.store.createTag({ actorId: f.author, name: `desk-${randomUUID()}` })).id] : undefined;
          await f.store.updateArticle({ articleId: article.id, actorId: f.author, slug: change === "rename" ? "new-desk-address" : article.slug,
            title: article.title, contentBlocks: [{ id: "desk", type: "paragraph", text: "latest desk body" }],
            locale: change === "new translation" ? "en" : "zh-CN", publish: true, ...(tags ? { tagIds: tags } : {}) });
        }
        const before = await f.own();
        const result = await f.apply(source, dry.planToken);
        assert.equal(result.summary.refused, 1);
        assert.match(result.pages[0].detail, /preview again/);
        assert.deepEqual(await f.own(), before, "a stale import changes no edition or work field");
        assert.equal((await f.store.listTaxonomies({ kind: "tag", query: tagName })).length, 0, "the conflicting import creates no tags");
      } finally { await f.close(); }
    });
  }

  for (const change of ["link removal", "link metadata", "link target", "another-locale claim"] as const) {
    test(`a ${change} invalidates the source snapshot without an article edit (${provider})`, options, async () => {
      const f = await fixture(provider);
      try {
        const initial = page();
        await f.importFresh(bundle(initial));
        const [article] = await f.own();
        const changed = page(initial.id, "new source body");
        const tag = `stale-link-${randomUUID()}`;
        Object.assign(changed.properties, { Tags: { type: "multi_select", multi_select: [{ name: tag }] } });
        const source = bundle(changed);
        const dry = await f.preview(source);
        const link = await f.store.getExternalContentLink({ provider: "notion", externalId: initial.id, locale: "zh-CN" });
        assert.ok(link);
        let foreignId: string | undefined;
        if (change === "link removal") {
          if (f.db) f.db.prepare("DELETE FROM external_content_links WHERE external_id = ?").run(initial.id);
          else await f.sql!.unsafe("DELETE FROM external_content_links WHERE external_id = $1", [initial.id]);
        } else if (change === "link metadata") {
          await f.store.upsertExternalContentLink({ ...link, digest: "concurrent-sync" });
        } else if (change === "another-locale claim") {
          await f.store.upsertExternalContentLink({ ...link, locale: "en" });
        } else {
          const foreign = await f.store.createArticle({ authorId: randomUUID(), slug: "private-target", title: "private title",
            contentBlocks: [{ id: "private", type: "paragraph", text: "private body" }] });
          foreignId = foreign.id;
          if (f.db) f.db.prepare("UPDATE external_content_links SET article_id = ?, owner_id = ? WHERE external_id = ?").run(foreign.id, foreign.authorId, initial.id);
          else await f.sql!.unsafe("UPDATE external_content_links SET article_id = $1, owner_id = $2 WHERE external_id = $3", [foreign.id, foreign.authorId, initial.id]);
        }
        const before = await f.own();
        assert.equal(before[0].revision, article.revision, "the article revision alone cannot detect a source-link change");
        const result = await f.apply(source, dry.planToken);
        assert.equal(result.summary.refused, 1);
        assert.match(result.pages[0].detail, /preview again/);
        assert.deepEqual(await f.own(), before);
        assert.equal((await f.store.listTaxonomies({ kind: "tag", query: tag })).length, 0);
        if (foreignId) assert.ok(!JSON.stringify(result).includes(foreignId), "a changed owner never leaks their article ID");
      } finally { await f.close(); }
    });
  }

  test(`a real SQLite-to-${provider} cutover rejects the old authenticated preview`, options, async () => {
    const source = await fixture("sqlite");
    const target = await fixture(provider);
    try {
      const initial = page();
      await source.importFresh(bundle(initial));
      const changed = bundle(page(initial.id, "post-cutover update"));
      const dry = await source.preview(changed);
      const report = await transferProviderData({ source: { provider: "sqlite", db: source.db! },
        target: target.db ? { provider: "sqlite", db: target.db } : { provider: "postgres", sql: target.sql! } });
      assert.equal(report.ok, true);
      const rejected = await target.call("/imports/notion", { bundle: changed, apply: true, planToken: dry.planToken }, source.author, "POST", 409);
      assert.equal(rejected.error.code, "IMPORT_PLAN_INVALID");
      const fresh = await target.preview(changed, source.author);
      assert.equal((await target.apply(changed, fresh.planToken, source.author)).summary.update, 1);
    } finally { await source.close(); await target.close(); }
  });

  test(`view counts do not invalidate an import preview (${provider})`, options, async () => {
    const f = await fixture(provider);
    try {
      const first = page();
      await f.importFresh(bundle(first));
      const [article] = await f.own();
      const changed = bundle(page(first.id, "source update"));
      const dry = await f.preview(changed);
      await f.store.incrementArticleViewCount({ articleId: article.id });
      assert.equal((await f.apply(changed, dry.planToken)).summary.update, 1);
      assert.equal((await f.own())[0].viewCount, 1);
    } finally { await f.close(); }
  });

  test(`a missing-link recovery is version bound, including a create appearing after preview (${provider})`, options, async () => {
    const f = await fixture(provider);
    try {
      const first = page();
      const source = bundle(first);
      const beforeCreate = await f.preview(source);
      await f.importFresh(source);
      assert.equal((await f.apply(source, beforeCreate.planToken)).summary.refused, 1);
      const [article] = await f.own();
      if (f.db) f.db.prepare("DELETE FROM external_content_links WHERE article_id = ?").run(article.id);
      else await f.sql!.unsafe("DELETE FROM external_content_links WHERE article_id = $1", [article.id]);
      const recovery = await f.preview(source);
      assert.equal(recovery.summary.update, 1);
      await f.store.updateArticle({ articleId: article.id, actorId: f.author, slug: article.slug, title: "edit during recovery",
        contentBlocks: article.contentBlocks, contentBlocksVersion: article.contentBlocksVersion, publish: true });
      assert.equal((await f.apply(source, recovery.planToken)).summary.refused, 1);
      assert.equal(await f.store.getExternalContentLink({ provider: "notion", externalId: first.id, locale: "zh-CN" }), null);
      assert.equal((await f.own())[0].title, "edit during recovery");
    } finally { await f.close(); }
  });

  for (const change of ["article", "provenance"] as const) {
    test(`a late ${change} change during image preparation is rejected; leftover media are visible and removable (${provider})`, options, async () => {
      const f = await fixture(provider);
      try {
        if (f.db) f.db.prepare("INSERT INTO auth_accounts (user_id, email, password_hash) VALUES (?, ?, ?)").run(f.author, `${f.author}@example.test`, "fixture");
        else await f.sql!.unsafe("INSERT INTO auth_accounts (user_id, email, password_hash) VALUES ($1, $2, $3)", [f.author, `${f.author}@example.test`, "fixture"]);
        const first = page();
        await f.importFresh(bundle(first));
        const [article] = await f.own();
        const doc = page(first.id, "import update with image");
        doc.blocks.push({ id: "img", object: "block", type: "image", has_children: false, image: {
          type: "file", file: { url: "https://prod-files-secure.s3.amazonaws.com/test?signature=fixture" }, caption: [],
        } } as never);
        const source = bundle(doc);
        const dry = await f.preview(source);
        const objects = new Map<string, Buffer>();
        const media = createMediaAssetService({ store: f.store, storage: {
          async putObject({ key, bytes }: { key: string; bytes: Buffer }) { objects.set(key, bytes); },
          async getObject(key: string) { return objects.get(key)!; },
          async deleteObject(key: string) { objects.delete(key); }, close() {},
        } });
        const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: "red" } }).png().toBuffer();
        const result = await importNotionBundle({ actorId: f.author, bundle: source, apply: true, planToken: dry.planToken,
          deps: createApplicationServices({ persistence: f.store, env }), copyImage: async () => {
            const asset = await media.upload({ ownerId: f.author, bytes: png, contentType: "image/png" });
            // This happens AFTER the initial check, on a normal independent write path.
            if (change === "article") {
              await f.store.updateArticle({ articleId: article.id, actorId: f.author, slug: article.slug, title: "late desk edit",
                contentBlocks: article.contentBlocks, contentBlocksVersion: article.contentBlocksVersion, publish: true });
            } else {
              const link = await f.store.getExternalContentLink({ provider: "notion", externalId: first.id, locale: "zh-CN" });
              await f.store.upsertExternalContentLink({ ...link!, digest: "late-provenance-sync" });
            }
            return { ok: true, src: asset.src };
          } });
        assert.equal(result.summary.refused, 1);
        assert.match(result.pages[0]!.detail, /media library/);
        assert.equal((await f.own())[0].title, change === "article" ? "late desk edit" : article.title);
        const library = await media.listLibrary({ ownerId: f.author });
        assert.equal(library.items.length, 1);
        assert.equal(library.items[0]!.orphan, true);
        await media.deleteAsset({ ownerId: f.author, id: library.items[0]!.id });
        assert.equal((await media.listLibrary({ ownerId: f.author })).items.length, 0);
        assert.equal(objects.size, 0);
      } finally { await f.close(); }
    });

  }

  test(`all editions, tags and source links share one migration-journal transaction (${provider})`, options, async () => {
    const f = await fixture(provider);
    try {
      const { journal, sessionId } = await recordingJournal(f, provider);
      const zh = page();
      const en = page();
      Object.assign(zh.properties, { Date: { type: "date", date: { start: "2026-10-08" } },
        English: { type: "relation", relation: [{ id: en.id }] }, Tags: { type: "multi_select", multi_select: [{ name: "journal-tag" }] } });
      const result = await applicationImport(f, bundle(zh, en));
      assert.equal(result.summary.create, 1);
      assert.equal(result.summary.update, 1);
      const changes = await journal.readChangeBatch({ sessionId, afterSequence: 0, limit: 1 });
      assert.ok(changes.length > 6, "limit=1 must still return the whole work transaction");
      assert.equal(new Set(changes.map((change) => change.transactionId)).size, 1);
      assert.equal(changes.filter((change) => change.entityType === "article_translations").length, 2);
      assert.equal(changes.filter((change) => change.entityType === "external_content_links").length, 2);
      assert.ok(changes.some((change) => change.entityType === "taxonomies"));
      assert.ok(changes.every((change) => change.entityType !== "import_plan_generation"));
    } finally { await f.close(); }
  });

  test(`a failed provenance write rolls back articles, editions, tags and journal rows (${provider})`, options, async () => {
    const f = await fixture(provider);
    const failureId = randomUUID();
    const name = `fail_import_${failureId.replaceAll("-", "")}`;
    const { journal, sessionId } = await recordingJournal(f, provider);
    try {
      const primary = page();
      const translation = page(failureId);
      Object.assign(primary.properties, {
        Date: { type: "date", date: { start: "2026-10-08", end: null } },
        English: { type: "relation", relation: [{ id: translation.id }] },
        Tags: { type: "multi_select", multi_select: [{ name: `rollback-${failureId}` }] },
      });
      if (f.db) f.db.exec(`CREATE TRIGGER ${name} BEFORE INSERT ON external_content_links WHEN NEW.external_id = '${failureId}' BEGIN SELECT RAISE(ABORT, 'injected link failure'); END`);
      else {
        await f.sql!.unsafe(`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected link failure'; END $$`);
        await f.sql!.unsafe(`CREATE TRIGGER ${name} BEFORE INSERT ON external_content_links FOR EACH ROW WHEN (NEW.external_id = '${failureId}') EXECUTE FUNCTION ${name}()`);
      }
      const result = await applicationImport(f, bundle(primary, translation));
      assert.equal(result.summary.failed, 2);
      assert.deepEqual(await f.own(), []);
      assert.deepEqual(await journal.readChangeBatch({ sessionId, afterSequence: 0, limit: 100 }), [], "rolled-back business changes never enter replay");
      assert.equal((await f.store.listTaxonomies({ kind: "tag", query: `rollback-${failureId}` })).length, 0);
      assert.equal(await f.store.getExternalContentLink({ provider: "notion", externalId: primary.id, locale: "zh-CN" }), null);
    } finally {
      if (f.db) f.db.exec(`DROP TRIGGER IF EXISTS ${name}`);
      else {
        await f.sql!.unsafe(`DROP TRIGGER IF EXISTS ${name} ON external_content_links`);
        await f.sql!.unsafe(`DROP FUNCTION IF EXISTS ${name}()`);
      }
      await f.close();
    }
  });
}


type SqliteRaceInput = { filename: string; gate?: SharedArrayBuffer } & (
  | { operation: "import"; input: CommitNotionImportWorkInput }
  | { operation: "update"; input: UpdateArticleInput }
);
function sqliteWriter(input: SqliteRaceInput) {
  type Message = { type: "starting" | "holding" | "done"; ok?: boolean; name?: string };
  const worker = new Worker(new URL("../../persistence/test-support/sqlite-import-race-worker.ts", import.meta.url), { workerData: input });
  const received = new Map<string, Message>();
  const waiting = new Map<string, { resolve(value: Message): void; reject(error: Error): void }>();
  let failure: Error | undefined;
  worker.on("message", (message: Message) => { received.set(message.type, message); waiting.get(message.type)?.resolve(message); });
  const fail = (error: Error) => { failure = error; for (const pending of waiting.values()) pending.reject(error); };
  worker.on("error", fail);
  worker.on("exit", (code) => { if (!received.has("done")) fail(new Error(`SQLite writer exited without a result (${code}).`)); });
  return { worker, wait(type: Message["type"]): Promise<Message> {
    if (failure) return Promise.reject(failure);
    const value = received.get(type);
    if (value) return Promise.resolve(value);
    return new Promise((resolve, reject) => waiting.set(type, { resolve, reject }));
  } };
}

for (const operation of ["import", "update"] as const) {
  test(`independent SQLite connections serialize ${operation === "import" ? "cross-locale source claims" : "conditional article updates"}`, { timeout: 30_000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), "no-wave-import-cas-"));
    const filename = join(directory, "race.sqlite");
    const db = createSqliteClient({ filename });
    const workers: Worker[] = [];
    const gate = new SharedArrayBuffer(4);
    try {
      await runSqliteMigrations(db);
      const store = createSqliteStore(db);
      const actorId = randomUUID();
      const id = randomUUID();
      const source = page(id);
      const dry = await importNotionBundle({ actorId, bundle: bundle(source), apply: false, deps: createApplicationServices({ persistence: store, env }) });
      const plan = createNotionImportPlanCodec(env.AUTH_JWT_SECRET).verify(dry.planToken);
      let input: SqliteRaceInput;
      if (operation === "import") {
        input = { filename, operation, input: { actorId, generation: plan.generation, expiresAt: plan.expiresAt, expected: plan.works[0]!,
          editions: [{ externalId: id, locale: "zh-CN", title: "winning import", summary: "", contentBlocks: [{ id: "p", type: "paragraph", text: "winning body" }],
            contentBlocksVersion: 0, workType: "other", publish: true, tags: [], requestedSlug: null, digest: "fixture", syncedAt: new Date().toISOString() }] } };
      } else {
        const article = await store.createArticle({ authorId: actorId, slug: `cas-${id}`, title: "initial", contentBlocks: [{ id: "p", type: "paragraph", text: "initial body" }] });
        input = { filename, operation, input: { articleId: article.id, actorId, slug: article.slug, title: "winning edit",
          contentBlocks: article.contentBlocks, expectedRevision: article.revision } };
      }
      const first = sqliteWriter({ ...input, gate }); workers.push(first.worker);
      await first.wait("holding");
      // The first really holds BEGIN IMMEDIATE on its own connection before the
      // second connection attempts a write. No sleep-based ordering or mocks.
      const secondInput = input.operation === "import" ? { ...input, input: { ...input.input, actorId: randomUUID(),
        editions: input.input.editions.map((edition) => ({ ...edition, locale: "en" })) } } : input;
      const second = sqliteWriter(secondInput); workers.push(second.worker);
      await second.wait("starting");
      Atomics.store(new Int32Array(gate), 0, 1); Atomics.notify(new Int32Array(gate), 0);
      assert.equal((await first.wait("done")).ok, true);
      const loser = await second.wait("done");
      assert.equal(loser.ok, false);
      assert.equal(loser.name, operation === "import" ? "ImportConflictError" : "ArticleVersionConflictError");
      assert.equal(Number(db.prepare("SELECT count(*) AS n FROM articles").get()!.n), 1);
      assert.equal(db.prepare("SELECT title FROM article_translations").get()!.title, operation === "import" ? "winning import" : "winning edit");
    } finally {
      Atomics.store(new Int32Array(gate), 0, 1); Atomics.notify(new Int32Array(gate), 0);
      await Promise.all(workers.map((worker) => worker.terminate()));
      db.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
}


function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
for (const operation of ["import", "update"] as const) {
  test(`PostgreSQL locks cover the comparison and ${operation} through commit`, {
    skip: !process.env.TEST_DATABASE_URL && "Set TEST_DATABASE_URL to run PostgreSQL integration tests.", timeout: 30_000,
  }, async () => {
    const f = await fixture("postgres");
    const held = deferred<number>();
    const attempting = deferred<number>();
    const release = deferred<void>();
    const outstanding: Promise<unknown>[] = [];
    try {
      const sql = f.sql!;
      const heldSql: PgDatabase = { unsafe: (query, params) => sql.unsafe(query, params), end: () => Promise.resolve(),
        begin: (work) => sql.begin(async (tx) => {
          const [backend] = await tx.unsafe<{ pid: number }>("SELECT pg_backend_pid() AS pid");
          const result = await work(tx);
          held.resolve(backend!.pid);
          await release.promise;
          return result;
        }) };
      const observedSql: PgDatabase = { unsafe: (query, params) => sql.unsafe(query, params), end: () => Promise.resolve(),
        begin: (work) => sql.begin(async (tx) => {
          const [backend] = await tx.unsafe<{ pid: number }>("SELECT pg_backend_pid() AS pid");
          return work({ unsafe<TRow = PgRow>(query: string, params?: readonly unknown[]): Promise<TRow[]> {
            if (query.includes(operation === "import" ? "pg_advisory_xact_lock" : "FROM articles WHERE id = $1 FOR UPDATE")) attempting.resolve(backend!.pid);
            return tx.unsafe<TRow>(query, params);
          } });
        }) };
      const firstStore = createPostgresStore(heldSql);
      const secondStore = createPostgresStore(observedSql);
      let first: Promise<unknown>;
      let second: () => Promise<unknown>;
      if (operation === "update") {
        const article = await f.store.createArticle({ authorId: f.author, slug: "locked-cas", title: "initial", contentBlocks: [{ id: "p", type: "paragraph", text: "initial" }] });
        const input = { articleId: article.id, actorId: f.author, slug: article.slug, title: "locked winner", contentBlocks: article.contentBlocks, expectedRevision: article.revision };
        first = Promise.resolve(firstStore.updateArticle(input));
        second = () => Promise.resolve(secondStore.updateArticle({ ...input, title: "stale loser" }));
      } else {
        const id = randomUUID();
        const dry = await f.preview(bundle(page(id)));
        const plan = createNotionImportPlanCodec(env.AUTH_JWT_SECRET).verify(dry.planToken);
        const input: CommitNotionImportWorkInput = { actorId: f.author, generation: plan.generation, expiresAt: plan.expiresAt, expected: plan.works[0]!,
          editions: [{ externalId: id, locale: "zh-CN", title: "locked winner", summary: "", contentBlocks: [{ id: "p", type: "paragraph", text: "winner" }],
            contentBlocksVersion: 0, publish: true, workType: "other", tags: [], requestedSlug: null, digest: "fixture", syncedAt: new Date().toISOString() }] };
        first = Promise.resolve(firstStore.commitNotionImportWork(input));
        second = () => Promise.resolve(secondStore.commitNotionImportWork({ ...input, actorId: randomUUID(),
          editions: input.editions.map((edition) => ({ ...edition, locale: "en", title: "stale loser" })) }));
      }
      outstanding.push(first);
      const blocker = await held.promise;
      const rejected = assert.rejects(second(), { name: operation === "import" ? "ImportConflictError" : "ArticleVersionConflictError" });
      outstanding.push(rejected);
      const waiter = await attempting.promise;
      const deadline = Date.now() + 10_000;
      let blocked = false;
      while (Date.now() < deadline) {
        const [row] = await sql.unsafe<{ blocked: boolean }>("SELECT $2::int = ANY(pg_blocking_pids($1::int)) AS blocked", [waiter, blocker]);
        if (row!.blocked) { blocked = true; break; }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.equal(blocked, true, "the second real connection must wait on the first work transaction");
      release.resolve();
      await first;
      await rejected;
      const rows = await sql.unsafe("SELECT title FROM article_translations");
      assert.deepEqual(rows.map((row) => row.title), ["locked winner"]);
    } finally {
      release.resolve();
      await Promise.allSettled(outstanding);
      await f.close();
    }
  });
}
