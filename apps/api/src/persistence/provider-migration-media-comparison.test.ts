import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { inspect } from "node:util";
import { createPostgresStore } from "./postgres.ts";
import type { PgDatabase, PgExecutor, PgRow } from "./postgres-driver.ts";
import { createPostgresProviderMigrationJournal } from "./postgres-provider-migration-journal.ts";
import { createPostgresProviderMigrationReplayer } from "./postgres-provider-migration-replayer.ts";
import { MIGRATION_REPLAY_SCHEMA_VERSION } from "./provider-migration-journal.ts";
import { compareProviderMedia, ProviderMediaComparisonError } from "./provider-migration-media-comparison.ts";
import { prepareMigrationReplayTarget, replayNextMigrationBatch } from "./provider-migration-replay.ts";
import { createSqliteClient, runSqliteMigrations } from "./sqlite.ts";
import { createSqliteStore } from "./sqlite-store.ts";
import { createSqliteProviderMigrationJournal } from "./sqlite-provider-migration-journal.ts";
import { createSqliteProviderMigrationReplayer } from "./sqlite-provider-migration-replayer.ts";
import { createIsolatedPostgresTestSchema } from "./test-support/isolated-postgres-schema.ts";

const connectionString = process.env.TEST_DATABASE_URL;
const options = { skip: !connectionString && "Set TEST_DATABASE_URL for real cross-provider media comparison tests.", timeout: 30_000 };
type Provider = "sqlite" | "postgres";
const other = (provider: Provider): Provider => provider === "sqlite" ? "postgres" : "sqlite";
const stamp = "2025-02-28T12:30:45.123Z";
const owner = "private-fixture-owner";
const secretKey = "private-storage-key";
const secretDigest = "a".repeat(64);

