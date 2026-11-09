import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import test, { after, before } from "node:test";
import { signAccessToken } from "../security/authentication.ts";
import { createApiServer } from "../server.ts";
import { createMediaAssetService } from "../application/media-assets.ts";
import { ARTICLE_VIEW_WINDOW_SECONDS } from "../application/article-views.ts";
import { createPostgresClient, createPostgresStore } from "./postgres.ts";
import { runMigrations } from "./migrate.ts";

/**
 * The view counter end to end (ADR 0035).
 *
 * The unit tests decide what a view is and the contract test proves the column
 * moves; what only a real database and a real server can show is the interaction
 * that matters in production: the dedupe bucket lives in `auth_rate_limits`, it
 * is keyed by a digest the application cannot read back, and the number the API
 * returns on one request is the number the next request — from another reader —
 * builds on.
 */

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
  AUTH_JWT_ISSUER: "https://views.integration.test",
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
    await new Promise((resolve) => server.close(resolve));
  }
}

test("PostgreSQL view beacons count each reader once a day and never the author", integrationOptions, async () => {
  const suffix = randomUUID().replaceAll("-", "");
  const authorId = randomUUID();
  const readerOne = randomUUID();
  const readerTwo = randomUUID();
  const slug = `viewed-work-${suffix}`;
  await sql.unsafe("INSERT INTO user_profiles (user_id) VALUES ($1)", [authorId]);
  await sql.unsafe(
    "INSERT INTO user_profile_translations (user_id, locale, display_name) VALUES ($1, 'zh-CN', $2)",
    [authorId, "View Author"],
  );
  const article = await store.createArticle({
    authorId, slug, title: `Viewed ${suffix}`, summary: "",
    locale: "zh-CN", contentBlocks: [{ id: "p1", type: "paragraph", text: "被阅读的正文。" }], publish: true,
  });

  try {
    await withApiServer(async (baseUrl) => {
      const beacon = (authorization = null) =>
        fetch(`${baseUrl}/articles/${slug}/views?locale=zh-CN`, {
          method: "POST",
          headers: authorization === null ? {} : { authorization },
        });
      const detail = async () => (await (await fetch(`${baseUrl}/articles/${slug}?locale=zh-CN`)).json()).data;

      // Reader one, first read of the day.
      const first = await beacon(bearer(readerOne));
      assert.equal(first.status, 200);
      assert.deepEqual(await first.json(), { data: { counted: true, viewCount: 1 } });

      // Reader one again: the bucket is spent, and the answer says so without an
      // error status — a refresh is not a failure.
      const repeat = await beacon(bearer(readerOne));
      assert.equal(repeat.status, 200);
      assert.deepEqual(await repeat.json(), { data: { counted: false, viewCount: 1 } });

      // Reader two is a different reader.
      const second = await beacon(bearer(readerTwo));
      assert.equal(second.status, 200);
      assert.deepEqual(await second.json(), { data: { counted: true, viewCount: 2 } });

      // The author's own visits are proofreading, and the count proves it.
      for (let visit = 0; visit < 2; visit += 1) {
        const own = await beacon(bearer(authorId));
        assert.equal(own.status, 200);
        assert.deepEqual(await own.json(), { data: { counted: false, viewCount: 2 } });
      }

      // An anonymous reader is counted too, keyed by address rather than account.
      const anonymous = await beacon();
      assert.equal(anonymous.status, 200);
      assert.deepEqual(await anonymous.json(), { data: { counted: true, viewCount: 3 } });
      // And the same address does not count twice in a day.
      assert.deepEqual(await (await beacon()).json(), { data: { counted: false, viewCount: 3 } });

      // The stored number is what every read path reports.
      const stored = await detail();
      assert.equal(stored.viewCount, 3);
      const listed = (await (await fetch(`${baseUrl}/articles?locale=zh-CN&query=${encodeURIComponent(suffix)}&limit=10`)).json()).data;
      assert.equal(listed.find((item) => item.id === article.id)?.viewCount, 3, "the list carries the same number");

      // The dedupe rows are digests, and they carry no reader and no address.
      const buckets = await sql.unsafe(
        "SELECT key, attempts FROM auth_rate_limits WHERE reset_at > now()",
      );
      const digests = buckets.filter((row) => /^[0-9a-f]{64}$/.test(row.key)).map((row) => row.key);
      assert.ok(digests.length > 0, "the day's buckets were written");
      for (const value of [authorId, readerOne, readerTwo]) {
        assert.ok(!digests.some((digest) => digest.includes(value)), "a bucket key never contains an account id");
      }
      // The window is a day, not a minute: a reader who returns in an hour is the
      // same reader.
      const viewBuckets = await sql.unsafe(
        `SELECT reset_at FROM auth_rate_limits WHERE reset_at > now() AND attempts = 1`,
      );
      assert.ok(viewBuckets.length > 0);
      const horizon = Date.now() + (ARTICLE_VIEW_WINDOW_SECONDS - 60) * 1000;
      assert.ok(viewBuckets.every((row) => new Date(row.reset_at).getTime() <= horizon + 60_000));
    });
  } finally {
    await sql.unsafe("DELETE FROM articles WHERE id = $1", [article.id]);
    await sql.unsafe("DELETE FROM user_profile_translations WHERE user_id = $1", [authorId]);
    await sql.unsafe("DELETE FROM user_profiles WHERE user_id = $1", [authorId]);
  }
});
