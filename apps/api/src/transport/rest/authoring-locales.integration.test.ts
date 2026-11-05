import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import test from "node:test";
import { createApiServer } from "../../server.ts";
import { createSqliteClient, runSqliteMigrations } from "../../persistence/sqlite.ts";
import { createSqliteStore } from "../../persistence/sqlite-store.ts";
import { createPostgresClient, createPostgresStore } from "../../persistence/postgres.ts";
import { runMigrations } from "../../persistence/migrate.ts";

// These are full HTTP → service → real database journeys, not a fake adapter.
// The Traditional Chinese row is seeded through the store to represent content
// that existed before this REST endpoint could write that locale.
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

const blocks = (text: string) => [{ id: "p1", type: "paragraph", text }];

for (const provider of ["sqlite", "postgres"] as const) {
  test(`authoring locales survive REST write, discovery, edit and restore (${provider})`, {
    skip: provider === "postgres" && !process.env.TEST_DATABASE_URL && "Set TEST_DATABASE_URL to run PostgreSQL integration tests.",
  }, async () => {
    const db = provider === "sqlite" ? createSqliteClient({ filename: ":memory:", enableWal: false }) : null;
    const sql = provider === "postgres" ? await createPostgresClient({ connectionString: process.env.TEST_DATABASE_URL, max: 4 }) : null;
    if (db) await runSqliteMigrations(db);
    if (sql) await runMigrations(sql);
    const store = db ? createSqliteStore(db) : createPostgresStore(sql!);
    const suffix = randomUUID().slice(0, 8);
    const author = `locale-author-${suffix}`;
    const outsider = `locale-outsider-${suffix}`;
    const auth = (actor: string) => ({ authorization: `Bearer ${token(actor)}` });
    const jsonHeaders = { ...auth(author), "content-type": "application/json" };
    const legacy = await store.createArticle({ authorId: author, slug: `legacy-${suffix}`, title: "原有繁體作品",
      locale: "zh-TW", contentBlocks: blocks("原有繁體正文。"), publish: false });
    await store.createArticle({ authorId: outsider, slug: `private-${suffix}`, title: "Another author's private work",
      locale: "en", contentBlocks: blocks("Private text"), publish: false });
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
      assert.match(response.headers.get("cache-control") ?? "", /no-store/);
      return result;
    }
    try {
      const cnBody = { slug: `simplified-${suffix}`, title: "简体作品", contentBlocks: blocks("简体正文。") };
      const cn = (await call("/articles", 201, { method: "POST", headers: jsonHeaders, body: JSON.stringify(cnBody) })).data;
      assert.equal(cn.locale, "zh-CN", "omitting locale keeps the existing Simplified Chinese default");
      const enBody = { slug: `english-${suffix}`, title: "English work", locale: "en", contentBlocks: blocks("Original English text.") };
      const keyed = { ...jsonHeaders, "idempotency-key": `locale-create-${suffix}` };
      const en = (await call("/articles", 201, { method: "POST", headers: keyed, body: JSON.stringify(enBody) })).data;
      const replay = (await call("/articles", 201, { method: "POST", headers: keyed, body: JSON.stringify(enBody) })).data;
      assert.equal(en.id, replay.id, "a retry of an English create must not duplicate it");
      assert.equal(en.locale, "en");
      await call("/articles", 409, { method: "POST", headers: keyed, body: JSON.stringify({ ...enBody, locale: "zh-CN" }) });
      await call("/articles", 400, { method: "POST", headers: jsonHeaders, body: JSON.stringify({ ...enBody, locale: "fr" }) });
      await call("/articles", 401, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(enBody) });

      const list = async (query = "") => (await call(`/me/articles${query}`, 200, { headers: auth(author) })).data;
      assert.deepEqual((await list()).map((item) => item.id), [cn.id], "the old default remains locale-specific");
      assert.deepEqual((await list("?locale=en")).map((item) => item.id), [en.id]);
      const allResponse = await call("/me/articles?allLocales=true&limit=100", 200, { headers: auth(author) });
      assert.deepEqual(new Set(allResponse.meta.locales), new Set(["zh-CN", "zh-TW", "en"]), "a client can detect an older API that silently ignored the option");
      let all = allResponse.data;
      assert.deepEqual(new Set(all.map((item) => `${item.id}:${item.locale}`)), new Set([`${cn.id}:zh-CN`, `${en.id}:en`, `${legacy.id}:zh-TW`]));
      assert.equal(all.some((item) => item.authorId !== author), false, "another author's draft stays private");
      const bounded = await list("?allLocales=true&limit=1");
      assert.equal(bounded.length, 3, "the opt-in limit applies independently to each locale");
      await call("/me/articles?locale=all", 400, { headers: auth(author) });
      await call("/me/articles?allLocales=false", 400, { headers: auth(author) });
      await call("/me/articles?allLocales=true&locale=en", 400, { headers: auth(author) });
      await call("/me/articles?allLocales=true", 401);

      const edit = async (id: string, body: object, actor = author) => call(`/articles/${id}`, 200, {
        method: "PUT", headers: { ...auth(actor), "content-type": "application/json" }, body: JSON.stringify(body),
      });
      const enEdit = { ...enBody, title: "Edited English", contentBlocks: blocks("Edited English text."), publish: false };
      assert.equal((await edit(en.id, enEdit)).data.locale, "en");
      const legacyEdit = { slug: legacy.slug, title: "編輯後的繁體作品", locale: "zh-TW", contentBlocks: blocks("編輯後的繁體正文。"), publish: false };
      assert.equal((await edit(legacy.id, legacyEdit)).data.locale, "zh-TW");
      await call(`/articles/${en.id}`, 403, { method: "PUT", headers: { ...auth(outsider), "content-type": "application/json" }, body: JSON.stringify(enEdit) });
      all = await list("?allLocales=true&limit=100");
      assert.equal(all.find((item) => item.id === en.id && item.locale === "en")?.contentBlocks[0].text, "Edited English text.");
      assert.equal(all.find((item) => item.id === legacy.id)?.contentBlocks[0].text, "編輯後的繁體正文。");
      assert.equal((await list()).some((item) => item.id === legacy.id || item.id === en.id), false, "editing cannot silently relabel content as zh-CN");

      // An explicit locale change creates a second translation of the same work.
      // Both must remain independently discoverable, never deduplicated by id.
      await edit(en.id, { ...enEdit, locale: "zh-CN", title: "另一个中文译本", contentBlocks: blocks("独立的中文正文。") });
      all = await list("?allLocales=true&limit=100");
      assert.deepEqual(new Set(all.filter((item) => item.id === en.id).map((item) => item.locale)), new Set(["zh-CN", "en"]));
      assert.equal(all.find((item) => item.id === en.id && item.locale === "en")?.title, "Edited English");
      assert.equal(all.find((item) => item.id === en.id && item.locale === "zh-CN")?.title, "另一个中文译本");

      await call(`/articles/${en.id}`, 200, { method: "DELETE", headers: auth(author) });
      await call(`/articles/${legacy.id}`, 200, { method: "DELETE", headers: auth(author) });
      const trashResponse = await call("/me/articles/deleted?allLocales=true&limit=100", 200, { headers: auth(author) });
      assert.deepEqual(new Set(trashResponse.meta.locales), new Set(["zh-CN", "zh-TW", "en"]));
      const trash = trashResponse.data;
      assert.deepEqual(new Set(trash.map((item) => `${item.id}:${item.locale}`)), new Set([`${en.id}:en`, `${en.id}:zh-CN`, `${legacy.id}:zh-TW`]));
      await call(`/articles/${legacy.id}/restore?locale=zh-TW`, 403, { method: "POST", headers: auth(outsider) });
      await call(`/articles/${legacy.id}/restore`, 404, { method: "POST", headers: auth(author) });
      const restoredLegacy = (await call(`/articles/${legacy.id}/restore?locale=zh-TW`, 200, { method: "POST", headers: auth(author) })).data;
      assert.equal(restoredLegacy.locale, "zh-TW");
      assert.equal(restoredLegacy.title, "編輯後的繁體作品");
      const restoredEn = (await call(`/articles/${en.id}/restore?locale=en`, 200, { method: "POST", headers: auth(author) })).data;
      assert.equal(restoredEn.locale, "en");
      assert.equal(restoredEn.status, "draft");
      all = await list("?allLocales=true&limit=100");
      assert.deepEqual(new Set(all.filter((item) => item.id === en.id).map((item) => item.locale)), new Set(["zh-CN", "en"]));
      assert.equal(all.find((item) => item.id === legacy.id)?.locale, "zh-TW");
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      if (sql) {
        await sql.unsafe("DELETE FROM articles WHERE author_id = ANY($1::text[])", [[author, outsider]]);
        await sql.end({ timeout: 5 });
      }
      db?.close();
    }
  });
}
