import assert from "node:assert/strict";
import test from "node:test";
import { createTransferSourceFixture, createEmptySqliteTarget } from "./test-support/transfer-source-fixture.ts";
import {
  ProviderTransferError,
  PROVIDER_TRANSFER_ORDER,
  getTransferTables,
  transferProviderData,
} from "./provider-migration-transfer.ts";
import { getSupportedMigrationEntityTypes } from "./provider-migration-row-applier.ts";
import { describeEndpoint, formatReport, parseTransferArgs, redactTarget } from "./db-transfer.ts";

/**
 * The transfer against two SQLite files.
 *
 * SQLite is not the interesting *destination* — PostgreSQL is — but it is the
 * interesting *test*: it runs everywhere, it has the same foreign keys and the
 * same allowlist, and a copy between two files proves the parts that are
 * provider-independent (the plan order, the entity identity, the media reference
 * snapshot, the reconciliation digest and the all-or-nothing write). The
 * PostgreSQL destination has its own integration test, because a driver that
 * returns timestamps as `Date` and sequences as strings is exactly what the
 * digest was built to survive.
 */

test("the transfer plan is exactly the entities the replay applier accepts", () => {
  const planned = [...PROVIDER_TRANSFER_ORDER].sort();
  assert.deepEqual(planned, getSupportedMigrationEntityTypes().sort());
  // The associations are copied too, but they are not entities: a translation
  // owns its media references, as the journal protocol already says.
  assert.deepEqual(getTransferTables().associations, ["article_media_refs"]);
});

test("a SQLite database copies into an empty one and reconciles table by table", async () => {
  const source = await createTransferSourceFixture();
  const target = await createEmptySqliteTarget();
  try {
    const report = await transferProviderData({ source: { provider: "sqlite", db: source.db }, target: { provider: "sqlite", db: target.db } });
    assert.equal(report.applied, true);
    assert.equal(report.ok, true, formatReport(report));
    assert.ok(report.tables.every((table) => table.matched), "every table must reconcile");
    assert.ok(report.tables.every((table) => table.targetRows === table.sourceRows));
    assert.equal(report.tables.find((table) => table.table === "media_assets")?.sourceRows, 1);
    // The media reference the translation owns came across with it, not as a
    // side table the reader has to remember to copy.
    assert.equal(report.tables.find((table) => table.table === "article_media_refs")?.sourceRows, 1);

    // The copy is usable, not merely present: read it through the same store.
    const article = target.store.getPublishedArticle({ slug: source.article.slug, locale: "zh-CN" });
    assert.ok(article);
    assert.deepEqual(article.contentBlocks, source.store.getPublishedArticle({ slug: source.article.slug, locale: "zh-CN" })?.contentBlocks);
    const tree = target.store.listArticleComments({ slug: source.article.slug, locale: "zh-CN" });
    assert.equal(tree.length, 1);
    assert.equal(tree[0]?.id, source.root.id);
    assert.equal(tree[0]?.replies[0]?.id, source.reply.id, "a reply is written after the parent it answers");
    assert.equal(target.store.getArticleLikeInfo({ slug: source.article.slug, locale: "zh-CN", viewerId: source.author }).likeCount, 1);
    assert.deepEqual(
      target.store.listFeaturedArticles({ locale: "zh-CN" }).map((item) => item.id),
      [source.article.id],
    );
    // Notifications are produced as a side effect of the seeded activity, so the
    // expectation is "the copy agrees with the source", not a guessed count.
    for (const actorId of [source.author, source.reader]) {
      const expected = (await source.store.listNotifications({ actorId, limit: 20 })).map((item) => item.id).sort();
      const actual = (await target.store.listNotifications({ actorId, limit: 20 })).map((item) => item.id).sort();
      assert.deepEqual(actual, expected);
      assert.ok(expected.length > 0, "the fixture must produce notifications for this to mean anything");
    }
    assert.deepEqual(
      (await target.store.listConversations({ actorId: source.reader, limit: 10 })).map((item) => item.id),
      [source.conversation.id],
    );
    // The identity rows came across, session and avatar included.
    assert.equal((await target.store.findIdentityAccount({ email: `${source.author}@example.test` }))?.userId, source.author);
    assert.equal(target.store.getAuthorProfile({ userId: source.author, locale: "zh-CN" })?.avatarUrl, `/media/${source.asset.id}`);
    // `avatar_media_id` is a derived column; the copy carries whatever the source
    // stored there, so the reader-facing URL and the reference stay consistent.
    const avatarRef = target.db.prepare("SELECT avatar_media_id AS id FROM user_profiles WHERE user_id = ?").get(source.author) as { id: string | null };
    assert.equal(avatarRef.id, source.asset.id);
  } finally {
    source.db.close();
    target.db.close();
  }
});

test("a non-empty target is refused, and nothing is written", async () => {
  const source = await createTransferSourceFixture();
  const target = await createTransferSourceFixture();
  try {
    await assert.rejects(
      transferProviderData({ source: { provider: "sqlite", db: source.db }, target: { provider: "sqlite", db: target.db } }),
      (error: unknown) => error instanceof ProviderTransferError && error.code === "TARGET_NOT_EMPTY",
    );
    // The refusal names the table that stopped it, because "the target is not
    // empty" alone leaves an operator guessing which database they pointed at.
    await assert.rejects(
      transferProviderData({ source: { provider: "sqlite", db: source.db }, target: { provider: "sqlite", db: target.db } }),
      /auth_accounts/,
    );
  } finally {
    source.db.close();
    target.db.close();
  }
});

