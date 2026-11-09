import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test, { after, before } from "node:test";
import { signAccessToken } from "../security/authentication.ts";
import { createApiServer } from "../server.ts";
import { createMediaAssetService } from "../application/media-assets.ts";
import { encodeArticleCursor } from "../domain/article.ts";
import { encodeCursor } from "../domain/cursor.ts";
import { createPostgresClient, createPostgresStore } from "./postgres.ts";
import { runMigrations } from "./migrate.ts";

const connectionString = process.env.TEST_DATABASE_URL;
const integrationOptions = { skip: !connectionString && "Set TEST_DATABASE_URL to run PostgreSQL integration tests." };
let sql;
let store;

before(async () => {
  if (!connectionString) return;
  sql = await createPostgresClient({ connectionString, max: 4 });
  await runMigrations(sql);
  store = createPostgresStore(sql);
});

after(async () => { if (sql) await sql.end({ timeout: 5 }); });

const authEnv = {
  AUTH_JWT_SECRET: randomBytes(32).toString("base64url"),
  AUTH_JWT_ISSUER: "https://cursor.integration.test",
  AUTH_JWT_AUDIENCE: "bot-thk-api",
};

function bearer(subject: string): string {
  const now = Math.floor(Date.now() / 1000);
  return `Bearer ${signAccessToken({
    subject,
    tokenId: randomUUID(),
    sessionId: randomUUID(),
    issuedAt: now,
    expiresAt: now + 60,
    env: authEnv,
  })}`;
}

