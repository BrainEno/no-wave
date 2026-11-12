import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import test from "node:test";
import sharp from "sharp";
import { createMediaAssetService } from "../../application/media-assets.ts";
import { createApplicationServices } from "../../application/services.ts";
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

/** Ordinary HTTP journeys now explicitly preview each write; stale-token cases
 * live in import-version-protection.integration.test.ts and never re-preview. */
async function previewedImport(url: string, init: RequestInit): Promise<Response> {
  const body = JSON.parse(String(init.body)) as { bundle?: unknown; apply?: boolean; planToken?: string };
  if (body.apply === true && body.planToken === undefined) {
    const preview = await fetch(url, { ...init, body: JSON.stringify({ ...body, apply: false }) });
    const result = await preview.json();
    assert.equal(preview.status, 200, JSON.stringify(result));
    return fetch(url, { ...init, body: JSON.stringify({ ...body, planToken: result.data.planToken }) });
  }
  return fetch(url, init);
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
      const response = path === "/imports/notion" && expectedStatus === 200
        ? await previewedImport(base + path, init) : await fetch(base + path, init);
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

      // 7. The other direction: the work comes back out as a bundle.
      // A session first, exactly like every other session-only read: an anonymous
      // caller cannot use the status code to learn what the endpoint accepts.
      await call(`/imports/notion/export?slugs=${page.slug}`, 401);
      await call("/imports/notion/export", 401);
      const authorHeaders = { headers: { authorization: `Bearer ${token(author)}` } };
      await call("/imports/notion/export", 400, authorHeaders);
      await call("/imports/notion/export?slugs=Not%20A%20Slug", 400, authorHeaders);
      const empty = await call("/imports/notion/export?slugs=no-such-work", 200, {
        headers: { authorization: `Bearer ${token(author)}` },
      });
      assert.deepEqual(empty.data.bundle.pages, []);
      assert.deepEqual(empty.data.report.missing, ["no-such-work"]);

      const exported = await call(`/imports/notion/export?slugs=${page.slug}`, 200, {
        headers: { authorization: `Bearer ${token(author)}` },
      });
      const exportedPage = exported.data.bundle.pages[0];
      // The page id is the page the work came from, so pushing this back to Notion
      // updates that page rather than creating a duplicate.
      assert.equal(exportedPage.id, pageId);
      assert.equal(exported.data.report.works[0].pages[0].provenance, "notion");
      assert.equal(exportedPage.properties.Page.title[0].plain_text, "墙壁");
      assert.equal(exportedPage.properties.Slug.rich_text[0].plain_text, page.slug);
      // The `Date` is the work's publication day *here*: this site stamps the
      // instant when a work is published, so the day Notion carried and the day
      // the site published on are two different facts, and only the second one is
      // stored.
      assert.equal(exportedPage.properties.Date.date.start, reread.data.publishedAt.slice(0, 10));
      assert.equal(exportedPage.properties.Published.checkbox, true);
      assert.deepEqual(exportedPage.properties.Tags.multi_select, [{ name: "诗歌" }]);
      assert.match(JSON.stringify(exportedPage.blocks), /改过的正文/);
      assert.deepEqual(exported.data.report.works[0].issues, [], "this work loses nothing on the way out");

      // An export is a read: repeating it changes nothing.
      const repeated = await call(`/imports/notion/export?slugs=${page.slug}`, 200, {
        headers: { authorization: `Bearer ${token(author)}` },
      });
      assert.deepEqual(repeated.data.bundle, exported.data.bundle);
      assert.equal(await linkCount(), 1, "an export writes no provenance row");

      // A separate preview/apply journey gets a fresh test-only rate bucket.
      if (db) db.exec("DELETE FROM auth_rate_limits"); else await sql!.unsafe("DELETE FROM auth_rate_limits");

      // 8. The bundle is one the import accepts, and it addresses the work it came
      // from rather than creating a second one. The first re-import is an
      // `update` — the digest covers the page's date, and the day this site
      // published on is not the day the original bundle carried — and the second
      // is a `skip`: the memory converges after one pass, and nothing drifts.
      const roundTrip = await call("/imports/notion", 200, post(author, { bundle: exported.data.bundle, apply: true }));
      assert.deepEqual(roundTrip.data.summary, { create: 0, update: 1, skip: 0, refused: 0, failed: 0 });
      assert.equal(roundTrip.data.pages[0].articleId, page.articleId);
      const settled = await call("/imports/notion", 200, post(author, { bundle: exported.data.bundle, apply: true }));
      assert.deepEqual(settled.data.summary, { create: 0, update: 0, skip: 1, refused: 0, failed: 0 });

      // 9. A work written here has no Notion page, so it exports with an id this
      // API made up — and another account's export of the same address is empty,
      // not a 403 that would confirm the work exists.
      const created = await call("/articles", 201, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token(author)}` },
        body: JSON.stringify({
          title: `手写的作品 ${suffix}`,
          contentBlocks: [{ id: "block-1", type: "paragraph", text: "在本站写的正文" }],
          publish: true,
        }),
      });
      const handwritten = await call(`/imports/notion/export?slugs=${created.data.slug}`, 200, {
        headers: { authorization: `Bearer ${token(author)}` },
      });
      assert.equal(handwritten.data.report.works[0].pages[0].provenance, "site");
      assert.equal(handwritten.data.bundle.pages[0].id, `site:${created.data.id}:zh-CN`);
      const theirs = await call(`/imports/notion/export?slugs=${created.data.slug}`, 200, {
        headers: { authorization: `Bearer ${token(other)}` },
      });
      assert.deepEqual(theirs.data.report.missing, [created.data.slug]);
      assert.deepEqual(theirs.data.bundle.pages, []);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await forgetThisRun();
      if (db) db.close();
      if (sql) await sql.end({ timeout: 5 });
    }
  });
}


test("Notion images are normalized into media storage and remain retryable over HTTP", async () => {
  const db = createSqliteClient({ filename: ":memory:", enableWal: false });
  await runSqliteMigrations(db);
  const store = createSqliteStore(db);
  const objects = new Map<string, Buffer>();
  let storageDown = false;
  const storage = {
    async putObject({ key, bytes }: { key: string; bytes: Buffer }) { if (storageDown) throw new Error("storage unavailable"); objects.set(key, bytes); },
    async getObject(key: string) { const found = objects.get(key); assert.ok(found); return found; },
    async deleteObject(key: string) { objects.delete(key); },
    close() {},
  };
  const mediaAssets = createMediaAssetService({ store, storage });
  const applicationServices = createApplicationServices({ persistence: store, env });
  const server = createApiServer({ applicationServices, env, logger: () => {}, mediaAssets });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}/api/v1`;
  const originalFetch = globalThis.fetch;
  const bytes = await sharp({ create: { width: 3, height: 3, channels: 3, background: "red" } }).png().toBuffer();
  let imageBytes = bytes;
  let downloaded = 0;
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith("https://prod-files-secure.s3.amazonaws.com/")) {
      downloaded++;
      return new Response(new Uint8Array(imageBytes), { headers: { "content-type": "image/png" } });
    }
    return originalFetch(url, init);
  };
  const author = randomUUID();
  db.prepare("INSERT INTO auth_accounts (user_id, email, password_hash) VALUES (?, ?, ?)").run(author, "image@example.test", "fixture");
  const doc = notionPage(`image-page-${randomUUID()}`, "图片作品", "正文");
  doc.blocks.push({ object: "block", id: "image", type: "image", has_children: false,
    image: { type: "file", file: { url: "https://prod-files-secure.s3.amazonaws.com/image?signature=secret" }, caption: [] } } as never);
  const bundle = notionBundle(doc);
  const post = async (apply: boolean, chosen = bundle) => {
    const res = await previewedImport(`${base}/imports/notion`, { method: "POST", headers: { authorization: `Bearer ${token(author)}`, "content-type": "application/json" }, body: JSON.stringify({ bundle: chosen, apply }) });
    const json = await res.json();
    assert.equal(res.status, 200, JSON.stringify(json));
    return json.data;
  };
  try {
    assert.equal((await post(false)).summary.create, 1);
    assert.equal(downloaded, 0);
    const applied = await post(true);
    assert.equal(applied.summary.create, 1);
    assert.equal(downloaded, 1);
    assert.equal(objects.size, 1, JSON.stringify(applied));
    const article = await store.getMyArticle({ articleId: applied.pages[0].articleId, actorId: author, locale: "zh-CN" });
    assert.ok(article);
    const blocks = typeof article.contentBlocks === "string" ? JSON.parse(article.contentBlocks) : article.contentBlocks;
    const image = (blocks as { type: string; src: string }[]).find((block) => block.type === "image");
    assert.match(image?.src ?? "", /^\/api\/media\//);
    const publicImage = await originalFetch(`${base}/media/${image!.src.split("/").at(-1)}`);
    assert.equal(publicImage.status, 200);
    assert.equal(publicImage.headers.get("content-type"), "image/webp");
    assert.equal((await post(true)).summary.skip, 1);
    assert.equal(downloaded, 1);

    // A refreshed signature changes the plan, but identical normalized bytes
    // can reuse the previously owned asset after a real download and check.
    const refreshed = structuredClone(doc);
    refreshed.blocks[1] = { ...doc.blocks[1]!, image: { type: "file", file: { url: "https://prod-files-secure.s3.amazonaws.com/image?signature=renewed" }, caption: [] } } as never;
    const refreshedBundle = notionBundle(refreshed);
    assert.equal((await post(false, refreshedBundle)).summary.update, 1);
    assert.equal(downloaded, 1, "preview never downloads");
    assert.equal((await post(true, refreshedBundle)).summary.update, 1);
    assert.equal(downloaded, 2);
    assert.equal(objects.size, 1, "identical normalized image reuses its asset");
    const refreshedArticle = await store.getMyArticle({ articleId: article.id, actorId: author, locale: "zh-CN" });
    assert.match(JSON.stringify(refreshedArticle?.contentBlocks), new RegExp(image!.src));

    // The same source path is not proof of unchanged contents. A changed body
    // with a new signature must create a new asset instead of keeping stale data.
    imageBytes = await sharp({ create: { width: 3, height: 3, channels: 3, background: "blue" } }).png().toBuffer();
    refreshed.blocks[1] = { ...doc.blocks[1]!, image: { type: "file", file: { url: "https://prod-files-secure.s3.amazonaws.com/image?signature=third" }, caption: [] } } as never;
    assert.equal((await post(true, notionBundle(refreshed))).summary.update, 1);
    assert.equal(objects.size, 2);
    const changedArticle = await store.getMyArticle({ articleId: article.id, actorId: author, locale: "zh-CN" });
    assert.doesNotMatch(JSON.stringify(changedArticle?.contentBlocks), new RegExp(image!.src));
    db.exec("DELETE FROM auth_rate_limits");

    const retryDoc = notionPage(`retry-${randomUUID()}`, "第二篇", "保留的正文");
    retryDoc.blocks.push(doc.blocks[1]!);
    const retryBundle = notionBundle(retryDoc);
    storageDown = true;
    const partial = await post(true, retryBundle);
    assert.equal(partial.summary.create, 1);
    assert.ok(partial.pages[0].issues.some((issue: { code: string }) => issue.code === "image-copy-failed"));
    const partialArticle = await store.getMyArticle({ articleId: partial.pages[0].articleId, actorId: author, locale: "zh-CN" });
    assert.doesNotMatch(JSON.stringify(partialArticle?.contentBlocks), /signature=secret/);
    assert.equal((await post(false, retryBundle)).summary.update, 1);
    storageDown = false;
    assert.equal((await post(true, retryBundle)).summary.update, 1);
    assert.equal((await post(false, retryBundle)).summary.skip, 1);
    assert.equal(objects.size, 3);

    const onlyImage = notionPage(`only-image-${randomUUID()}`, "只有图片", "正文");
    onlyImage.blocks.splice(0, onlyImage.blocks.length, doc.blocks[1]!);
    storageDown = true;
    const refusedEmpty = await post(true, notionBundle(onlyImage));
    assert.equal(refusedEmpty.summary.failed, 1);
    assert.ok(refusedEmpty.pages[0].issues.some((issue: { code: string }) => issue.code === "image-copy-failed"));
    assert.equal(refusedEmpty.pages[0].articleId, null);

    // Start this separate journey with a fresh write-rate bucket.
    db.exec("DELETE FROM auth_rate_limits");
    // Simulate a historical pre-atomic import whose provenance was lost.
    // Recovery must address that article, not create a second media UUID.
    storageDown = false;
    const recoveryDoc = notionPage(`recover-${randomUUID()}`, "丢失的链接", "正文");
    recoveryDoc.blocks.push(doc.blocks[1]!);
    const recoveryBundle = notionBundle(recoveryDoc);
    const original = await post(true, recoveryBundle);
    assert.equal(original.summary.create, 1);
    const originalId = original.pages[0].articleId;
    assert.ok(originalId);
    db.prepare("DELETE FROM external_content_links WHERE article_id = ?").run(originalId);
    const before = downloaded;
    const plan = await post(false, recoveryBundle);
    assert.equal(plan.summary.update, 1);
    assert.equal(plan.pages[0].articleId, originalId);
    assert.match(plan.pages[0].detail, /recover.*existing edits may be replaced/);
    assert.equal(downloaded, before);
    const repaired = await post(true, recoveryBundle);
    assert.equal(repaired.summary.update, 1);
    assert.equal(repaired.pages[0].articleId, originalId);
    assert.match(repaired.pages[0].detail, /recovered missing import link/);
    assert.equal((await post(false, recoveryBundle)).summary.skip, 1);
    const matches = db.prepare("SELECT count(*) AS n FROM articles WHERE author_id = ? AND idempotency_key_hash IS NOT NULL").get(author);
    assert.equal(Number(matches?.n), 3, "three successful creates, not a second recovery article");
  } finally {
    globalThis.fetch = originalFetch;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
  }
});

