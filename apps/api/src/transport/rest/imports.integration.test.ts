import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import test from "node:test";
import { createApiServer } from "../../server.ts";
import { createSqliteClient, runSqliteMigrations } from "../../persistence/sqlite.ts";
import { createSqliteStore } from "../../persistence/sqlite-store.ts";
import { createPostgresClient, createPostgresStore } from "../../persistence/postgres.ts";
import { runMigrations } from "../../persistence/migrate.ts";

/**
 * `POST /api/v1/imports/notion` over real HTTP and a real database.
 *
 * The point of running it against both providers is not coverage for its own
 * sake: the import's memory is a table, and a table that behaves differently on
 * SQLite and PostgreSQL would make "re-importing is a no-op" true on one
 * deployment and false on the other.
 *
 * The last assertion of the apply case is the one that matters for the product:
 * the imported work is read back through the **public** API, unauthenticated,
 * because that is what the web client and the Flutter client call. An import that
 * only the authoring desk can see would be a private copy, not a published work.
 */

const env = {
  AUTH_JWT_SECRET: "test-only-secret-at-least-thirty-two-bytes",
  AUTH_JWT_ISSUER: "https://auth.example.test",
  AUTH_JWT_AUDIENCE: "bot-thk-api",
};

function token(sub: string): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const header = encode({ alg: "HS256", typ: "application/vnd.bot-thk.access+jwt" });
  const payload = encode({ sub, iss: env.AUTH_JWT_ISSUER, aud: env.AUTH_JWT_AUDIENCE,
    iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 300,
    sid: `session-${sub}`, jti: `token-${sub}` });
  const unsigned = `${header}.${payload}`;
  return `${unsigned}.${createHmac("sha256", env.AUTH_JWT_SECRET).update(unsigned).digest("base64url")}`;
}

const text = (content: string) => ({ type: "text", plain_text: content, href: null, text: { content, link: null }, annotations: { bold: false, italic: false, underline: false, strikethrough: false, code: false, color: "default" } });
const paragraph = (content: string) => ({ object: "block", id: "p", type: "paragraph", has_children: false, paragraph: { rich_text: content ? [text(content)] : [], color: "default" } });

/** One page of the real database's shape: title, date, published, tags, body. */
function notionPage(id: string, title: string, body: string) {
  return {
    id,
    properties: {
      Page: { type: "title", title: [text(title)] },
      Date: { type: "date", date: { start: "2026-10-08", end: null } },
      Published: { type: "checkbox", checkbox: true },
      Tags: { type: "multi_select", multi_select: [{ name: "诗歌" }] },
    },
    blocks: body ? [paragraph(body)] : [],
  };
}

function notionBundle(...pages: ReturnType<typeof notionPage>[]) {
  return { version: 1, database: { id: "01331af0-b39c-4c76-991c-a2d67804c5ca", title: "Bottom Think" }, pages };
}

