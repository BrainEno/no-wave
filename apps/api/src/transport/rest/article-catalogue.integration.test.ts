import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import test from "node:test";
import { createApiServer } from "../../server.ts";
import { signAccessToken } from "../../security/authentication.ts";
import { createSqliteClient, runSqliteMigrations } from "../../persistence/sqlite.ts";
import { createSqliteStore } from "../../persistence/sqlite-store.ts";
import { createPostgresClient, createPostgresStore } from "../../persistence/postgres.ts";
import { runMigrations } from "../../persistence/migrate.ts";

for (const provider of ["sqlite", "postgres"] as const) {
  test(`catalogue REST reads are private, lightweight and open only the requested own edition (${provider})`, {
    skip: provider === "postgres" && !process.env.TEST_DATABASE_URL && "Set TEST_DATABASE_URL for real PostgreSQL.",
  }, async () => {
    const db = provider === "sqlite" ? createSqliteClient({ filename: ":memory:", enableWal: false }) : null;
    const sql = provider === "postgres" ? await createPostgresClient({ connectionString: process.env.TEST_DATABASE_URL, max: 4 }) : null;
    if (db) await runSqliteMigrations(db);
    if (sql) await runMigrations(sql);
    const store = db ? createSqliteStore(db) : createPostgresStore(sql!);
    const actor = `catalogue-http-${randomUUID()}`, other = `catalogue-http-other-${randomUUID()}`;
    const env = { AUTH_JWT_SECRET: randomBytes(48).toString("base64"), AUTH_JWT_ISSUER: "https://auth.example.test", AUTH_JWT_AUDIENCE: "catalogue-test" };
    const headers = (subject: string) => {
      const now = Math.floor(Date.now() / 1000);
      return { authorization: `Bearer ${signAccessToken({ subject, tokenId: randomUUID(), sessionId: randomUUID(), issuedAt: now, expiresAt: now + 300, env })}` };
    };
    const blocks = [{ id: "p1", type: "paragraph", text: "HTTP-OWN-PRIVATE-BODY" }];
    const own = await store.createArticle({ authorId: actor, slug: `catalogue-own-${randomUUID()}`, title: "Own draft", contentBlocks: blocks, locale: "en" });
    const foreign = await store.createArticle({ authorId: other, slug: `catalogue-other-${randomUUID()}`, title: "OTHER-ACCOUNT-TITLE", contentBlocks: blocks });
    const server = createApiServer({ store, env, logger: () => {} });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address(); assert.ok(address && typeof address === "object");
    const base = `http://127.0.0.1:${address.port}/api/v1`;
    async function call(path: string, status = 200, subject: string | null = actor) {
      const response = await fetch(base + path, { headers: subject ? headers(subject) : {} });
      const body = await response.json();
      assert.equal(response.status, status, JSON.stringify(body));
      assert.match(response.headers.get("cache-control") ?? "", /no-store/);
      if (path.startsWith("/me/article-catalogue")) assert.match(response.headers.get("x-robots-tag") ?? "", /noindex/);
      return body;
    }
    try {
      await call("/me/article-catalogue", 401, null);
      await call("/me/article-catalogue?actorId=another", 400);
      await call("/me/article-catalogue?locale=en&locale=zh-CN", 400);
      const page = (await call("/me/article-catalogue?locale=en&status=draft")).data;
      assert.equal(page.total, 1);
      assert.equal(page.items[0].id, own.id);
      assert.equal(page.nextCursor, null);
      assert.ok(!JSON.stringify(page).includes("HTTP-OWN-PRIVATE-BODY"));
      assert.ok(!JSON.stringify(page).includes("OTHER-ACCOUNT-TITLE"));
      assert.deepEqual(Object.keys(page.items[0]).sort(), ["id", "slug", "title", "summary", "locale", "status", "workType", "createdAt", "updatedAt", "deletedAt"].sort());
      assert.equal((await call(`/me/article-catalogue/${own.id}?locale=en`)).data.contentBlocks[0].text, "HTTP-OWN-PRIVATE-BODY");
      await call(`/me/article-catalogue/${own.id}?locale=zh-CN`, 404);
      await call(`/me/article-catalogue/${foreign.id}?locale=zh-CN`, 404);
      await call(`/me/article-catalogue/${randomUUID()}?locale=zh-CN`, 404);
      assert.equal((await call(`/me/article-catalogue/${own.id}/editions?scope=active`)).data[0].locale, "en");
      await call(`/me/article-catalogue/${foreign.id}/editions?scope=active`, 404);
      await call(`/me/article-catalogue/${own.id}/editions?scope=all`, 400);
      await call(`/me/article-catalogue/${own.id}`, 400);
      await call(`/me/article-catalogue/${own.id}?locale=en&actorId=another`, 400);
      assert.ok(Array.isArray((await call("/me/articles?allLocales=true")).data), "the existing full-body list contract is unchanged");
      await store.deleteArticle({ articleId: own.id, actorId: actor });
      await call(`/me/article-catalogue/${own.id}?locale=en`, 404);
      assert.equal((await call("/me/article-catalogue?scope=trash")).data.items[0].id, own.id);
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      if (sql) { await sql.unsafe("DELETE FROM articles WHERE author_id = ANY($1::text[])", [[actor, other]]); await sql.end({ timeout: 5 }); }
      db?.close();
    }
  });
}
