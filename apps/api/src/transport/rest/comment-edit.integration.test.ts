import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import test from "node:test";

import { createApiServer } from "../../server.ts";
import { createSqliteClient, runSqliteMigrations } from "../../persistence/sqlite.ts";
import { createSqliteStore } from "../../persistence/sqlite-store.ts";
import { createPostgresClient, createPostgresStore } from "../../persistence/postgres.ts";
import { runMigrations } from "../../persistence/migrate.ts";
import { COMMENT_DEPTH_LIMIT_MESSAGE, MAX_COMMENT_REPLY_DEPTH } from "../../domain/comment-content.ts";

// Comment editing (ADR 0031) end to end: HTTP → service → real database, on both
// providers. The properties a reader can observe are the ones under test — the
// text changes, the "edited" marker appears and stays, the thread order and the
// parent link do not move, and somebody else's comment is refused.
const env = {
  AUTH_JWT_SECRET: "test-only-secret-at-least-thirty-two-bytes",
  AUTH_JWT_ISSUER: "https://auth.example.test",
  AUTH_JWT_AUDIENCE: "bot-thk-api",
};

function token(sub: string): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const header = encode({ alg: "HS256", typ: "application/vnd.bot-thk.access+jwt" });
  const payload = encode({
    sub, iss: env.AUTH_JWT_ISSUER, aud: env.AUTH_JWT_AUDIENCE,
    iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 300,
    sid: `session-${sub}`, jti: `token-${sub}`,
  });
  const unsigned = `${header}.${payload}`;
  return `${unsigned}.${createHmac("sha256", env.AUTH_JWT_SECRET).update(unsigned).digest("base64url")}`;
}

const blocks = (text: string) => [{ id: "p1", type: "paragraph", text }];