/** One HTTP server backed by the real PostgreSQL store and a no-op object store. */
async function withApiServer(run) {
  const storage = {
    async putObject() {},
    async getObject() { return Buffer.alloc(0); },
    async deleteObject() {},
    close() {},
  };
  const mediaAssets = createMediaAssetService({ store, storage });
  const server = createApiServer({ env: authEnv, store, mediaAssets, logger: () => {} });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    await run(`http://127.0.0.1:${server.address().port}/api/v1`);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

/** The rows a cursor must walk: newest millisecond first, then descending id. */
function newestFirst(rows, timeKey) {
  return [...rows].sort((a, b) => {
    const left = a[timeKey];
    const right = b[timeKey];
    if (left !== right) return left < right ? 1 : -1;
    return a.id < b.id ? 1 : -1;
  }).map((row) => row.id);
}

test("PostgreSQL cursor migration normalizes legacy microseconds and enforces millisecond writes", integrationOptions, async () => {
  const migration = await readFile(new URL("./migrations/0023_cursor_timestamp_millisecond_precision.sql", import.meta.url), "utf8");
  const rollback = new Error("rollback disposable cursor migration fixture");
  const a = "00000000-0000-4000-8000-000000000001";
  const b = "00000000-0000-4000-8000-000000000002";
  const c = "00000000-0000-4000-8000-000000000003";
  await assert.rejects(sql.begin(async (tx) => {
    // Temporary legacy-shaped tables keep the real schema and its data untouched.
    await tx.unsafe("CREATE TEMP TABLE articles (id uuid PRIMARY KEY, published_at timestamptz) ON COMMIT DROP");
    await tx.unsafe("CREATE TEMP TABLE media_assets (id text PRIMARY KEY, created_at timestamptz NOT NULL) ON COMMIT DROP");
    // PGlite truncates bound timestamptz strings to milliseconds, so the legacy
    // microseconds are supplied as SQL literals — the values a pre-migration
    // PostgreSQL row actually holds. Real PostgreSQL supports both forms.
    await tx.unsafe(`INSERT INTO articles (id, published_at) VALUES
      ('${a}'::uuid, '2026-06-01T00:00:00.123900Z'::timestamptz),
      ('${b}'::uuid, '2026-06-01T00:00:00.123400Z'::timestamptz),
      ('${c}'::uuid, '2026-06-01T00:00:00.122900Z'::timestamptz)`);
    await tx.unsafe(`INSERT INTO media_assets (id, created_at) VALUES
      ('${a}', '2026-06-01T00:00:00.123900Z'::timestamptz),
      ('${b}', '2026-06-01T00:00:00.123400Z'::timestamptz),
      ('${c}', '2026-06-01T00:00:00.122900Z'::timestamptz)`);

    await tx.unsafe(migration);

    const articles = await tx.unsafe("SELECT id, published_at FROM articles ORDER BY id");
    assert.deepEqual(articles.map((row) => new Date(row.published_at).toISOString()), [
      "2026-06-01T00:00:00.123Z",
      "2026-06-01T00:00:00.123Z",
      "2026-06-01T00:00:00.122Z",
    ], "legacy publication times are truncated to the cursor precision");
    const assets = await tx.unsafe("SELECT id, created_at FROM media_assets ORDER BY id");
    assert.deepEqual(assets.map((row) => new Date(row.created_at).toISOString()), [
      "2026-06-01T00:00:00.123Z",
      "2026-06-01T00:00:00.123Z",
      "2026-06-01T00:00:00.122Z",
    ], "legacy media times are truncated too");

    // Defaults inherited from `now()` are normalized as well.
    const defaultArticleId = "00000000-0000-4000-8000-000000000004";
    const defaultAssetId = "00000000-0000-4000-8000-000000000005";
    await tx.unsafe("INSERT INTO articles (id) VALUES ($1)", [defaultArticleId]);
    await tx.unsafe("INSERT INTO media_assets (id) VALUES ($1)", [defaultAssetId]);
    const [defaultArticle] = await tx.unsafe(
      "SELECT published_at = date_trunc('milliseconds', published_at) AS ok FROM articles WHERE id = $1",
      [defaultArticleId],
    );
    const [defaultAsset] = await tx.unsafe(
      "SELECT created_at = date_trunc('milliseconds', created_at) AS ok FROM media_assets WHERE id = $1",
      [defaultAssetId],
    );
    assert.equal(defaultArticle.ok, true, "the article default has no microseconds");
    assert.equal(defaultAsset.ok, true, "the media default has no microseconds");

    // A future write that bypasses the application cannot reintroduce the bug.
    const subMillisecondArticleId = "00000000-0000-4000-8000-000000000006";
    const subMillisecondAssetId = "00000000-0000-4000-8000-000000000007";
    await assert.rejects(tx.unsafe(
      `INSERT INTO articles (id, published_at) VALUES ('${subMillisecondArticleId}'::uuid, '2026-06-01T00:00:00.123900Z'::timestamptz)`,
    ));
    await assert.rejects(tx.unsafe(
      `INSERT INTO media_assets (id, created_at) VALUES ('${subMillisecondAssetId}', '2026-06-01T00:00:00.123900Z'::timestamptz)`,
    ));
    throw rollback;
  }), (error) => error === rollback);
});

test("PostgreSQL notification times are normalized to the cursor's millisecond precision", integrationOptions, async () => {
  const migration = await readFile(new URL("./migrations/0030_notification_created_at_millisecond_precision.sql", import.meta.url), "utf8");
  const rollback = new Error("rollback disposable notification migration fixture");
  const a = "00000000-0000-4000-8000-0000000000a1";
  const b = "00000000-0000-4000-8000-0000000000a2";
  await assert.rejects(sql.begin(async (tx) => {
    // A temporary table with the inherited shape keeps the real schema untouched
    // while giving the migration the legacy rows it is written for.
    await tx.unsafe(`CREATE TEMP TABLE notifications (
      id uuid PRIMARY KEY,
      user_id text NOT NULL,
      event_key text NOT NULL,
      payload jsonb NOT NULL,
      payload_hash char(64) NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      read_at timestamptz
    ) ON COMMIT DROP`);
    // Sub-millisecond values arrive as SQL literals: a bound string is truncated
    // by some drivers, and these are the values a pre-migration row really holds.
    await tx.unsafe(`INSERT INTO notifications (id, user_id, event_key, payload, payload_hash, created_at) VALUES
      ('${a}'::uuid, 'legacy-user', 'legacy-1', '{}'::jsonb, repeat('a', 64), '2026-06-01T00:00:00.123900Z'::timestamptz),
      ('${b}'::uuid, 'legacy-user', 'legacy-2', '{}'::jsonb, repeat('b', 64), '2026-06-01T00:00:00.123400Z'::timestamptz)`);

    await tx.unsafe(migration);

    const rows = await tx.unsafe("SELECT id, created_at FROM notifications ORDER BY id");
    assert.deepEqual(rows.map((row) => new Date(row.created_at).toISOString()), [
      "2026-06-01T00:00:00.123Z",
      "2026-06-01T00:00:00.123Z",
    ], "legacy notification times are truncated to what a cursor can name");

    // The default now agrees with the cursor, so a new notice cannot land
    // between two names for the same millisecond.
    await tx.unsafe("INSERT INTO notifications (id, user_id, event_key, payload, payload_hash) VALUES ('00000000-0000-4000-8000-0000000000a3'::uuid, 'legacy-user', 'legacy-3', '{}'::jsonb, repeat('c', 64))");
    const [created] = await tx.unsafe(
      "SELECT created_at = date_trunc('milliseconds', created_at) AS ok FROM notifications WHERE event_key = 'legacy-3'",
    );
    assert.equal(created.ok, true, "the column default has no microseconds");

    // A write that bypasses the application cannot reintroduce the bug.
    await assert.rejects(tx.unsafe(
      "INSERT INTO notifications (id, user_id, event_key, payload, payload_hash, created_at) VALUES ('00000000-0000-4000-8000-0000000000a4'::uuid, 'legacy-user', 'legacy-4', '{}'::jsonb, repeat('d', 64), '2026-06-01T00:00:00.123900Z'::timestamptz)",
    ));
    throw rollback;
  }), (error) => error === rollback);
});

test("PostgreSQL HTTP cursors read every same-millisecond row, then an empty page", integrationOptions, async () => {
  const suffix = randomUUID().replaceAll("-", "");
  const authorId = randomUUID();
  const ownerId = randomUUID();
  const sameMs = "2026-06-01T00:00:00.123Z";
  const newerMs = "2026-06-01T00:00:00.124Z";
  const olderMs = "2026-06-01T00:00:00.122Z";
  const intruderMs = "2026-06-01T00:00:00.125Z";
  const lowId = `00000000-0000-4000-8000-${suffix.slice(0, 12)}`;
  const highId = `ffffffff-ffff-4fff-8fff-${suffix.slice(0, 12)}`;
  const midId = `11111111-1111-4111-8111-${suffix.slice(0, 12)}`;
  const articleRows = [
    { id: randomUUID(), publishedAt: sameMs },
    { id: randomUUID(), publishedAt: sameMs },
    { id: randomUUID(), publishedAt: sameMs },
    { id: lowId, publishedAt: newerMs },
    { id: highId, publishedAt: olderMs },
  ];
  const mediaRows = [
    { id: randomUUID(), createdAt: sameMs },
    { id: randomUUID(), createdAt: sameMs },
    { id: randomUUID(), createdAt: sameMs },
    { id: lowId, createdAt: newerMs },
    { id: highId, createdAt: olderMs },
  ];
  const intruderArticle = { id: midId, publishedAt: intruderMs };
  const intruderAsset = { id: midId, createdAt: intruderMs };
  const expectedArticleIds = newestFirst(articleRows, "publishedAt");
  const expectedMediaIds = newestFirst(mediaRows, "createdAt");

  const insertArticle = async (row, index) => {
    const slug = `cursor-ms-work-${index}-${suffix}`;
    await sql.unsafe(
      "INSERT INTO articles (id, author_id, slug, status, published_at) VALUES ($1, $2, $3, 'published', $4::timestamptz)",
      [row.id, authorId, slug, row.publishedAt],
    );
    await sql.unsafe(
      "INSERT INTO article_translations (article_id, locale, title, summary, content_blocks) VALUES ($1, 'zh-CN', $2, '', '[]'::jsonb)",
      [row.id, `Cursor work ${index} ${suffix}`],
    );
  };
  const insertAsset = async (row) => {
    await sql.unsafe(
      "INSERT INTO media_assets (id, owner_id, storage_key, content_type, byte_size, width, height, sha256, created_at) VALUES ($1, $2, $3, 'image/webp', 2048, 20, 10, $4, $5::timestamptz)",
      [row.id, ownerId, `assets/${ownerId}/${row.id}.webp`, "a".repeat(64), row.createdAt],
    );
  };
  await sql.unsafe(
    "INSERT INTO auth_accounts (user_id, email, password_hash) VALUES ($1, $2, $3)",
    [ownerId, `cursor-ms-${suffix}@example.test`, "integration-test-password-hash"],
  );
  await sql.unsafe("INSERT INTO user_profiles (user_id) VALUES ($1)", [authorId]);
  await sql.unsafe(
    "INSERT INTO user_profile_translations (user_id, locale, display_name) VALUES ($1, 'zh-CN', $2)",
    [authorId, "Cursor Author"],
  );
  for (const [index, row] of articleRows.entries()) await insertArticle(row, index);
  for (const row of mediaRows) await insertAsset(row);

  try {
    await withApiServer(async (baseUrl) => {
      const articleQuery = (cursor = null, limit = 1) =>
        `locale=zh-CN&sort=latest&query=${suffix}&limit=${limit}` + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : "");
      const publicArticleUrl = (cursor = null, limit = 1) => `${baseUrl}/articles?${articleQuery(cursor, limit)}`;
      const authorArticleUrl = (cursor = null, limit = 1) => `${baseUrl}/authors/${encodeURIComponent(authorId)}/articles?${articleQuery(cursor, limit)}`;
      const mediaUrl = (cursor = null, limit = 1) =>
        `${baseUrl}/me/media?limit=${limit}` + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : "");
      const walkArticlePages = async (urlFor, { insertIntruderAfterFirstPage = false } = {}) => {
        const seen = [];
        let cursor = null;
        let response = await fetch(urlFor(cursor));
        assert.equal(response.status, 200);
        let items = (await response.json()).data;
        for (let index = 0; index < expectedArticleIds.length; index += 1) {
          assert.equal(items.length, 1, `article page ${index + 1} contains one row`);
          const last = items[0];
          seen.push(last.id);
          cursor = encodeArticleCursor(last.publishedAt, last.id);
          if (index === 0 && insertIntruderAfterFirstPage) {
            await insertArticle(intruderArticle, 99);
            await insertAsset(intruderAsset);
            const all = await fetch(urlFor(null, 10));
            assert.equal(all.status, 200);
            assert.ok(
              (await all.json()).data.some((article) => article.id === intruderArticle.id),
              "the newer work really exists above the cursor",
            );
          }
          response = await fetch(urlFor(cursor));
          assert.equal(response.status, 200);
          items = (await response.json()).data;
        }
        assert.deepEqual(items, [], "the article tail page is empty");
        assert.deepEqual([...seen].sort(), [...expectedArticleIds].sort(), "every article is read once");
        assert.equal(new Set(seen).size, expectedArticleIds.length, "no article is repeated");
        assert.ok(!seen.includes(intruderArticle.id), "a newer insert does not rewind the cursor");
      };

      // A work and an asset published mid-scroll are newer than the cursor, so
      // they must not push the remaining rows out of the walk.
      await walkArticlePages(publicArticleUrl, { insertIntruderAfterFirstPage: true });
      await sql.unsafe("DELETE FROM articles WHERE id = $1", [intruderArticle.id]);
      await sql.unsafe("DELETE FROM media_assets WHERE id = $1", [intruderAsset.id]);
      await walkArticlePages(authorArticleUrl);

      const walkMediaPages = async () => {
        const seen = [];
        let cursor = null;
        let lastItem = null;
        let response = await fetch(mediaUrl(cursor), { headers: { authorization: bearer(ownerId) } });
        assert.equal(response.status, 200);
        let page = (await response.json()).data;
        for (let index = 0; index < expectedMediaIds.length; index += 1) {
          assert.equal(page.items.length, 1, `media page ${index + 1} contains one asset`);
          lastItem = page.items[0];
          seen.push(lastItem.id);
          if (index === 0) {
            await insertAsset(intruderAsset);
            const all = await fetch(mediaUrl(null, 10), { headers: { authorization: bearer(ownerId) } });
            assert.equal(all.status, 200);
            assert.ok(
              (await all.json()).data.items.some((item) => item.id === intruderAsset.id),
              "the newer asset really exists above the cursor",
            );
          }
          cursor = page.nextCursor;
          if (index < expectedMediaIds.length - 1) {
            assert.ok(cursor, "a full media page carries a next cursor");
            response = await fetch(mediaUrl(cursor), { headers: { authorization: bearer(ownerId) } });
            assert.equal(response.status, 200);
            page = (await response.json()).data;
          }
        }
        const tailCursor = encodeCursor(new Date(lastItem.createdAt).toISOString(), lastItem.id);
        const tail = await fetch(mediaUrl(tailCursor), { headers: { authorization: bearer(ownerId) } });
        assert.equal(tail.status, 200);
        const tailPage = (await tail.json()).data;
        assert.deepEqual(tailPage.items, [], "the media tail page is empty");
        assert.equal(tailPage.nextCursor, null);
        assert.deepEqual([...seen].sort(), [...expectedMediaIds].sort(), "every asset is read once");
        assert.equal(new Set(seen).size, expectedMediaIds.length, "no asset is repeated");
        assert.ok(!seen.includes(intruderAsset.id), "a newer asset does not rewind the cursor");
      };
      await walkMediaPages();
    });
  } finally {
    await sql.unsafe("DELETE FROM media_assets WHERE owner_id = $1", [ownerId]);
    await sql.unsafe("DELETE FROM articles WHERE slug LIKE $1", [`cursor-ms-%-${suffix}`]);
    await sql.unsafe("DELETE FROM user_profiles WHERE user_id = $1", [authorId]);
    await sql.unsafe("DELETE FROM auth_accounts WHERE user_id = $1", [ownerId]);
  }
});