test("PostgreSQL repairs an article created before image provenance failed", {
  skip: !process.env.TEST_DATABASE_URL && "Set TEST_DATABASE_URL to run PostgreSQL integration tests.",
}, async () => {
  const sql = await createPostgresClient({ connectionString: process.env.TEST_DATABASE_URL, max: 4 });
  await runMigrations(sql);
  const store = createPostgresStore(sql);
  const author = randomUUID();
  await sql.unsafe("INSERT INTO auth_accounts (user_id, email, password_hash) VALUES ($1, $2, $3)", [author, `${author}@example.test`, "fixture"]);
  await sql.unsafe("DELETE FROM auth_rate_limits");
  const objects = new Map<string, Buffer>();
  const storage = {
    async putObject({ key, bytes }: { key: string; bytes: Buffer }) { objects.set(key, bytes); },
    async getObject(key: string) { const value = objects.get(key); assert.ok(value); return value; },
    async deleteObject(key: string) { objects.delete(key); },
    close() {},
  };
  const applicationServices = createApplicationServices({ persistence: store, env });
  const server = createApiServer({ applicationServices, env, logger: () => {}, mediaAssets: createMediaAssetService({ store, storage }) });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}/api/v1`;
  const originalFetch = globalThis.fetch;
  const png = await sharp({ create: { width: 3, height: 3, channels: 3, background: "red" } }).png().toBuffer();
  globalThis.fetch = async (url, init) => String(url).startsWith("https://prod-files-secure.s3.amazonaws.com/")
    ? new Response(new Uint8Array(png), { headers: { "content-type": "image/png" } }) : originalFetch(url, init);
  const doc = notionPage(`recover-${randomUUID()}`, "恢复图文", "正文");
  doc.blocks.push({ object: "block", id: "image", type: "image", has_children: false,
    image: { type: "file", file: { url: "https://prod-files-secure.s3.amazonaws.com/image?signature=secret" }, caption: [] } } as never);
  const bundle = notionBundle(doc);
  const post = async (apply: boolean, chosen = bundle) => {
    const response = await previewedImport(`${base}/imports/notion`, { method: "POST", headers: { authorization: `Bearer ${token(author)}`, "content-type": "application/json" }, body: JSON.stringify({ bundle: chosen, apply }) });
    const result = await response.json();
    assert.equal(response.status, 200, JSON.stringify(result));
    return result.data;
  };
  try {
    const original = await post(true);
    assert.equal(original.summary.create, 1);
    const id = original.pages[0].articleId;
    assert.ok(id);
    await sql.unsafe("DELETE FROM external_content_links WHERE article_id = $1", [id]);
    const preview = await post(false);
    assert.equal(preview.summary.update, 1);
    assert.equal(preview.pages[0].articleId, id);
    const repaired = await post(true);
    assert.equal(repaired.summary.update, 1);
    assert.equal(repaired.pages[0].articleId, id);
    assert.equal((await post(false)).summary.skip, 1);
    assert.equal(objects.size, 1, "recovery verified and reused its prior media");
    const fresh = structuredClone(doc);
    fresh.blocks[1] = { ...doc.blocks[1]!, image: { type: "file", file: { url: "https://prod-files-secure.s3.amazonaws.com/image?signature=fresh" }, caption: [] } } as never;
    assert.equal((await post(false, notionBundle(fresh))).summary.update, 1);
    assert.equal((await post(true, notionBundle(fresh))).summary.update, 1);
    assert.equal(objects.size, 1, "refreshed signature does not duplicate identical media");
    const count = await sql.unsafe("SELECT count(*)::int AS n FROM articles WHERE author_id = $1", [author]);
    assert.equal(count[0]?.n, 1);
  } finally {
    globalThis.fetch = originalFetch;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await sql.unsafe("DELETE FROM articles WHERE author_id = $1", [author]);
    await sql.unsafe("DELETE FROM auth_accounts WHERE user_id = $1", [author]);
    await sql.end();
  }
});

test("Markdown conversion imports real articles and keeps filename identity scoped by author", async () => {
  const { markdownEntriesToBundle } = await import("../../../../../packages/web-ui/src/lib/notion-markdown.ts");
  const db = createSqliteClient({ filename: ":memory:", enableWal: false });
  await runSqliteMigrations(db);
  const server = createApiServer({ store: createSqliteStore(db), env, logger: () => {} });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const post = async (actor: string, apply: boolean) => {
    const bundle = markdownEntriesToBundle([{ name: "my-work.md", text: "# 标题\n\nPublished: Yes\nTags: 诗歌\n\n正文内容。" }]).bundle;
    const response = await previewedImport(`http://127.0.0.1:${address.port}/api/v1/imports/notion`, {
      method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token(actor)}` }, body: JSON.stringify({ bundle, apply }),
    });
    assert.equal(response.status, 200);
    return (await response.json()).data;
  };
  try {
    const first = await post("markdown-author-one", false);
    assert.equal(first.summary.create, 1);
    const written = await post("markdown-author-one", true);
    assert.equal(written.summary.create, 1);
    assert.equal((await post("markdown-author-one", true)).summary.skip, 1);
    assert.equal((await post("markdown-author-two", true)).summary.create, 1);
    assert.equal(Number(db.prepare("SELECT count(*) AS count FROM articles").get()?.count), 2);
    const stored = db.prepare("SELECT content_blocks FROM article_translations WHERE title = ? LIMIT 1").get("标题");
    assert.match(String(stored?.content_blocks), /正文内容/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
  }
});

for (const provider of ["sqlite", "postgres"] as const) {
  test(`selection and provenance conflicts cannot overwrite or duplicate works (${provider})`, {
    skip: provider === "postgres" && !process.env.TEST_DATABASE_URL && "Set TEST_DATABASE_URL to run PostgreSQL integration tests.",
  }, async () => {
    const db = provider === "sqlite" ? createSqliteClient({ filename: ":memory:", enableWal: false }) : null;
    const sql = provider === "postgres" ? await createPostgresClient({ connectionString: process.env.TEST_DATABASE_URL, max: 4 }) : null;
    if (db) await runSqliteMigrations(db); else await runMigrations(sql!);
    const store = db ? createSqliteStore(db) : createPostgresStore(sql!);
    const author = `selection-${randomUUID()}`;
    const ids = Array.from({ length: 5 }, () => randomUUID());
    const server = createApiServer({ store, env, logger: () => {} });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const call = async (pages: ReturnType<typeof notionPage>[], apply: boolean) => {
      const response = await previewedImport(`http://127.0.0.1:${address.port}/api/v1/imports/notion`, {
        method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token(author)}` },
        body: JSON.stringify({ bundle: notionBundle(...pages), apply }),
      });
      assert.equal(response.status, 200);
      return (await response.json()).data;
    };
    const count = async () => db
      ? Number(db.prepare("SELECT count(*) AS n FROM articles WHERE author_id = ?").get(author)?.n)
      : Number((await sql!.unsafe("SELECT count(*)::int AS n FROM articles WHERE author_id = $1", [author]))[0]?.n);
    try {
      const primary = notionPage(ids[0]!, "原文", "原文内容");
      const child1 = notionPage(ids[1]!, "子文一", "正文一");
      const child2 = notionPage(ids[2]!, "子文二", "正文二");
      for (const child of [child1, child2]) Object.assign(child.properties, { "Parent item": { type: "relation", relation: [{ id: primary.id }] } });
      const hierarchy = await call([primary, child1, child2], true);
      assert.equal(hierarchy.summary.create, 3);
      assert.equal(await count(), 3);
      assert.equal(hierarchy.pages.filter((p: { issues: { code: string }[] }) => p.issues.some((i) => i.code === "hierarchy-not-carried")).length, 2);

      const zh = notionPage(ids[3]!, "中英原文", "中文正文");
      const en = notionPage(ids[4]!, "English translation", "English body");
      Object.assign(zh.properties, { English: { type: "relation", relation: [{ id: en.id }] } });
      delete (en.properties as Partial<typeof en.properties>).Date;
      const pair = await call([zh, en], true);
      assert.equal(pair.summary.create, 1);
      assert.equal(pair.summary.update, 1);
      assert.equal(await count(), 4);
      for (const apply of [false, true]) {
        const partial = await call([en], apply);
        assert.equal(partial.summary.refused, 1);
        assert.match(partial.pages[0].detail, /another locale/);
        assert.equal(await count(), 4);
      }
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (db) db.close();
      if (sql) {
        await sql.unsafe("DELETE FROM external_content_links WHERE owner_id = $1", [author]);
        await sql.unsafe("DELETE FROM articles WHERE author_id = $1", [author]);
        await sql.end();
      }
    }
  });
}