async function fixture(t: TestContext) {
  assert.ok(connectionString);
  const directory = await mkdtemp(join(tmpdir(), "nw-media-comparison-"));
  const sqliteFilename = join(directory, "private-sqlite.sqlite");
  const db = createSqliteClient({ filename: sqliteFilename, enableWal: true });
  const pg = await createIsolatedPostgresTestSchema(connectionString);
  t.after(async () => {
    db.close();
    await pg.cleanup();
    await rm(directory, { recursive: true, force: true });
  });
  await runSqliteMigrations(db);
  db.prepare("INSERT INTO auth_accounts (user_id, email, password_hash) VALUES (?, ?, ?)").run(owner, "fixture@example.test", "fixture-hash");
  await pg.sql.unsafe("INSERT INTO auth_accounts (user_id, email, password_hash) VALUES ($1, $2, $3)", [owner, "fixture@example.test", "fixture-hash"]);

  async function asset(side: Provider, id: string, overrides: { key?: string; digest?: string; createdAt?: string; size?: number } = {}) {
    const values = [id, owner, overrides.key ?? `${secretKey}/${id}`, "image/webp", overrides.size ?? 123, 10, 11, overrides.digest ?? secretDigest, overrides.createdAt ?? stamp] as const;
    if (side === "sqlite") {
      db.prepare("INSERT INTO media_assets (id, owner_id, storage_key, content_type, byte_size, width, height, sha256, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(...values);
    } else {
      // Bind as text first: postgres.js otherwise serializes a timestamptz
      // parameter through JS Date and truncates the microsecond test fixture.
      await pg.sql.unsafe("INSERT INTO media_assets (id, owner_id, storage_key, content_type, byte_size, width, height, sha256, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::text::timestamptz)", values);
    }
  }
  async function article(side: Provider, id: string, deleted = false) {
    const values = [id, owner, `draft-${id}`, deleted ? stamp : null] as const;
    if (side === "sqlite") db.prepare("INSERT INTO articles (id, author_id, slug, deleted_at) VALUES (?, ?, ?, ?)").run(...values);
    else await pg.sql.unsafe("INSERT INTO articles (id, author_id, slug, deleted_at) VALUES ($1, $2, $3, $4)", values);
  }
  async function reference(side: Provider, assetId: string, articleId: string, locale: string) {
    const values = [assetId, articleId, locale] as const;
    if (side === "sqlite") db.prepare("INSERT INTO article_media_refs (asset_id, article_id, locale) VALUES (?, ?, ?)").run(...values);
    else await pg.sql.unsafe("INSERT INTO article_media_refs (asset_id, article_id, locale) VALUES ($1, $2, $3)", values);
  }
  async function avatar(side: Provider, userId: string, url: string | null, assetId: string | null) {
    const values = [userId, url, assetId] as const;
    if (side === "sqlite") db.prepare("INSERT INTO user_profiles (user_id, avatar_url, avatar_media_id) VALUES (?, ?, ?)").run(...values);
    else await pg.sql.unsafe("INSERT INTO user_profiles (user_id, avatar_url, avatar_media_id) VALUES ($1, $2, $3)", values);
  }
  const compare = (sourceProvider: Provider, settings: { pageSize?: number; maxRowsPerTable?: number; maxDurationMs?: number; postgres?: PgDatabase } = {}) =>
    compareProviderMedia({ sqliteFilename, postgres: settings.postgres ?? pg.sql, sourceProvider, pageSize: settings.pageSize, maxRowsPerTable: settings.maxRowsPerTable, maxDurationMs: settings.maxDurationMs });
  return { db, sql: pg.sql, sqliteFilename, asset, article, reference, avatar, compare };
}

function assertPrivate(value: unknown, secrets: readonly string[]) {
  const serialized = `${inspect(value, { depth: 8 })}\n${JSON.stringify(value)}\n${value instanceof Error ? value.stack : ""}`;
  for (const secret of secrets) assert.ok(!serialized.includes(secret), "diagnostic output must not include a private value");
}

for (const sourceProvider of ["sqlite", "postgres"] as const) {
  test(`${sourceProvider} → ${other(sourceProvider)}: compare assets, draft/tombstone references and avatars without exposing rows`, options, async (t) => {
    const f = await fixture(t);
    const [same, different, sqliteOnly1, sqliteOnly2, postgresOnly] = Array.from({ length: 5 }, () => randomUUID());
    const [draft, tombstone] = [randomUUID(), randomUUID()];
    for (const side of ["sqlite", "postgres"] as const) {
      await f.asset(side, same!);
      await f.asset(side, different!, side === "postgres" ? { digest: "b".repeat(64) } : {});
      await f.article(side, draft!);
      await f.article(side, tombstone!, true);
      await f.reference(side, same!, draft!, "zh-TW");
      await f.avatar(side, "private-equal-profile", `/media/${same}`, same!);
      await f.avatar(side, "private-different-profile", `/media/${side === "sqlite" ? same : different}`, side === "sqlite" ? same! : different!);
      await f.avatar(side, "profile-without-avatar", null, null);
    }
    for (const id of [sqliteOnly1!, sqliteOnly2!]) await f.asset("sqlite", id);
    await f.asset("postgres", postgresOnly!);
    await f.reference("sqlite", same!, draft!, "en");
    await f.reference("sqlite", different!, tombstone!, "zh-CN");
    await f.reference("postgres", same!, tombstone!, "en");
    await f.avatar("sqlite", "private-only-sqlite-1", `/media/${same}`, same!);
    await f.avatar("sqlite", "private-only-sqlite-2", "https://example.test/private-avatar", null);
    await f.avatar("postgres", "private-only-postgres", `/media/${same}`, same!);

    const result = await f.compare(sourceProvider, { pageSize: 1 });
    const sourceOnly = sourceProvider === "sqlite" ? 2 : 1;
    const targetOnly = sourceProvider === "sqlite" ? 1 : 2;
    assert.deepEqual(result, {
      kind: "media-comparison-diagnostic",
      sourceProvider,
      targetProvider: other(sourceProvider),
      assets: { equal: 1, different: 1, sourceOnly, targetOnly },
      articleReferences: { equal: 1, sourceOnly, targetOnly },
      avatars: { equal: 1, different: 1, sourceOnly, targetOnly },
    });
    assertPrivate(result, [owner, secretKey, secretDigest, "private-equal-profile", same!, different!, draft!, tombstone!, f.sqliteFilename]);
    // The diagnostic is read-only, including for reference rows that protect tombstones.
    assert.equal((f.db.prepare("SELECT count(*) AS n FROM article_media_refs").get() as { n: number }).n, 3);
    assert.equal(Number((await f.sql.unsafe<{ n: string }>("SELECT count(*) AS n FROM article_media_refs"))[0]!.n), 2);
  });

  test(`${sourceProvider} → ${other(sourceProvider)}: missing, extra and deleted rows remain directional`, options, async (t) => {
    const f = await fixture(t);
    const id = randomUUID(), abandoned = randomUUID(), article = randomUUID();
    for (const side of ["sqlite", "postgres"] as const) {
      await f.asset(side, id);
      await f.asset(side, abandoned);
      await f.article(side, article, true);
      await f.reference(side, id, article, "en");
      await f.avatar(side, "private-avatar", `/media/${id}`, id);
    }
    if (other(sourceProvider) === "sqlite") {
      f.db.prepare("DELETE FROM article_media_refs WHERE asset_id = ?").run(id);
      f.db.prepare("UPDATE user_profiles SET avatar_url = NULL, avatar_media_id = NULL WHERE user_id = ?").run("private-avatar");
      f.db.prepare("DELETE FROM media_assets WHERE id = ?").run(abandoned);
    } else {
      await f.sql.unsafe("DELETE FROM article_media_refs WHERE asset_id = $1", [id]);
      await f.sql.unsafe("UPDATE user_profiles SET avatar_url = NULL, avatar_media_id = NULL WHERE user_id = $1", ["private-avatar"]);
      await f.sql.unsafe("DELETE FROM media_assets WHERE id = $1", [abandoned]);
    }
    const result = await f.compare(sourceProvider, { pageSize: 2 });
    assert.deepEqual(result.assets, { equal: 1, different: 0, sourceOnly: 1, targetOnly: 0 });
    assert.deepEqual(result.articleReferences, { equal: 0, sourceOnly: 1, targetOnly: 0 });
    assert.deepEqual(result.avatars, { equal: 0, different: 0, sourceOnly: 1, targetOnly: 0 });
  });

  test(`${sourceProvider} → ${other(sourceProvider)}: compare after real capture and replay`, options, async (t) => {
    const f = await fixture(t);
    const sqliteStore = createSqliteStore(f.db), postgresStore = createPostgresStore(f.sql);
    const source = sourceProvider === "sqlite" ? sqliteStore : postgresStore;
    const sourceJournal = sourceProvider === "sqlite" ? createSqliteProviderMigrationJournal(f.db) : createPostgresProviderMigrationJournal(f.sql);
    const target = sourceProvider === "sqlite" ? createPostgresProviderMigrationReplayer(f.sql) : createSqliteProviderMigrationReplayer(f.db);
    const sessionId = randomUUID(), id = randomUUID();
    await sourceJournal.createSession({ sessionId, sourceProvider, targetProvider: other(sourceProvider), schemaVersion: MIGRATION_REPLAY_SCHEMA_VERSION });
    await sourceJournal.transitionSession({ sessionId, expectedStatus: "prepared", nextStatus: "recording" });
    await prepareMigrationReplayTarget({ sourceJournal, targetJournal: target, sessionId, targetProvider: other(sourceProvider) });
    await source.createMediaAsset({ id, ownerId: owner, storageKey: `${secretKey}/${id}`, contentType: "image/webp", byteSize: 123, width: 10, height: 11, sha256: secretDigest });
    await source.createArticle({ authorId: owner, slug: `private-draft-${id}`, title: "Private draft content", locale: "en", contentBlocks: [{ id: "image", type: "image", src: `/media/${id}`, alt: "" }] });
    await source.upsertAuthorProfile({ userId: owner, displayName: "Private profile", locale: "en", avatarUrl: `/media/${id}` });
    let remaining: number;
    do {
      const batch = await replayNextMigrationBatch({ sourceJournal, target, sessionId, limit: 2 });
      remaining = batch.remainingAtRead;
    } while (remaining > 0);
    const result = await f.compare(sourceProvider, { pageSize: 1 });
    assert.deepEqual(result.articleReferences, { equal: 1, sourceOnly: 0, targetOnly: 0 });
    assert.deepEqual(result.avatars, { equal: 1, different: 0, sourceOnly: 0, targetOnly: 0 });
    assert.equal(result.assets.sourceOnly + result.assets.targetOnly, 0);
    assert.equal(result.assets.equal + result.assets.different, 1);
    // Current PostgreSQL media migrations enforce millisecond precision.
    assert.equal(result.assets.different, 0);
    assertPrivate(result, [id, sessionId, owner, secretKey, secretDigest, "Private draft content", "Private profile"]);
  });
}

test("timestamps compare by exact instant and microseconds, not formatting or JS Date truncation", options, async (t) => {
  const f = await fixture(t);
  const equal = randomUUID(), microDifference = randomUUID();
  await f.asset("sqlite", equal, { createdAt: "2025-02-28T20:30:45.123000+08:00" });
  await f.asset("postgres", equal, { createdAt: stamp });
  assert.deepEqual((await f.compare("sqlite")).assets, { equal: 1, different: 0, sourceOnly: 0, targetOnly: 0 });
  // SQLite has no matching precision constraint; do not hide sub-ms drift.
  await f.asset("sqlite", microDifference, { createdAt: "2025-02-28T12:30:45.123456Z" });
  await f.asset("postgres", microDifference, { createdAt: stamp });
  assert.deepEqual((await f.compare("sqlite")).assets, { equal: 1, different: 1, sourceOnly: 0, targetOnly: 0 });
});

test("paged merge compares bytewise composite keys across non-ASCII IDs", options, async (t) => {
  const f = await fixture(t);
  const article = randomUUID();
  for (const side of ["sqlite", "postgres"] as const) {
    await f.article(side, article);
    for (const id of ["a", "a~", "z", "é", "Ω", "😀", "\uFEFFx"]) {
      await f.asset(side, id);
      await f.reference(side, id, article, "en");
      await f.avatar(side, `profile-${id}`, `/media/${id}`, id);
    }
  }
  await f.sql.unsafe("UPDATE media_assets SET width = 20 WHERE id = $1", ["Ω"]);
  const result = await f.compare("sqlite", { pageSize: 2 });
  assert.deepEqual(result.assets, { equal: 6, different: 1, sourceOnly: 0, targetOnly: 0 });
  assert.deepEqual(result.articleReferences, { equal: 7, sourceOnly: 0, targetOnly: 0 });
  assert.deepEqual(result.avatars, { equal: 7, different: 0, sourceOnly: 0, targetOnly: 0 });
});

test("matching materialized rows are not proof that both sides contain the references in their bodies", options, async (t) => {
  const f = await fixture(t);
  const id = randomUUID(), article = randomUUID();
  for (const side of ["sqlite", "postgres"] as const) {
    await f.asset(side, id);
    await f.article(side, article);
    const body = JSON.stringify([{ id: "private", type: "image", src: `/media/${id}`, alt: "" }]);
    if (side === "sqlite") f.db.prepare("INSERT INTO article_translations (article_id, locale, title, content_blocks) VALUES (?, ?, ?, ?)").run(article, "en", "Private body", body);
    else await f.sql.unsafe("INSERT INTO article_translations (article_id, locale, title, content_blocks) VALUES ($1, $2, $3, $4::text::jsonb)", [article, "en", "Private body", body]);
    // Both databases have the same missing materialized reference.
  }
  const result = await f.compare("sqlite");
  assert.deepEqual(result.articleReferences, { equal: 0, sourceOnly: 0, targetOnly: 0 });
  assert.ok(!("safe" in result) && !("ready" in result) && !("inSync" in result));
});

test("each database is read in one read-only snapshot despite concurrent writers", options, async (t) => {
  const f = await fixture(t);
  const id = randomUUID(), article = randomUUID();
  for (const side of ["sqlite", "postgres"] as const) {
    await f.asset(side, id);
    await f.article(side, article);
    await f.reference(side, id, article, "en");
    await f.avatar(side, "private-concurrent-profile", `/media/${id}`, id);
  }
  let changed = false;
  let isolation = "", readOnly = "";
  const wrapped: PgDatabase = {
    unsafe: f.sql.unsafe.bind(f.sql), end: f.sql.end.bind(f.sql),
    begin: (work) => f.sql.begin(async (tx) => {
      const proxy: PgExecutor = {
        async unsafe<T = PgRow>(query: string, parameters?: readonly unknown[]): Promise<T[]> {
          const rows = await tx.unsafe<T>(query, parameters);
          if (/^\s*SET\s+TRANSACTION/i.test(query)) {
            isolation = (await tx.unsafe<{ transaction_isolation: string }>("SHOW transaction_isolation"))[0]!.transaction_isolation;
            readOnly = (await tx.unsafe<{ transaction_read_only: string }>("SHOW transaction_read_only"))[0]!.transaction_read_only;
          }
          if (!changed && /^\s*SELECT/i.test(query)) {
            changed = true;
            f.db.prepare("UPDATE media_assets SET width = 21 WHERE id = ?").run(id);
            f.db.prepare("DELETE FROM article_media_refs WHERE asset_id = ?").run(id);
            f.db.prepare("UPDATE user_profiles SET avatar_media_id = NULL, avatar_url = NULL WHERE user_id = ?").run("private-concurrent-profile");
            await f.sql.unsafe("UPDATE media_assets SET width = 22 WHERE id = $1", [id]);
            await f.sql.unsafe("DELETE FROM article_media_refs WHERE asset_id = $1", [id]);
            await f.sql.unsafe("UPDATE user_profiles SET avatar_media_id = NULL, avatar_url = NULL WHERE user_id = $1", ["private-concurrent-profile"]);
          }
          return rows;
        },
      };
      return work(proxy);
    }),
  };
  const snapshot = await f.compare("sqlite", { postgres: wrapped, pageSize: 1 });
  assert.ok(changed);
  assert.equal(isolation, "repeatable read");
  assert.equal(readOnly, "on");
  assert.deepEqual(snapshot.assets, { equal: 1, different: 0, sourceOnly: 0, targetOnly: 0 });
  assert.deepEqual(snapshot.articleReferences, { equal: 1, sourceOnly: 0, targetOnly: 0 });
  assert.deepEqual(snapshot.avatars, { equal: 1, different: 0, sourceOnly: 0, targetOnly: 0 });
  const after = await f.compare("sqlite");
  assert.deepEqual(after.assets, { equal: 0, different: 1, sourceOnly: 0, targetOnly: 0 });
  assert.equal(after.articleReferences.equal, 0);
  assert.equal(after.avatars.equal, 0);
});

test("separately pinned snapshots can report differences even when both databases were updated together", options, async (t) => {
  const f = await fixture(t);
  const id = randomUUID();
  for (const side of ["sqlite", "postgres"] as const) await f.asset(side, id);
  const wrapped: PgDatabase = {
    unsafe: f.sql.unsafe.bind(f.sql), end: f.sql.end.bind(f.sql),
    async begin(work) {
      f.db.prepare("UPDATE media_assets SET width = 25 WHERE id = ?").run(id);
      await f.sql.unsafe("UPDATE media_assets SET width = 25 WHERE id = $1", [id]);
      return f.sql.begin(work);
    },
  };
  assert.equal((await f.compare("sqlite", { postgres: wrapped })).assets.different, 1);
  assert.equal((await f.compare("sqlite")).assets.equal, 1);
});

test("row limits and oversized or invalid data fail closed without partial reports or private error values", options, async (t) => {
  const f = await fixture(t);
  const id1 = randomUUID(), id2 = randomUUID();
  for (const side of ["sqlite", "postgres"] as const) {
    await f.asset(side, id1);
    await f.asset(side, id2);
  }
  await assert.rejects(f.compare("sqlite", { maxRowsPerTable: 1, pageSize: 1 }), (error: unknown) => {
    assert.ok(error instanceof ProviderMediaComparisonError);
    assert.equal(error.code, "ROW_LIMIT_EXCEEDED");
    assertPrivate(error, [id1, id2, owner, secretKey, secretDigest, f.sqliteFilename]);
    return true;
  });
  assert.equal((await f.compare("sqlite", { maxRowsPerTable: 2, pageSize: 1 })).assets.equal, 2, "failed comparison releases both snapshots");
  await f.sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL lock_timeout = '150ms'");
    await tx.unsafe("LOCK TABLE article_media_refs IN ACCESS EXCLUSIVE MODE");
  });
  f.db.prepare("UPDATE media_assets SET created_at = ? WHERE id = ?").run("private-invalid-timestamp", id1);
  await assert.rejects(f.compare("sqlite"), (error: unknown) => {
    assert.ok(error instanceof ProviderMediaComparisonError);
    assert.equal(error.code, "INVALID_DATA");
    assertPrivate(error, ["private-invalid-timestamp", id1, f.sqliteFilename]);
    return true;
  });
  f.db.prepare("UPDATE media_assets SET created_at = ? WHERE id = ?").run(stamp, id1);
  // A corrupt/legacy database can bypass SQLite checks; don't transfer an
  // arbitrarily large blob through a column expected to contain an integer.
  f.db.exec("PRAGMA ignore_check_constraints = ON");
  f.db.prepare("UPDATE media_assets SET byte_size = ? WHERE id = ?").run(Buffer.alloc(32_000, 0x78), id1);
  await assert.rejects(f.compare("sqlite"), (error: unknown) => error instanceof ProviderMediaComparisonError && error.code === "INVALID_DATA");
  f.db.prepare("UPDATE media_assets SET byte_size = ? WHERE id = ?").run(123, id1);
  f.db.exec("PRAGMA ignore_check_constraints = OFF");
  await f.avatar("sqlite", "private-long-profile", "x".repeat(20_000), null);
  await assert.rejects(f.compare("sqlite"), (error: unknown) => {
    assert.ok(error instanceof ProviderMediaComparisonError);
    assert.equal(error.code, "INVALID_DATA");
    assertPrivate(error, ["private-long-profile", "x".repeat(100), f.sqliteFilename]);
    return true;
  });
});