test("PostgreSQL notification cursors page the inbox backwards, once each", integrationOptions, async () => {
  const suffix = randomUUID().replaceAll("-", "");
  const reader = `notif-cursor-reader-${suffix}`;
  const stranger = `notif-cursor-stranger-${suffix}`;
  const sameMs = "2026-06-01T00:00:00.123Z";
  const schedule = [
    "2026-06-01T00:00:00.124Z",
    sameMs, sameMs, sameMs,
    "2026-06-01T00:00:00.122Z",
  ];
  const insertNotification = async (userId, eventKey, createdAt) => {
    const id = randomUUID();
    await sql.unsafe(
      "INSERT INTO notifications (id, user_id, event_key, payload, payload_hash, created_at) VALUES ($1, $2, $3, $4::jsonb, $5, $6::timestamptz)",
      [id, userId, eventKey, { type: "cursor.test" }, "a".repeat(64), createdAt],
    );
    return { id, createdAt };
  };
  const mine = [];
  for (const [index, createdAt] of schedule.entries()) {
    mine.push(await insertNotification(reader, `cursor-${index}-${suffix}`, createdAt));
  }
  const theirs = [
    await insertNotification(stranger, `cursor-stranger-1-${suffix}`, sameMs),
    await insertNotification(stranger, `cursor-stranger-2-${suffix}`, sameMs),
  ];
  const newestFirst = (rows) => [...rows].sort((left, right) => {
    if (left.createdAt !== right.createdAt) return left.createdAt < right.createdAt ? 1 : -1;
    return left.id < right.id ? 1 : -1;
  }).map((row) => row.id);
  const expected = newestFirst(mine);

  try {
    await withApiServer(async (baseUrl) => {
      const inboxUrl = (limit, cursor = null) =>
        `${baseUrl}/me/notifications?limit=${limit}` + (cursor === null ? "" : `&cursor=${encodeURIComponent(cursor)}`);
      const authorization = bearer(reader);
      let intruderId = null;
      const walk = async (limit, { insertIntruder = false } = {}) => {
        const seen = [];
        let cursor = null;
        let page = 0;
        for (;;) {
          const response = await fetch(inboxUrl(limit, cursor), { headers: { authorization } });
          assert.equal(response.status, 200);
          const items = (await response.json()).data;
          if (items.length === 0) return seen;
          assert.ok(items.length <= limit, "a page never exceeds its limit");
          for (const item of items) seen.push(item.id);
          const last = items[items.length - 1];
          cursor = encodeCursor(last.createdAt, last.id);
          page += 1;
          assert.ok(page < 50, "the walk terminates");
          if (insertIntruder && page === 1) {
            const intruder = await insertNotification(reader, `cursor-intruder-${suffix}`, "2026-06-01T00:00:09.000Z");
            const head = await fetch(inboxUrl(10), { headers: { authorization } });
            assert.ok((await head.json()).data.some((item) => item.id === intruder.id), "the newer notice exists above the cursor");
            intruderId = intruder.id;
          }
        }
      };

      assert.deepEqual(await walk(2), expected, "every notification is read once, newest first");
      assert.deepEqual(await walk(1), expected, "a page size of one walks the same order");
      assert.deepEqual(await walk(100), expected, "a page larger than the inbox returns everything, then nothing");

      // Marking a notice read must not move it.
      const readOne = await fetch(`${baseUrl}/me/notifications/${expected[2]}/read`, { method: "PUT", headers: { authorization } });
      assert.equal(readOne.status, 200);
      assert.deepEqual(await walk(2), expected, "read state does not reorder the inbox");

      // A notice arriving mid-scroll is newer than the cursor: no repeats, no gaps.
      const withIntruder = await walk(2, { insertIntruder: true });
      assert.deepEqual(withIntruder, expected);
      assert.ok(intruderId !== null && !withIntruder.includes(intruderId), "the newer notice is not re-read by an older page");

      // The stranger's token sees the stranger's inbox, and only theirs.
      const strangerInbox = await fetch(inboxUrl(100), { headers: { authorization: bearer(stranger) } });
      assert.equal(strangerInbox.status, 200);
      assert.deepEqual(
        (await strangerInbox.json()).data.map((item) => item.id),
        newestFirst(theirs),
      );

      // Malformed cursors are the client's mistake, answered as one.
      for (const bad of ["not-a-cursor", encodeCursor("2026-06-01T00:00:00.123Z", "not-a-uuid"), Buffer.from("2026-06-01T00:00:00Z|" + randomUUID()).toString("base64url")]) {
        const response = await fetch(inboxUrl(2, bad), { headers: { authorization } });
        assert.equal(response.status, 400, `cursor ${bad} is rejected`);
        assert.deepEqual(await response.json(), { error: { code: "BAD_USER_INPUT", message: "Invalid cursor query parameter." } });
      }

      // Limit boundaries behave as documented, and an unauthenticated read stays 401.
      for (const badLimit of ["0", "101", "abc"]) {
        const response = await fetch(`${baseUrl}/me/notifications?limit=${badLimit}`, { headers: { authorization } });
        assert.equal(response.status, 400, `limit ${badLimit} is rejected`);
      }
      assert.equal((await fetch(inboxUrl(10))).status, 401);
    });
  } finally {
    await sql.unsafe("DELETE FROM notifications WHERE user_id = ANY($1::text[])", [[reader, stranger]]);
  }
});