for (const provider of ["sqlite", "postgres"] as const) {
  test(`a comment can be corrected by its author over REST (${provider})`, {
    skip: provider === "postgres" && !process.env.TEST_DATABASE_URL && "Set TEST_DATABASE_URL to run PostgreSQL integration tests.",
  }, async () => {
    const db = provider === "sqlite" ? createSqliteClient({ filename: ":memory:", enableWal: false }) : null;
    const sql = provider === "postgres" ? await createPostgresClient({ connectionString: process.env.TEST_DATABASE_URL, max: 4 }) : null;
    if (db) await runSqliteMigrations(db);
    if (sql) await runMigrations(sql);
    const store = db ? createSqliteStore(db) : createPostgresStore(sql!);
    const suffix = randomUUID().slice(0, 8);
    const author = `edit-author-${suffix}`;
    const stranger = `edit-stranger-${suffix}`;
    const slug = `edit-thread-${suffix}`;
    const auth = (actor: string) => ({ authorization: `Bearer ${token(actor)}` });
    const jsonHeaders = (actor: string) => ({ ...auth(actor), "content-type": "application/json" });

    await store.createArticle({
      authorId: `edit-owner-${suffix}`, slug, title: "Comment editing journey", summary: "",
      locale: "zh-CN", contentBlocks: blocks("Body of the work."), publish: true,
    });

    const server = createApiServer({ store, env, logger: () => {} });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const base = `http://127.0.0.1:${address.port}/api/v1`;
    async function call(path: string, init: RequestInit = {}, expectedStatus?: number) {
      const response = await fetch(base + path, init);
      const result = await response.json();
      if (expectedStatus !== undefined) {
        assert.equal(response.status, expectedStatus, `${init.method ?? "GET"} ${path}: ${JSON.stringify(result)}`);
      }
      assert.match(response.headers.get("cache-control") ?? "", /no-store/);
      return { status: response.status, body: result as Record<string, unknown> };
    }

    try {
      const created = await call(`/articles/${slug}/comments?locale=zh-CN`, {
        method: "POST", headers: jsonHeaders(author),
        body: JSON.stringify({ editorState: editorState("First wording."), contentBlocksVersion: 1 }),
      }, 201);
      const comment = created.body.data as Record<string, unknown>;
      const commentId = String(comment.id);
      assert.equal(comment.editedAt, null, "a fresh comment is not marked as edited");

      // A visitor cannot edit anything: the credential is required before the
      // body is even considered.
      const anonymous = await call(`/comments/${commentId}?locale=zh-CN`, {
        method: "PATCH", headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "Anonymous edit." }),
      });
      assert.equal(anonymous.status, 401);

      // Somebody else's comment is refused, and the answer does not depend on
      // whether the id exists.
      const strangerEdit = await call(`/comments/${commentId}?locale=zh-CN`, {
        method: "PATCH", headers: jsonHeaders(stranger),
        body: JSON.stringify({ content: "Somebody else's words." }),
      });
      assert.equal(strangerEdit.status, 403);
      assert.equal((strangerEdit.body.error as Record<string, unknown>).code, "FORBIDDEN");
      const missingEdit = await call(`/comments/${randomUUID()}?locale=zh-CN`, {
        method: "PATCH", headers: jsonHeaders(stranger),
        body: JSON.stringify({ content: "Nothing here." }),
      });
      assert.equal(missingEdit.status, 404);

      const originalCreatedAt = String(comment.createdAt);
      const edited = await call(`/comments/${commentId}?locale=zh-CN`, {
        method: "PATCH", headers: jsonHeaders(author),
        body: JSON.stringify({ editorState: editorState("Second wording."), contentBlocksVersion: 1 }),
      }, 200);
      const body = edited.body.data as Record<string, unknown>;
      assert.equal(body.id, commentId);
      assert.equal(body.content, "Second wording.");
      assert.equal(body.createdAt, originalCreatedAt, "an edit keeps the comment where it was in the thread");
      assert.equal(body.parentCommentId, null);
      assert.equal(typeof body.editedAt, "string", "an edit stamps editedAt");
      assert.equal(body.authorId, author, "an edit cannot hand the comment to another account");

      // The public thread read is what a reader sees: the new text and the marker.
      const listed = await call(`/articles/${slug}/comments?locale=zh-CN`);
      const thread = listed.body.data as Array<Record<string, unknown>>;
      assert.equal(thread.length, 1);
      assert.equal(thread[0]?.content, "Second wording.");
      assert.equal(typeof thread[0]?.editedAt, "string");

      // An edit may not move a reply to another parent: that would rewrite the
      // thread the reply answered, and only creation chooses a parent.
      const reparented = await call(`/comments/${commentId}?locale=zh-CN`, {
        method: "PATCH", headers: jsonHeaders(author),
        body: JSON.stringify({ content: "Moved.", parentCommentId: randomUUID() }),
      });
      assert.equal(reparented.status, 400);

      // A body without content is a bad request, not an empty comment.
      const empty = await call(`/comments/${commentId}?locale=zh-CN`, {
        method: "PATCH", headers: jsonHeaders(author), body: JSON.stringify({}),
      });
      assert.equal(empty.status, 400);

      /*
       * A thread has a bottom (#246).
       *
       * The write path used to accept any reply while the read path stopped at a
       * fixed level, so a deep reply was created and then never came back: 201,
       * refresh, gone. The cap is asserted here as a *transport* contract, because
       * that is where a writer meets it — a 400 whose message says what to do
       * instead of a comment that silently disappears.
       */
      let parentId: string | null = null;
      const chain: string[] = [];
      for (let depth = 0; depth <= MAX_COMMENT_REPLY_DEPTH; depth += 1) {
        const posted = await call(`/articles/${slug}/comments?locale=zh-CN`, {
          method: "POST", headers: jsonHeaders(author),
          body: JSON.stringify({ content: `Depth ${depth}`, parentCommentId: parentId }),
        }, 201);
        parentId = String((posted.body.data as Record<string, unknown>).id);
        chain.push(parentId);
      }
      const tooDeep = await call(`/articles/${slug}/comments?locale=zh-CN`, {
        method: "POST", headers: jsonHeaders(author),
        body: JSON.stringify({ content: "Too deep", parentCommentId: parentId }),
      });
      assert.equal(tooDeep.status, 400);
      // A code of its own, not the generic `BAD_USER_INPUT`: the client has to be
      // able to say what went wrong, and "the request input is invalid" is not it.
      assert.equal((tooDeep.body.error as Record<string, unknown>).code, "COMMENT_DEPTH_EXCEEDED");
      assert.equal((tooDeep.body.error as Record<string, unknown>).message, COMMENT_DEPTH_LIMIT_MESSAGE);

      // Everything that was accepted is returned: the cap is a rule about writing,
      // never a truncation of what the reader is shown.
      const deepThread = await call(`/articles/${slug}/comments?locale=zh-CN`, {}, 200);
      const seen = new Set<string>();
      const visit = (nodes: unknown) => {
        if (!Array.isArray(nodes)) return;
        for (const node of nodes) {
          if (typeof node !== "object" || node === null) continue;
          const record = node as Record<string, unknown>;
          if (typeof record.id === "string") seen.add(record.id);
          visit(record.replies);
        }
      };
      visit(deepThread.body.data);
      assert.deepEqual(chain.filter((id) => !seen.has(id)), [], "an accepted comment must never be truncated away");

      // Deleting still works after an edit, and a deleted comment cannot be edited.
      await call(`/comments/${commentId}`, { method: "DELETE", headers: auth(author) }, 200);
      const afterDelete = await call(`/comments/${commentId}?locale=zh-CN`, {
        method: "PATCH", headers: jsonHeaders(author), body: JSON.stringify({ content: "After deletion." }),
      });
      assert.equal(afterDelete.status, 404);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await db?.close();
      await sql?.end({ timeout: 5 });
    }
  });
}

/** A one-paragraph serialized Lexical state, as the composer produces. */
function editorState(text: string): Record<string, unknown> {
  return {
    root: {
      children: [
        {
          children: [{ detail: 0, format: 0, mode: "normal", style: "", text, type: "text", version: 1 }],
          direction: null, format: "", indent: 0, type: "paragraph", version: 1,
        },
      ],
      direction: null, format: "", indent: 0, type: "root", version: 1,
    },
  };
}