test("database errors and invalid options do not disclose paths, database errors or create a SQLite file", options, async (t) => {
  const f = await fixture(t);
  for (const settings of [{ pageSize: 0 }, { pageSize: 501 }, { maxRowsPerTable: 0 }, { maxRowsPerTable: 100_001 }]) {
    await assert.rejects(f.compare("sqlite", settings), (error: unknown) => error instanceof ProviderMediaComparisonError && error.code === "INVALID_OPTIONS");
  }
  const injectedSecret = "private-database-error-and-parameters";
  const broken: PgDatabase = {
    unsafe: f.sql.unsafe.bind(f.sql), end: f.sql.end.bind(f.sql),
    async begin() { throw new Error(injectedSecret); },
  };
  await assert.rejects(f.compare("sqlite", { postgres: broken }), (error: unknown) => {
    assert.ok(error instanceof ProviderMediaComparisonError);
    assert.equal(error.code, "DATABASE_READ_FAILED");
    assertPrivate(error, [injectedSecret, f.sqliteFilename]);
    assert.ok(!("cause" in error));
    return true;
  });
  const missing = `${f.sqliteFilename}-private-missing`;
  await assert.rejects(compareProviderMedia({ sqliteFilename: missing, postgres: f.sql, sourceProvider: "sqlite" }), (error: unknown) => {
    assert.ok(error instanceof ProviderMediaComparisonError);
    assert.equal(error.code, "DATABASE_READ_FAILED");
    assertPrivate(error, [missing]);
    return true;
  });
  await assert.rejects(access(missing));
});