test("a dry run reads and validates the source without touching the target", async () => {
  const source = await createTransferSourceFixture();
  const target = await createEmptySqliteTarget();
  try {
    const report = await transferProviderData({
      source: { provider: "sqlite", db: source.db }, target: { provider: "sqlite", db: target.db }, dryRun: true,
    });
    assert.equal(report.applied, false);
    assert.equal(report.ok, true);
    assert.ok(report.tables.every((table) => table.targetRows === 0 && table.targetDigest === ""));
    assert.ok(report.totalRows > 0);
    // The target is still empty: a dry run is not a rehearsal that leaves rows.
    const count = target.db.prepare("SELECT count(*) AS n FROM articles").get() as { n: number };
    assert.equal(Number(count.n), 0);
  } finally {
    source.db.close();
    target.db.close();
  }
});

test("the report prints one line per table and says whether the copy reconciled", async () => {
  const source = await createTransferSourceFixture();
  const target = await createEmptySqliteTarget();
  try {
    const applied = await transferProviderData({ source: { provider: "sqlite", db: source.db }, target: { provider: "sqlite", db: target.db } });
    const text = formatReport(applied);
    for (const table of applied.tables) assert.match(text, new RegExp(table.table));
    assert.match(text, /Copied and reconciled/);
    assert.match(text, /storage objects are not copied/, "the report must not imply that media bytes moved");

    const dry = await transferProviderData({
      source: { provider: "sqlite", db: source.db }, target: { provider: "sqlite", db: (await createEmptySqliteTarget()).db }, dryRun: true,
    });
    assert.match(formatReport(dry), /Nothing was written/);
  } finally {
    source.db.close();
    target.db.close();
  }
});

test("a failure part-way through the copy leaves the target empty", async () => {
  const source = await createTransferSourceFixture();
  const target = await createEmptySqliteTarget();
  try {
    // Fail on a table that is written late, long after the identity and article
    // rows have gone in. If the transfer were not one transaction, the target
    // would be left with a plausible-looking but incomplete database.
    target.db.exec(
      "CREATE TRIGGER refuse_notifications BEFORE INSERT ON notifications BEGIN SELECT RAISE(ABORT, 'refused by test'); END",
    );
    await assert.rejects(
      transferProviderData({ source: { provider: "sqlite", db: source.db }, target: { provider: "sqlite", db: target.db } }),
      /refused by test/,
    );
    for (const table of ["auth_accounts", "articles", "article_translations", "article_comments", "messages"]) {
      const row = target.db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number };
      assert.equal(Number(row.n), 0, `${table} must be empty after a rolled-back copy`);
    }
  } finally {
    source.db.close();
    target.db.close();
  }
});

test("the CLI parses endpoints, refuses bad input, and never prints a password", () => {
  const env = { DATABASE_PATH: "/tmp/env.sqlite", DATABASE_URL: "postgres://bot-thk:secret@db.example.test:5432/app" };
  const parsed = parseTransferArgs(["--from", "sqlite:/tmp/source.sqlite", "--to", "postgres", "--dry-run"], env);
  assert.deepEqual(parsed.from, { provider: "sqlite", path: "/tmp/source.sqlite" });
  assert.deepEqual(parsed.to, { provider: "postgres", url: env.DATABASE_URL });
  assert.equal(parsed.dryRun, true);
  assert.equal(parsed.migrate, true);

  const bare = parseTransferArgs(["--from", "sqlite", "--to", "postgres:postgres://u:p@h/db"], env);
  assert.deepEqual(bare.from, { provider: "sqlite", path: "/tmp/env.sqlite" });

  assert.throws(() => parseTransferArgs(["--to", "postgres"], env), /--from is required/);
  assert.throws(() => parseTransferArgs(["--from", "sqlite", "--to", "mongodb:here"], env), /sqlite:<path> or postgres:<url>/);
  assert.throws(() => parseTransferArgs(["--from", "sqlite:/tmp/a.sqlite", "--to", "sqlite:/tmp/a.sqlite"], env), /same SQLite file/);
  assert.throws(() => parseTransferArgs(["--from", "sqlite", "--to", "postgres", "--page-size", "0"], env), /positive integer/);
  assert.throws(() => parseTransferArgs(["--from", "sqlite", "--to", "postgres", "--nope"], env), /Unknown option/);
  assert.equal(parseTransferArgs(["--help"], env).help, true);
  assert.equal(parseTransferArgs(["--from=sqlite:/tmp/x.sqlite", "--to=postgres:postgres://h/db"], env).from.provider, "sqlite");

  assert.equal(redactTarget("postgres://bot-thk:secret@db.example.test:5432/app"), "postgres://bot-thk:***@db.example.test:5432/app");
  assert.equal(redactTarget("postgres://db.example.test/app"), "postgres://db.example.test/app");
  assert.equal(describeEndpoint({ provider: "postgres", url: "postgres://bot-thk:secret@h/db" }).includes("secret"), false);
});