test("PostgreSQL comment times are normalized to the cursor's millisecond precision", integrationOptions, async () => {
  const migration = await readFile(new URL("./migrations/0031_comment_created_at_millisecond_precision.sql", import.meta.url), "utf8");
  const rollback = new Error("rollback disposable comment migration fixture");
  const a = "00000000-0000-4000-8000-0000000000b1";
  const b = "00000000-0000-4000-8000-0000000000b2";
  await assert.rejects(sql.begin(async (tx) => {
    // A temporary table with the inherited shape keeps the real schema untouched
    // while giving the migration the legacy rows it is written for. The two rows
    // differ only below the millisecond, which is the case a cursor conflates.
    await tx.unsafe(`CREATE TEMP TABLE article_comments (
      id uuid PRIMARY KEY,
      article_id uuid,
      author_id text NOT NULL,
      parent_comment_id uuid,
      content text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      edited_at timestamptz
    ) ON COMMIT DROP`);
    // Sub-millisecond values arrive as SQL literals: a bound string is truncated
    // by some drivers, and these are the values a pre-migration row really holds.
    await tx.unsafe(`INSERT INTO article_comments (id, author_id, content, created_at) VALUES
      ('${a}'::uuid, 'legacy-reader', 'first', '2026-06-01T00:00:00.123900Z'::timestamptz),
      ('${b}'::uuid, 'legacy-reader', 'second', '2026-06-01T00:00:00.123400Z'::timestamptz)`);

    await tx.unsafe(migration);

    const rows = await tx.unsafe("SELECT id, created_at FROM article_comments ORDER BY content");
    assert.deepEqual(rows.map((row) => new Date(row.created_at).toISOString()), [
      "2026-06-01T00:00:00.123Z",
      "2026-06-01T00:00:00.123Z",
    ], "legacy comment times are truncated to what a cursor can name");

    // The default now agrees with the cursor, so a new comment cannot land
    // between two names for the same millisecond.
    await tx.unsafe("INSERT INTO article_comments (id, author_id, content) VALUES ('00000000-0000-4000-8000-0000000000b3'::uuid, 'legacy-reader', 'third')");
    const [created] = await tx.unsafe(
      "SELECT created_at = date_trunc('milliseconds', created_at) AS ok FROM article_comments WHERE content = 'third'",
    );
    assert.equal(created.ok, true, "the column default has no microseconds");

    // A write that bypasses the application cannot reintroduce the bug.
    await assert.rejects(tx.unsafe(
      "INSERT INTO article_comments (id, author_id, content, created_at) VALUES ('00000000-0000-4000-8000-0000000000b4'::uuid, 'legacy-reader', 'fourth', '2026-06-01T00:00:00.123900Z'::timestamptz)",
    ));
    throw rollback;
  }), (error) => error === rollback);
});