test("invalid SQLite UTF-8 is rejected rather than silently replacing bytes in a comparison key", options, async (t) => {
  const f = await fixture(t);
  f.db.exec("INSERT INTO user_profiles (user_id, avatar_url) VALUES (CAST(x'80' AS TEXT), 'private-avatar')");
  await assert.rejects(f.compare("sqlite"), (error: unknown) => {
    assert.ok(error instanceof ProviderMediaComparisonError);
    assert.equal(error.code, "INVALID_DATA");
    assertPrivate(error, ["private-avatar", f.sqliteFilename]);
    return true;
  });
});

test("row values and paging keys are not sent as PostgreSQL query parameters", options, async (t) => {
  const f = await fixture(t);
  const ids = [randomUUID(), randomUUID(), randomUUID()];
  for (const side of ["sqlite", "postgres"] as const) for (const id of ids) await f.asset(side, id);
  const observations: unknown[] = [];
  const wrapped: PgDatabase = {
    unsafe: f.sql.unsafe.bind(f.sql), end: f.sql.end.bind(f.sql),
    begin: (work) => f.sql.begin(async (tx) => work({
      async unsafe<T = PgRow>(query: string, parameters?: readonly unknown[]): Promise<T[]> {
        observations.push([query, parameters]);
        return tx.unsafe<T>(query, parameters);
      },
    })),
  };
  assert.equal((await f.compare("sqlite", { pageSize: 1, postgres: wrapped })).assets.equal, 3);
  assertPrivate(observations, [...ids, owner, secretKey, secretDigest]);
});