for (const provider of ["sqlite", "postgres"] as const) {
  test(`a Notion bundle imports into the caller's own works (${provider})`, {
    skip: provider === "postgres" && !process.env.TEST_DATABASE_URL && "Set TEST_DATABASE_URL to run PostgreSQL integration tests.",
  }, async () => {
    const db = provider === "sqlite" ? createSqliteClient({ filename: ":memory:", enableWal: false }) : null;
    const sql = provider === "postgres" ? await createPostgresClient({ connectionString: process.env.TEST_DATABASE_URL, max: 4 }) : null;
    if (db) await runSqliteMigrations(db);
    if (sql) await runMigrations(sql);
    const store = db ? createSqliteStore(db) : createPostgresStore(sql!);
    // The write rate limiter is composed from the store, so a suite that makes
    // several imports must start from empty buckets; a previous run's rows would
    // otherwise turn a legitimate assertion into a 429.
    if (db) db.exec("DELETE FROM auth_rate_limits");
    else await sql!.unsafe("DELETE FROM auth_rate_limits");

    const suffix = randomUUID().slice(0, 8);
    const author = `import-author-${suffix}`;
    const other = `import-other-${suffix}`;
    const pageId = `notion-page-${suffix}`;
    const bundle = notionBundle(notionPage(pageId, "墙壁", "穿透层层墙壁，多重多重的缓冲"));
    const server = createApiServer({ store, env, logger: () => {} });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const base = `http://127.0.0.1:${address.port}/api/v1`;

    async function call(path: string, expectedStatus: number, init: RequestInit = {}) {
      const response = await fetch(base + path, init);
      const result = await response.json();
      assert.equal(response.status, expectedStatus, `${init.method ?? "GET"} ${path}: ${JSON.stringify(result)}`);
      return result;
    }
    const post = (actor: string | null, body: unknown) => ({
      method: "POST",
      headers: { "content-type": "application/json", ...(actor ? { authorization: `Bearer ${token(actor)}` } : {}) },
      body: JSON.stringify(body),
    });
    // Counted by this run's suffix, never absolutely: the PostgreSQL database is
    // reused between runs, so an absolute count would pass once and then fail
    // forever on the rows the previous run left behind.
    const linkCount = async (): Promise<number> => {
      const like = `%${suffix}%`;
      if (db) return Number(db.prepare("SELECT count(*) AS n FROM external_content_links WHERE external_id LIKE ?").get(like)?.n ?? 0);
      const rows = await sql!.unsafe("SELECT count(*)::int AS n FROM external_content_links WHERE external_id LIKE $1", [like]);
      return Number(rows[0]?.n ?? 0);
    };
    const forgetThisRun = async (): Promise<void> => {
      const like = `%${suffix}%`;
      if (db) {
        db.prepare("DELETE FROM external_content_links WHERE external_id LIKE ?").run(like);
        db.prepare("DELETE FROM articles WHERE author_id LIKE ?").run(like);
        return;
      }
      await sql!.unsafe("DELETE FROM external_content_links WHERE external_id LIKE $1", [like]);
      await sql!.unsafe("DELETE FROM articles WHERE author_id LIKE $1", [like]);
    };
    await forgetThisRun();

    try {
      // A session is required: an anonymous caller cannot write works.
      await call("/imports/notion", 401, post(null, { bundle, apply: true }));
      assert.equal((await call(`/me/articles?actorId=${author}`, 401)).error.code, "UNAUTHENTICATED");

      // 1. A dry run reads the bundle and writes nothing at all.
      const dry = await call("/imports/notion", 200, post(author, { bundle }));
      assert.equal(dry.data.applied, false);
      assert.deepEqual(dry.data.summary, { create: 1, update: 0, skip: 0, refused: 0, failed: 0 });
      assert.equal(await linkCount(), 0, "a dry run records no provenance");
      assert.deepEqual((await call("/me/articles", 200, { headers: { authorization: `Bearer ${token(author)}` } })).data, []);

      // 2. Applying creates the work, and the public API can serve it.
      const applied = await call("/imports/notion", 200, post(author, { bundle, apply: true }));
      assert.equal(applied.data.applied, true);
      assert.deepEqual(applied.data.summary, { create: 1, update: 0, skip: 0, refused: 0, failed: 0 });
      const page = applied.data.pages[0];
      assert.equal(page.action, "create");
      assert.equal(page.locale, "zh-CN");
      assert.ok(page.articleId, "the report names the work it created");
      assert.equal(await linkCount(), 1, "one link, one page edition");

      const mine = await call("/me/articles", 200, { headers: { authorization: `Bearer ${token(author)}` } });
      assert.equal(mine.data.length, 1);
      assert.equal(mine.data[0].slug, page.slug);

      // The public read — no token, the same request the web and Flutter clients
      // make — is what proves the import produced a readable work.
      const published = await call(`/articles/${page.slug}`, 200);
      assert.equal(published.data.title, "墙壁");
      assert.equal(published.data.status, "published");
      assert.match(JSON.stringify(published.data.contentBlocks), /穿透层层墙壁/);

      // 3. The same bundle again is a no-op: the link table is the memory.
      const again = await call("/imports/notion", 200, post(author, { bundle, apply: true }));
      assert.deepEqual(again.data.summary, { create: 0, update: 0, skip: 1, refused: 0, failed: 0 });
      assert.equal(again.data.pages[0].articleId, page.articleId);
      assert.equal((await call("/me/articles", 200, { headers: { authorization: `Bearer ${token(author)}` } })).data.length, 1);

      // 4. A changed page updates the same work and keeps its address.
      const changed = await call("/imports/notion", 200, post(author, {
        bundle: notionBundle(notionPage(pageId, "墙壁", "改过的正文")),
        apply: true,
      }));
      assert.deepEqual(changed.data.summary, { create: 0, update: 1, skip: 0, refused: 0, failed: 0 });
      assert.equal(changed.data.pages[0].slug, page.slug, "a re-import never renames the work");
      const reread = await call(`/articles/${page.slug}`, 200);
      assert.match(JSON.stringify(reread.data.contentBlocks), /改过的正文/);
      assert.equal(await linkCount(), 1, "an update replaces the link instead of adding one");

      // 5. Another account cannot claim the same page, and sees nothing of it.
      const stolen = await call("/imports/notion", 200, post(other, { bundle, apply: true }));
      assert.deepEqual(stolen.data.summary, { create: 0, update: 0, skip: 0, refused: 1, failed: 0 });
      assert.match(stolen.data.pages[0].detail, /another account/);
      assert.deepEqual((await call("/me/articles", 200, { headers: { authorization: `Bearer ${token(other)}` } })).data, []);

      // 6. A body that is not a bundle is the caller's mistake, not a 500.
      await call("/imports/notion", 400, post(author, { bundle: { version: 9, pages: "nope" }, apply: true }));
      await call("/imports/notion", 400, post(author, { apply: true }));
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await forgetThisRun();
      if (db) db.close();
      if (sql) await sql.end({ timeout: 5 });
    }
  });
}