test("PostgreSQL HTTP comment cursors walk a thread across a shared millisecond", integrationOptions, async () => {
  const suffix = randomUUID().replaceAll("-", "");
  const authorId = randomUUID();
  const readerId = randomUUID();
  const slug = `comment-cursor-${suffix}`;
  // Two roots share this millisecond; the id breaks the tie, and the page
  // boundary falls inside it.
  const shared = "2026-06-01T00:00:00.123Z";
  await sql.unsafe("INSERT INTO user_profiles (user_id) VALUES ($1)", [authorId]);
  await sql.unsafe("INSERT INTO user_profile_translations (user_id, locale, display_name) VALUES ($1, 'zh-CN', $2)", [authorId, "Comment Cursor"]);
  const article = await store.createArticle({
    authorId, slug, title: `Comment cursor ${suffix}`, summary: "",
    locale: "zh-CN", contentBlocks: [{ id: "p1", type: "paragraph", text: "Thread body." }], publish: true,
  });
  const roots = [];
  for (const [content, at] of [
    ["first", "2026-06-01T00:00:00.121Z"],
    ["second", shared],
    ["third", shared],
    ["fourth", "2026-06-01T00:00:00.125Z"],
  ]) {
    const root = await store.createArticleComment({ slug, locale: "zh-CN", actorId: readerId, content });
    await sql.unsafe("UPDATE article_comments SET created_at = $1::timestamptz WHERE id = $2", [at, root.id]);
    roots.push({ id: root.id, at });
  }
  const reply = await store.createArticleComment({
    slug, locale: "zh-CN", actorId: readerId, content: "a reply", parentCommentId: roots[1].id,
  });
  const expected = [...roots]
    .sort((x, y) => (x.at === y.at ? (x.id < y.id ? -1 : 1) : x.at < y.at ? -1 : 1))
    .map((root) => root.id);

  try {
    await withApiServer(async (baseUrl) => {
      const threadUrl = (cursor = null, limit = 2) =>
        `${baseUrl}/articles/${slug}/comments?locale=zh-CN&limit=${limit}` +
        (cursor ? `&cursor=${encodeURIComponent(cursor)}` : "");
      const walk = async (limit) => {
        const seen = [];
        const pages = [];
        let cursor = null;
        for (let page = 0; page < 20; page += 1) {
          const response = await fetch(threadUrl(cursor, limit));
          assert.equal(response.status, 200);
          const items = (await response.json()).data;
          if (items.length === 0) { pages.push(0); return { seen, pages }; }
          pages.push(items.length);
          seen.push(...items.map((item) => item.id));
          const last = items[items.length - 1];
          cursor = encodeCursor(last.createdAt, last.id);
        }
        throw new Error("the walk terminates");
      };

      const twoAtATime = await walk(2);
      assert.deepEqual(twoAtATime.pages, [2, 2, 0], "a page counts top-level comments only");
      assert.deepEqual(twoAtATime.seen, expected, "every root is read once, oldest first");
      assert.deepEqual(await walk(1).then((result) => result.seen), expected, "a page size of one walks the same order");
      assert.deepEqual(await walk(100).then((result) => result.seen), expected, "a page larger than the thread returns everything");

      // The reply travels with its root rather than becoming a page of its own.
      const secondPage = (await (await fetch(threadUrl(encodeCursor(roots[0].at, roots[0].id)))).json()).data;
      const withReplies = secondPage.find((item) => item.id === roots[1].id);
      assert.ok(withReplies, "the replied-to root is on the page");
      assert.deepEqual(withReplies.replies.map((item) => item.id), [reply.id]);

      // Malformed cursors are the client's mistake, answered as one.
      for (const bad of [
        "not-a-cursor",
        encodeCursor("2026-06-01T00:00:00.123Z", "not-a-uuid"),
        Buffer.from("2026-06-01T00:00:00Z|" + randomUUID()).toString("base64url"),
      ]) {
        const response = await fetch(threadUrl(bad));
        assert.equal(response.status, 400, `cursor ${bad} is rejected`);
        assert.deepEqual(await response.json(), { error: { code: "BAD_USER_INPUT", message: "Invalid comment cursor." } });
      }

      // A slug that is not a published work reads as an empty thread, with or
      // without a cursor: the read path answers "nothing here", not an error.
      for (const path of [
        `${baseUrl}/articles/no-such-work-${suffix}/comments?locale=zh-CN`,
        `${baseUrl}/articles/no-such-work-${suffix}/comments?locale=zh-CN&cursor=${encodeURIComponent(encodeCursor(shared, roots[0].id))}`,
      ]) {
        const response = await fetch(path);
        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), { data: [] });
      }
    });
  } finally {
    await sql.unsafe("DELETE FROM articles WHERE id = $1", [article.id]);
    await sql.unsafe("DELETE FROM user_profile_translations WHERE user_id = $1", [authorId]);
    await sql.unsafe("DELETE FROM user_profiles WHERE user_id = $1", [authorId]);
  }
});