test("elapsed-time limit fails without partial output and releases the snapshots", options, async (t) => {
  const f = await fixture(t);
  const id = randomUUID();
  for (const side of ["sqlite", "postgres"] as const) await f.asset(side, id);
  const wrapped: PgDatabase = {
    unsafe: f.sql.unsafe.bind(f.sql), end: f.sql.end.bind(f.sql),
    begin: (work) => f.sql.begin(async (tx) => work({
      async unsafe<T = PgRow>(query: string, parameters?: readonly unknown[]): Promise<T[]> {
        const result = await tx.unsafe<T>(query, parameters);
        if (/^\s*SELECT 1 FROM media_assets/i.test(query)) await new Promise((resolve) => setTimeout(resolve, 80));
        return result;
      },
    })),
  };
  await assert.rejects(f.compare("sqlite", { postgres: wrapped, maxDurationMs: 40 }), (error: unknown) => {
    assert.ok(error instanceof ProviderMediaComparisonError);
    assert.equal(error.code, "TIME_LIMIT_EXCEEDED");
    assertPrivate(error, [id, f.sqliteFilename]);
    return true;
  });
  assert.equal((await f.compare("sqlite")).assets.equal, 1);
});

test("comparison preserves a stricter PostgreSQL statement timeout and rejects a non-UTF-8 client", options, async (t) => {
  const f = await fixture(t);
  const id = randomUUID();
  for (const side of ["sqlite", "postgres"] as const) await f.asset(side, id);
  let timeout = "";
  const strictTimeout: PgDatabase = {
    unsafe: f.sql.unsafe.bind(f.sql), end: f.sql.end.bind(f.sql),
    begin: (work) => f.sql.begin(async (tx) => {
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
  assert.equal((await f.compare("sqlite", { postgres: strictTimeout })).assets.equal, 1);
  assert.equal(timeout, "2s");
  const wrongEncoding: PgDatabase = {
    unsafe: f.sql.unsafe.bind(f.sql), end: f.sql.end.bind(f.sql),
    begin: (work) => f.sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL client_encoding = 'LATIN1'");
      return work(tx);
    }),
  };
  await assert.rejects(f.compare("sqlite", { postgres: wrongEncoding }), (error: unknown) => error instanceof ProviderMediaComparisonError && error.code === "INVALID_DATA");
  assert.equal((await f.compare("sqlite")).assets.equal, 1);
});

test("all asset metadata and both avatar fields contribute to difference counts", options, async (t) => {
  const f = await fixture(t);
  const id = randomUUID();
  for (const side of ["sqlite", "postgres"] as const) {
    await f.asset(side, id);
    await f.avatar(side, "private-profile", `/media/${id}`, id);
  }
  await f.sql.unsafe("INSERT INTO auth_accounts (user_id, email, password_hash) VALUES ($1, $2, $3)", ["private-other-owner", "other@example.test", "fixture-hash"]);
  const edits: Array<[string, unknown, unknown]> = [
    ["owner_id", "private-other-owner", owner],
    ["storage_key", "other-private-storage", `${secretKey}/${id}`],
    ["byte_size", 124, 123],
    ["width", 12, 10],
    ["height", 12, 11],
    ["sha256", "b".repeat(64), secretDigest],
    ["created_at", "2025-02-28T12:30:45.124Z", stamp],
  ];
  for (const [column, value, original] of edits) {
    // Identifiers are a fixed test fixture list, not diagnostic inputs.
    await f.sql.unsafe(`UPDATE media_assets SET ${column} = $1 WHERE id = $2`, [value, id]);
    assert.deepEqual((await f.compare("sqlite")).assets, { equal: 0, different: 1, sourceOnly: 0, targetOnly: 0 }, column);
    await f.sql.unsafe(`UPDATE media_assets SET ${column} = $1 WHERE id = $2`, [original, id]);
  }
  await f.sql.unsafe("UPDATE user_profiles SET avatar_url = $1 WHERE user_id = $2", [`https://other.example.test/media/${id}`, "private-profile"]);
  assert.deepEqual((await f.compare("sqlite")).avatars, { equal: 0, different: 1, sourceOnly: 0, targetOnly: 0 });
  await f.sql.unsafe("UPDATE user_profiles SET avatar_url = $1 WHERE user_id = $2", [`/media/${id}`, "private-profile"]);
  await f.sql.unsafe("UPDATE user_profiles SET avatar_media_id = NULL WHERE user_id = $1", ["private-profile"]);
  assert.deepEqual((await f.compare("sqlite")).avatars, { equal: 0, different: 1, sourceOnly: 0, targetOnly: 0 });
});

test("row limits apply separately to article references and avatars, not only assets", options, async (t) => {
  const f = await fixture(t);
  const id = randomUUID(), article = randomUUID();
  for (const side of ["sqlite", "postgres"] as const) {
    await f.asset(side, id);
    await f.article(side, article);
    await f.reference(side, id, article, "en");
    await f.reference(side, id, article, "zh-TW");
  }
  await assert.rejects(f.compare("sqlite", { pageSize: 1, maxRowsPerTable: 1 }), (error: unknown) => error instanceof ProviderMediaComparisonError && error.code === "ROW_LIMIT_EXCEEDED");
  f.db.prepare("DELETE FROM article_media_refs WHERE locale = ?").run("zh-TW");
  await f.sql.unsafe("DELETE FROM article_media_refs WHERE locale = $1", ["zh-TW"]);
  for (const side of ["sqlite", "postgres"] as const) {
    await f.avatar(side, "private-profile-1", `/media/${id}`, id);
    await f.avatar(side, "private-profile-2", `/media/${id}`, id);
  }
  await assert.rejects(f.compare("postgres", { pageSize: 1, maxRowsPerTable: 1 }), (error: unknown) => error instanceof ProviderMediaComparisonError && error.code === "ROW_LIMIT_EXCEEDED");
  const complete = await f.compare("postgres", { pageSize: 1, maxRowsPerTable: 2 });
  assert.equal(complete.articleReferences.equal, 1);
  assert.equal(complete.avatars.equal, 2);
});

test("PostgreSQL really refuses writes inside the diagnostic transaction", options, async (t) => {
  const f = await fixture(t);
  const id = randomUUID();
  for (const side of ["sqlite", "postgres"] as const) await f.asset(side, id);
  let refused = false;
  const wrapped: PgDatabase = {
    unsafe: f.sql.unsafe.bind(f.sql), end: f.sql.end.bind(f.sql),
    begin: (work) => f.sql.begin(async (tx) => work({
      async unsafe<T = PgRow>(query: string, parameters?: readonly unknown[]): Promise<T[]> {
        const result = await tx.unsafe<T>(query, parameters);
        if (/^\s*SELECT 1 FROM media_assets/i.test(query)) {
          // postgres.js tracks failed statements per scope, so use its real
          // savepoint API rather than swallowing an error in the parent scope.
          const nested = tx as PgExecutor & { savepoint<T>(work: (savepoint: PgExecutor) => Promise<T>): Promise<T> };
          try { await nested.savepoint((savepoint) => savepoint.unsafe("UPDATE media_assets SET width = width")); }
          catch (error) { refused = Boolean(error && typeof error === "object" && "code" in error && error.code === "25006"); }
        }
        return result;
      },
    })),
  };
  assert.equal((await f.compare("sqlite", { postgres: wrapped })).assets.equal, 1);
  assert.ok(refused);
});

test("diagnostics never log rows, paths or database exceptions", options, async (t) => {
  const f = await fixture(t);
  const id = randomUUID();
  for (const side of ["sqlite", "postgres"] as const) await f.asset(side, id);
  const logs: unknown[] = [];
  const original = { log: console.log, info: console.info, warn: console.warn, error: console.error, debug: console.debug };
  console.log = console.info = console.warn = console.error = console.debug = (...args: unknown[]) => { logs.push(args); };
  try {
    await f.compare("sqlite", { pageSize: 1 });
    const broken: PgDatabase = {
      unsafe: f.sql.unsafe.bind(f.sql), end: f.sql.end.bind(f.sql),
      async begin() { throw new Error("private-exception-from-database"); },
    };
    await assert.rejects(f.compare("sqlite", { postgres: broken }));
  } finally {
    Object.assign(console, original);
  }
  assert.deepEqual(logs, []);
});

test("a PostgreSQL row-security policy cannot silently hide media from the comparison", options, async (t) => {
  const f = await fixture(t);
  const id = randomUUID();
  for (const side of ["sqlite", "postgres"] as const) await f.asset(side, id);
  const [role] = await f.sql.unsafe<{ rolsuper: boolean; rolbypassrls: boolean }>("SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user");
  const needsRestrictedRole = role!.rolsuper || role!.rolbypassrls;
  // FORCE subjects a non-superuser table owner to RLS. Superusers can switch
  // to PostgreSQL's predefined read-only role, which has no BYPASSRLS; no
  // cluster-wide test role needs to be created or dropped.
  const assumeRestrictedRole = async (tx: PgExecutor) => {
    if (needsRestrictedRole) await tx.unsafe("SET LOCAL ROLE pg_read_all_data");
  };
  const restricted: PgDatabase = {
    unsafe: f.sql.unsafe.bind(f.sql), end: f.sql.end.bind(f.sql),
    begin: (work) => f.sql.begin(async (tx) => {
      await assumeRestrictedRole(tx);
      return work(tx);
    }),
  };
  // In particular, ACCESS SHARE locks must work with the SELECT-only role.
  assert.equal((await f.compare("sqlite", { postgres: restricted })).assets.equal, 1);
  await f.sql.unsafe("ALTER TABLE media_assets ENABLE ROW LEVEL SECURITY");
  await f.sql.unsafe("ALTER TABLE media_assets FORCE ROW LEVEL SECURITY");
  await f.sql.unsafe("CREATE POLICY hidden_media ON media_assets FOR SELECT USING (false)");
  try {
    const visible = await f.sql.begin(async (tx) => {
      await assumeRestrictedRole(tx);
      const [row] = await tx.unsafe<{ n: string }>("SELECT count(*) AS n FROM media_assets");
      return Number(row!.n);
    });
    assert.equal(visible, 0, "the test role can read the table but its policy hides the row");
    await assert.rejects(f.compare("sqlite", { postgres: restricted }), (error: unknown) => {
      assert.ok(error instanceof ProviderMediaComparisonError);
      assert.equal(error.code, "DATABASE_READ_FAILED");
      assertPrivate(error, [id, owner, secretKey, secretDigest]);
      return true;
    });
  } finally {
    await f.sql.unsafe("DROP POLICY IF EXISTS hidden_media ON media_assets");
    await f.sql.unsafe("ALTER TABLE media_assets NO FORCE ROW LEVEL SECURITY");
    await f.sql.unsafe("ALTER TABLE media_assets DISABLE ROW LEVEL SECURITY");
  }
});

test("invalid options and a missing SQLite path fail before any connection or file creation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "nw-media-options-"));
  const filename = join(directory, "private-missing.sqlite");
  let began = false;
  const postgres: PgDatabase = {
    async unsafe<T = PgRow>(): Promise<T[]> { throw new Error("should not query"); },
    async begin() { began = true; throw new Error("should not connect"); },
    async end() {},
  };
  try {
    for (const settings of [{ pageSize: 0 }, { pageSize: NaN }, { pageSize: 1.5 }, { maxRowsPerTable: Infinity }, { maxDurationMs: 0 }, { maxDurationMs: 30_001 }]) {
      await assert.rejects(compareProviderMedia({ sqliteFilename: filename, postgres, sourceProvider: "sqlite", ...settings }), (error: unknown) => error instanceof ProviderMediaComparisonError && error.code === "INVALID_OPTIONS");
    }
    for (const sqliteFilename of [":memory:", "file::memory:?cache=shared", "file:temporary?mode=memory"]) {
      await assert.rejects(compareProviderMedia({ sqliteFilename, postgres, sourceProvider: "sqlite" }), (error: unknown) => error instanceof ProviderMediaComparisonError && error.code === "INVALID_OPTIONS");
    }
    await assert.rejects(compareProviderMedia({ sqliteFilename: filename, postgres, sourceProvider: "sqlite" }), (error: unknown) => {
      assert.ok(error instanceof ProviderMediaComparisonError);
      assert.equal(error.code, "DATABASE_READ_FAILED");
      assertPrivate(error, [filename]);
      return true;
    });
    assert.equal(began, false);
    await assert.rejects(access(filename));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("timestamp comparison handles pre-epoch instants and rejects calendar overflow", options, async (t) => {
  const f = await fixture(t);
  const id = randomUUID();
  await f.asset("sqlite", id, { createdAt: "1970-01-01T07:59:59.123000+08:00" });
  await f.asset("postgres", id, { createdAt: "1969-12-31T23:59:59.123Z" });
  assert.deepEqual((await f.compare("sqlite")).assets, { equal: 1, different: 0, sourceOnly: 0, targetOnly: 0 });
  f.db.prepare("UPDATE media_assets SET created_at = ? WHERE id = ?").run("2025-02-29T00:00:00.000Z", id);
  await assert.rejects(f.compare("sqlite"), (error: unknown) => error instanceof ProviderMediaComparisonError && error.code === "INVALID_DATA");
});

test("an empty but non-null avatar URL is included while an all-null profile is not", options, async (t) => {
  const f = await fixture(t);
  await f.avatar("sqlite", "private-empty-avatar", null, null);
  await f.avatar("postgres", "private-empty-avatar", "", null);
  const result = await f.compare("sqlite");
  assert.deepEqual(result.avatars, { equal: 0, different: 0, sourceOnly: 0, targetOnly: 1 });
});

test("PostgreSQL snapshot prevents a concurrent truncate of an as-yet unread reference table", options, async (t) => {
  const f = await fixture(t);
  const id = randomUUID(), article = randomUUID();
  for (const side of ["sqlite", "postgres"] as const) {
    await f.asset(side, id);
    await f.article(side, article);
    await f.reference(side, id, article, "en");
  }
  let blocked = false;
  const wrapped: PgDatabase = {
    unsafe: f.sql.unsafe.bind(f.sql), end: f.sql.end.bind(f.sql),
    begin: (work) => f.sql.begin(async (tx) => work({
      async unsafe<T = PgRow>(query: string, parameters?: readonly unknown[]): Promise<T[]> {
        const result = await tx.unsafe<T>(query, parameters);
        if (/^\s*SELECT 1 FROM media_assets/i.test(query)) {
          try {
            await f.sql.begin(async (writer) => {
              await writer.unsafe("SET LOCAL lock_timeout = '150ms'");
              await writer.unsafe("TRUNCATE TABLE article_media_refs");
            });
          } catch (error) {
            blocked = Boolean(error && typeof error === "object" && "code" in error && error.code === "55P03");
          }
        }
        return result;
      },
    })),
  };
  const result = await f.compare("sqlite", { postgres: wrapped });
  assert.ok(blocked, "the reference table must stay stable until the snapshot closes");
  assert.deepEqual(result.articleReferences, { equal: 1, sourceOnly: 0, targetOnly: 0 });
});

test("empty tables are pinned before concurrent inserts on either provider", options, async (t) => {
  const f = await fixture(t);
  const id = randomUUID();
  let inserted = false;
  const wrapped: PgDatabase = {
    unsafe: f.sql.unsafe.bind(f.sql), end: f.sql.end.bind(f.sql),
    begin: (work) => f.sql.begin(async (tx) => work({
      async unsafe<T = PgRow>(query: string, parameters?: readonly unknown[]): Promise<T[]> {
        const result = await tx.unsafe<T>(query, parameters);
        if (!inserted && /^\s*SELECT 1 FROM media_assets/i.test(query)) {
          inserted = true;
          await f.asset("sqlite", id);
          await f.asset("postgres", id);
        }
        return result;
      },
    })),
  };
  const snapshot = await f.compare("sqlite", { postgres: wrapped });
  assert.ok(inserted);
  assert.deepEqual(snapshot.assets, { equal: 0, different: 0, sourceOnly: 0, targetOnly: 0 });
  assert.equal((await f.compare("sqlite")).assets.equal, 1);
});

test("oversized PostgreSQL avatar data fails without returning the value", options, async (t) => {
  const f = await fixture(t);
  await f.avatar("postgres", "private-pg-profile", "y".repeat(20_000), null);
  await assert.rejects(f.compare("postgres"), (error: unknown) => {
    assert.ok(error instanceof ProviderMediaComparisonError);
    assert.equal(error.code, "INVALID_DATA");
    assertPrivate(error, ["private-pg-profile", "y".repeat(100)]);
    return true;
  });
});
