import assert from "node:assert/strict";
import test, { after } from "node:test";
import { createPostgresStore } from "./postgres.ts";
import { transferProviderData, ProviderTransferError } from "./provider-migration-transfer.ts";
import { createIsolatedPostgresTestSchema } from "./test-support/isolated-postgres-schema.ts";
import { createTransferSourceFixture } from "./test-support/transfer-source-fixture.ts";

/**
 * The destination that matters: SQLite → PostgreSQL.
 *
 * The SQLite suite proves the plan and the transaction; this one proves the
 * *reconciliation*, which is where the two engines actually differ. PostgreSQL
 * hands back `timestamptz` as `Date`, `bigint` as a string, and `jsonb` with its
 * keys reordered; SQLite hands back the text and the number as stored. A digest
 * that compared raw driver values would report a mismatch on a perfectly good
 * copy, so each table must reconcile *after* normalisation — and the copy must
 * still be readable through the ordinary PostgreSQL store, not merely present in
 * the tables.
 *
 * Each test gets its own schema, so nothing here depends on the shared database
 * being empty, and the emptiness rule is tested against a schema this test owns.
 */

const connectionString = process.env.TEST_DATABASE_URL;
const options = { skip: !connectionString && "Set TEST_DATABASE_URL to run PostgreSQL provider-transfer integration tests." };
const cleanups: Array<() => Promise<void>> = [];

after(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function isolatedTarget() {
  const schema = await createIsolatedPostgresTestSchema(connectionString!);
  cleanups.push(() => schema.cleanup());
  return schema.sql;
}

test("a SQLite database copies into PostgreSQL and every table reconciles", options, async () => {
  const source = await createTransferSourceFixture();
  const target = await isolatedTarget();
  try {
    const targetGeneration = await createPostgresStore(target).getImportPlanGeneration();
    assert.notEqual(targetGeneration, await source.store.getImportPlanGeneration());
    const report = await transferProviderData({
      source: { provider: "sqlite", db: source.db },
      target: { provider: "postgres", sql: target },
    });
    assert.equal(report.applied, true);
    assert.equal(await createPostgresStore(target).getImportPlanGeneration(), targetGeneration, "provider transfer invalidates source-bound previews");
    assert.equal(report.ok, true, `tables that did not reconcile: ${report.tables.filter((table) => !table.matched).map((table) => table.table).join(", ")}`);
    assert.ok(report.tables.every((table) => table.matched), "no table may diverge across engines");
    assert.ok(report.tables.every((table) => table.targetRows === table.sourceRows));
    assert.equal(report.tables.find((table) => table.table === "article_translations")?.sourceRows, 1);

    // Read it back the way an application would.
    const store = createPostgresStore(target);
    const article = await store.getPublishedArticle({ slug: source.article.slug, locale: "zh-CN" });
    assert.ok(article);
    assert.deepEqual(article.contentBlocks, source.store.getPublishedArticle({ slug: source.article.slug, locale: "zh-CN" })?.contentBlocks);
    const tree = await store.listArticleComments({ slug: source.article.slug, locale: "zh-CN" });
    assert.equal(tree.length, 1);
    assert.equal(tree[0]?.id, source.root.id);
    assert.equal(tree[0]?.replies[0]?.id, source.reply.id);
    // The media reference came across with its translation, not as a table the
    // operator had to remember.
    const refs = await target.unsafe("SELECT asset_id FROM article_media_refs WHERE article_id = $1", [source.article.id]);
    assert.deepEqual(refs.map((row: { asset_id: string }) => row.asset_id), [source.asset.id]);
    assert.equal((await store.getArticleLikeInfo({ slug: source.article.slug, locale: "zh-CN", viewerId: source.author }))?.likeCount, 1);
    assert.equal((await store.findIdentityAccount({ email: `${source.author}@example.test` }))?.userId, source.author);
    const profile = await target.unsafe("SELECT avatar_media_id FROM user_profiles WHERE user_id = $1", [source.author]);
    assert.equal(profile[0]?.avatar_media_id, source.asset.id);
    const messages = await target.unsafe("SELECT body FROM messages WHERE conversation_id = $1", [source.conversation.id]);
    assert.deepEqual(messages.map((row: { body: string }) => row.body), ["你好"]);
  } finally {
    source.db.close();
  }
});

test("the copy refuses a target that already holds rows, naming the table", options, async () => {
  const source = await createTransferSourceFixture();
  const target = await isolatedTarget();
  try {
    await transferProviderData({
      source: { provider: "sqlite", db: source.db },
      target: { provider: "postgres", sql: target },
    });
    await assert.rejects(
      transferProviderData({
        source: { provider: "sqlite", db: source.db },
        target: { provider: "postgres", sql: target },
      }),
      (error: unknown) => error instanceof ProviderTransferError
        && error.code === "TARGET_NOT_EMPTY"
        && /auth_accounts/.test(error.message),
    );
    // The refused copy changed nothing: the first copy is still exactly one row per table.
    const counts = await target.unsafe("SELECT (SELECT count(*) FROM auth_accounts) AS accounts, (SELECT count(*) FROM articles) AS articles");
    assert.equal(Number(counts[0]?.accounts), 1);
    assert.equal(Number(counts[0]?.articles), 1);
  } finally {
    source.db.close();
  }
});

test("a dry run against PostgreSQL validates the source and writes nothing", options, async () => {
  const source = await createTransferSourceFixture();
  const target = await isolatedTarget();
  try {
    const report = await transferProviderData({
      source: { provider: "sqlite", db: source.db },
      target: { provider: "postgres", sql: target },
      dryRun: true,
    });
    assert.equal(report.applied, false);
    assert.equal(report.ok, true);
    const counts = await target.unsafe("SELECT (SELECT count(*) FROM auth_accounts) AS accounts, (SELECT count(*) FROM articles) AS articles");
    assert.equal(Number(counts[0]?.accounts), 0);
    assert.equal(Number(counts[0]?.articles), 0);
  } finally {
    source.db.close();
  }
});

test("a copy that fails mid-way leaves the PostgreSQL target empty", options, async () => {
  const source = await createTransferSourceFixture();
  const target = await isolatedTarget();
  try {
    // `notifications` is written late, after identities, media and articles. A
    // constraint violation there must take the earlier rows with it.
    await target.unsafe(`
      CREATE FUNCTION reject_notifications() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'refused by test'; END;
      $$ LANGUAGE plpgsql`);
    await target.unsafe("CREATE TRIGGER refuse_notifications BEFORE INSERT ON notifications FOR EACH ROW EXECUTE FUNCTION reject_notifications()");
    await assert.rejects(
      transferProviderData({ source: { provider: "sqlite", db: source.db }, target: { provider: "postgres", sql: target } }),
      /refused by test/,
    );
    const counts = await target.unsafe(`SELECT
      (SELECT count(*) FROM auth_accounts) AS accounts,
      (SELECT count(*) FROM articles) AS articles,
      (SELECT count(*) FROM article_translations) AS translations,
      (SELECT count(*) FROM article_comments) AS comments`);
    const row = counts[0] as Record<string, string>;
    assert.deepEqual(
      { accounts: Number(row.accounts), articles: Number(row.articles), translations: Number(row.translations), comments: Number(row.comments) },
      { accounts: 0, articles: 0, translations: 0, comments: 0 },
    );
  } finally {
    source.db.close();
  }
});
