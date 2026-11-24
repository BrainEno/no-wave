/**
 * Comments, the article reader, the Notion import and OAuth pages, the catalogue and the writing desk.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { MOCK_COMMENT_ID, MOCK_DELETED_ARTICLE_ID, MOCK_TOKENS } from "../mocks/rest-api.ts";
import { registerPublicWebApp, DESK_COOKIE, articleBody, del, get, mockApi, patch, post, postEmpty, put } from "./support/web-behavior-harness.ts";

registerPublicWebApp();

/**
 * #242: a comment write has to be proposed where the credential lives.
 *
 * `nw_access` is scoped to `/api/authoring` (ADR 0025), so a browser never sends
 * it to `/api/articles/...`. The write only looked correct because the proxy
 * attaches the cookie from the *request* it received: with the read path
 * registered as the write path too, every submission arrived without a token,
 * took a 401, and paid for a refresh-token rotation before the retry could
 * succeed — two round trips and a database write per comment, for nothing.
 *
 * Both halves are asserted here: the authoring aliases exist and answer, and one
 * submission produces exactly one upstream call, carrying the credential.
 */
test("the Notion import resource rejects GET without invoking an import", async () => {
  const result = await get("/api/authoring/notion-import");
  assert.equal(result.status, 405);
  assert.equal(JSON.parse(result.body).error.code, "METHOD_NOT_ALLOWED");
});

test("a comment write is served under /api/authoring, where the access cookie is sent", async () => {
  const path = "/api/authoring/articles/portable-web-foundation/comments?locale=zh-CN";
  mockApi.resetRequests();
  const created = await post(path, JSON.stringify({ body: "作者可以在原处改字" }), {
    cookie: `nw_access=${MOCK_TOKENS.accessToken}`,
  });
  assert.equal(created.status, 201, created.body);

  const calls = mockApi.requests();
  assert.equal(
    calls.filter((call) => call.includes("/api/v1/articles/") && call.includes("/comments")).length,
    1,
    `one submission is one upstream write: ${calls.join(", ")}`,
  );
  assert.equal(
    calls.filter((call) => call.includes("/api/v1/auth/refresh")).length,
    0,
    "a credential was presented, so no rotation was needed",
  );

  // Cross-origin is still refused on the alias, and still refused before the API
  // is reached: two registrations of one handler must not mean two policies.
  mockApi.resetRequests();
  const cross = await post(path, JSON.stringify({ body: "好" }), { origin: "https://evil.test" });
  assert.equal(cross.status, 403);
  assert.deepEqual(mockApi.requests(), []);
});

test("a comment edit is served under /api/authoring too", async () => {
  const edit = await patch(`/api/authoring/comments/${MOCK_COMMENT_ID}?locale=zh-CN`,
    JSON.stringify({ content: "改过的字" }), { cookie: `nw_access=${MOCK_TOKENS.accessToken}` });
  assert.equal(edit.status, 200, edit.body);
  const payload = JSON.parse(edit.body) as { data: { content: string; editedAt: string | null } };
  assert.equal(payload.data.content, "改过的字");
  assert.equal(typeof payload.data.editedAt, "string");

  // An id that is not a comment id is refused locally, without a round trip.
  mockApi.resetRequests();
  const refused = await patch("/api/authoring/comments/not-a-uuid?locale=zh-CN",
    JSON.stringify({ content: "改过的字" }), { cookie: `nw_access=${MOCK_TOKENS.accessToken}` });
  assert.equal(refused.status, 400);
  assert.deepEqual(mockApi.requests(), []);
});

/**
 * The article page's interactive parts are part of the page, not of a later
 * phase: the reader toolbar, the table of contents and the comment section are
 * client components, and the comment section is only useful together with the
 * endpoint it calls. They are asserted in the server-rendered HTML (the mount
 * points) and in the client bundle (`client-bundle.test.ts`, the code that
 * hydrates them) — the two halves that together mean "this will work in a
 * browser".
 */
test("the article page renders the reader toolbar, the table of contents and the comment section", async () => {
  const result = await get("/articles/portable-web-foundation");
  assert.equal(result.status, 200);
  // ReaderBar: font size, paper/ink and copy-link controls.
  assert.match(result.body, /class="nw-rs" role="group"/);
  // ReadingProgress measures this element; ReaderToc links to its headings.
  assert.match(result.body, /id="nw-article"/);
  assert.match(result.body, /class="nw-toc"/);
  // ArticleComments: the section, and the composer that posts to the proxy above.
  assert.match(result.body, /class="nw-comment-section"/);
  assert.match(result.body, /nw-comment-editor/);
});

test("the Notion import page is private, renders its panel, and is gated the same way", async () => {
  // No session marker: the loader answers the browser it sent, not a shell it
  // would then have to make interactive for somebody who is not signed in.
  const anonymous = await get("/write/notion");
  assert.ok([302, 307].includes(anonymous.status), `expected a redirect, got ${anonymous.status}`);
  assert.match(anonymous.headers.get("location") ?? "", /^\/sign-in\?next=%2Fwrite%2Fnotion$/);
  assert.match(anonymous.headers.get("cache-control") ?? "", /no-store/);

  // Signed in: the page is the shared panel, unindexed like the rest of `/write`.
  // Two cookies, because the loader reads the marker (`nw_session`, a timestamp
  // with no credential in it) and the API read that follows uses the token.
  const signedIn = await get("/write/notion", {
    cookie: `${DESK_COOKIE}; nw_session=${Math.floor((Date.now() + 3_600_000) / 1000)}`,
  });
  assert.equal(signedIn.status, 200);
  assert.match(signedIn.body, /data-route="write-notion"/);
  assert.match(signedIn.body, /从 Notion 导入/);
  assert.match(signedIn.body, /noindex/);
  assert.match(signedIn.headers.get("cache-control") ?? "", /no-store/);
});

test("the Notion OAuth callback renders without a sign-in redirect, never echoes the code, and sends no referrer", async () => {
  // No session marker on purpose: a redirect would drop or carry the one-time code.
  const callback = await get("/write/notion/oauth/callback?code=TESTONLY-CODE-0001&state=v1.1.a.b");
  assert.equal(callback.status, 200);
  assert.match(callback.body, /data-route="write-notion-oauth-callback"/);
  assert.match(callback.body, /正在完成 Notion 授权/);
  assert.doesNotMatch(callback.body, /TESTONLY-CODE-0001/);
  assert.equal(callback.headers.get("referrer-policy"), "no-referrer");
  assert.match(callback.headers.get("cache-control") ?? "", /no-store/);
  assert.match(callback.body, /noindex/);

  // The three proxy routes exist; start and exchange refuse anything but a same-origin POST.
  assert.equal((await get("/api/authoring/notion-oauth/start", { cookie: DESK_COOKIE })).status, 405);
  assert.equal((await get("/api/authoring/notion-oauth/exchange", { cookie: DESK_COOKIE })).status, 405);
  const crossOrigin = await post("/api/authoring/notion-oauth/start", "", { cookie: DESK_COOKIE, origin: "https://evil.test" });
  assert.equal(crossOrigin.status, 403);
  assert.equal(JSON.parse(crossOrigin.body).error.code, "ORIGIN_REJECTED");
});

test("the catalogue shell is private/noindex and does not SSR private terms or metadata", async () => {
  const anonymous = await get("/write/library");
  assert.equal(anonymous.status, 302);
  assert.equal(anonymous.headers.get("location"), "/sign-in?next=%2Fwrite%2Flibrary");
  assert.match(anonymous.headers.get("cache-control") ?? "", /no-store/);
  const signedIn = await get("/write/library", { cookie: `nw_session=${Math.floor(Date.now() / 1000) + 3600}` });
  assert.equal(signedIn.status, 200);
  assert.match(signedIn.body, /data-route="write-library"/);
  assert.match(signedIn.body, /作品目录/);
  assert.match(signedIn.body, /noindex/);
  assert.match(signedIn.headers.get("cache-control") ?? "", /no-store/);
});

test("catalogue resource routes reach guarded private handlers rather than a page or a 404", async () => {
  for (const path of ["/api/authoring/catalogue", `/api/authoring/catalogue/${MOCK_DELETED_ARTICLE_ID}?locale=en`, `/api/authoring/catalogue/${MOCK_DELETED_ARTICLE_ID}/editions?scope=trash`]) {
    const response = await get(path, { cookie: DESK_COOKIE });
    assert.equal(response.status, 400, path);
    assert.match(response.headers.get("cache-control") ?? "", /no-store/);
    assert.match(response.headers.get("x-robots-tag") ?? "", /noindex/);
    assert.equal(JSON.parse(response.body).error.code, "BAD_USER_INPUT");
  }
  const response = await post(`/api/authoring/catalogue/${MOCK_DELETED_ARTICLE_ID}/restore?locale=en`, "", { cookie: DESK_COOKIE, origin: "https://evil.test" });
  assert.equal(response.status, 403);
  assert.equal(JSON.parse(response.body).error.code, "ORIGIN_REJECTED");
});

test("the writing desk renders its shared client component, privately", async () => {
  const result = await get("/write");
  assert.equal(result.status, 200);
  assert.match(result.body, /data-route="write"/);
  // The desk's own first line: the shared workspace is rendered here, not a
  // reduced stand-in, and it is the client component that draws the rest.
  assert.match(result.body, /正在验证登录状态并载入草稿/);
  assert.match(result.headers.get("cache-control") ?? "", /no-store/);
  assert.match(result.body, /noindex/);
});

test("every private page answers no-store, sign-in included", async () => {
  // By URL, over the production build. `/sign-in` is the page that shipped
  // without a `headers` export (F-18); the rest of the list is here because the
  // failure mode is a page somebody forgot, not a page that answers wrongly.
  const privatePaths = [
    "/sign-in",
    "/sign-in?next=%2Faccount",
    "/forgot-password",
    "/reset-password",
    "/verify-email",
    "/search?q=%E6%8A%B5%E6%8A%97",
    "/write",
    "/write/media",
    "/write/library",
    "/write/notion",
    "/write/notion/oauth/callback",
    "/feed",
    "/messages",
    "/notifications",
    "/en/notifications",
    "/account",
    "/admin/featured",
  ];
  for (const path of privatePaths) {
    const result = await get(path);
    assert.ok(
      [200, 302, 307].includes(result.status),
      `${path} must render or redirect rather than fail (got ${result.status})`,
    );
    assert.match(
      result.headers.get("cache-control") ?? "",
      /no-store/,
      `${path} is per-visitor and must never be held by a shared cache`,
    );
  }
});

test("a signed-out desk is told it is signed out, not handed an error page", async () => {
  const result = await get("/api/authoring/session");
  assert.equal(result.status, 401);
  assert.match(result.headers.get("cache-control") ?? "", /no-store/);
});

test("a signed-in desk reads its session and its own work", async () => {
  const session = await get("/api/authoring/session", { cookie: DESK_COOKIE });
  assert.equal(session.status, 200);
  // The account, as `GET /api/v1/me` answers it: an id, an address and a
  // verification state. The display name is not part of it, and the desk never
  // asked for one.
  assert.match(session.body, /"email"/);
  assert.match(session.body, /"emailVerifiedAt"/);
  assert.equal(session.body.includes(MOCK_TOKENS.accessToken), false);
  assert.match(session.headers.get("cache-control") ?? "", /no-store/);

  const list = await get("/api/authoring/articles", { cookie: DESK_COOKIE });
  assert.equal(list.status, 200);
  assert.match(list.headers.get("cache-control") ?? "", /no-store/);
  // Seeded from the catalogue, so the desk lists what this author published.
  assert.match(list.body, /可移植的文学基础设施/);
});

test("the desk creates a work, and it shows up in the author's list", async () => {
  const created = await post("/api/authoring/articles", articleBody("Desk Draft Alpha"), { cookie: DESK_COOKIE });
  assert.equal(created.status, 201);
  const article = (JSON.parse(created.body) as { data: { slug: string; status: string } }).data;
  assert.equal(article.slug, "desk-draft-alpha", "the address is derived, not supplied");
  assert.equal(article.status, "draft");

  const list = await get("/api/authoring/articles", { cookie: DESK_COOKIE });
  assert.match(list.body, /Desk Draft Alpha/);
});

test("saving the same work again updates it instead of creating a second one", async () => {
  const created = await post("/api/authoring/articles", articleBody("Desk Draft Beta"), { cookie: DESK_COOKIE });
  assert.equal(created.status, 201);
  const { id } = (JSON.parse(created.body) as { data: { id: string } }).data;

  const updated = await put(`/api/authoring/articles/${id}`, articleBody("Desk Draft Beta", true), { cookie: DESK_COOKIE });
  assert.equal(updated.status, 200);
  const article = (JSON.parse(updated.body) as { data: { id: string; status: string } }).data;
  assert.equal(article.id, id, "the update must address the same article");
  assert.equal(article.status, "published");

  const list = await get("/api/authoring/articles", { cookie: DESK_COOKIE });
  assert.equal((list.body.match(/desk-draft-beta/g) ?? []).length, 1, "a second save must not duplicate the work");
});

test("a published work can be withdrawn to a draft again", async () => {
  const created = await post("/api/authoring/articles", articleBody("Desk Withdraw Gamma"), { cookie: DESK_COOKIE });
  assert.equal(created.status, 201);
  const { id } = (JSON.parse(created.body) as { data: { id: string } }).data;

  const published = await put(`/api/authoring/articles/${id}`, articleBody("Desk Withdraw Gamma", true), { cookie: DESK_COOKIE });
  assert.equal((JSON.parse(published.body) as { data: { status: string } }).data.status, "published");

  // The desk's 撤销发布 is the same PUT with `publish: false`; nothing new was
  // added to the contract, so this is the desk proving the seam carries the
  // intent rather than the framework.
  const withdrawn = await put(`/api/authoring/articles/${id}`, articleBody("Desk Withdraw Gamma", false), { cookie: DESK_COOKIE });
  assert.equal(withdrawn.status, 200);
  const article = (JSON.parse(withdrawn.body) as { data: { id: string; status: string; publishedAt: string | null } }).data;
  assert.equal(article.id, id, "withdrawing must address the same work, not create another");
  assert.equal(article.status, "draft");
  assert.equal(article.publishedAt, null, "a withdrawn work has no publication date");

  // Withdrawn, not lost: it is still the author's own work.
  const list = await get("/api/authoring/articles", { cookie: DESK_COOKIE });
  assert.match(list.body, /Desk Withdraw Gamma/);
});

test("a work can be deleted, and it leaves the author's list", async () => {
  const created = await post("/api/authoring/articles", articleBody("Desk Delete Delta"), { cookie: DESK_COOKIE });
  assert.equal(created.status, 201);
  const { id } = (JSON.parse(created.body) as { data: { id: string } }).data;

  const published = await put(`/api/authoring/articles/${id}`, articleBody("Desk Delete Delta", true), { cookie: DESK_COOKIE });
  assert.equal((JSON.parse(published.body) as { data: { status: string } }).data.status, "published");

  const deleted = await del(`/api/authoring/articles/${id}`, { cookie: DESK_COOKIE });
  assert.equal(deleted.status, 200);
  assert.match(deleted.body, /deletedAt/);

  // Deleted, not hidden: the desk's own list is the author's only view of it.
  const list = await get("/api/authoring/articles", { cookie: DESK_COOKIE });
  assert.doesNotMatch(list.body, /Desk Delete Delta/);

  // The desk's delete is origin-checked and authenticated like every other write.
  const cross = await del(`/api/authoring/articles/${id}`, { cookie: DESK_COOKIE, origin: "https://attacker.example" });
  assert.equal(cross.status, 403);
  assert.match(cross.body, /ORIGIN_REJECTED/);
  const anonymous = await del(`/api/authoring/articles/${id}`);
  assert.equal(anonymous.status, 401);
});

test("a deleted work can be restored from the recycle bin, as a draft", async () => {
  const created = await post("/api/authoring/articles", articleBody("Desk Restore Epsilon"), { cookie: DESK_COOKIE });
  assert.equal(created.status, 201);
  const { id, slug } = (JSON.parse(created.body) as { data: { id: string; slug: string } }).data;

  const published = await put(`/api/authoring/articles/${id}`, articleBody("Desk Restore Epsilon", true), { cookie: DESK_COOKIE });
  assert.equal((JSON.parse(published.body) as { data: { status: string } }).data.status, "published");

  // A reader's words, written before the deletion. The sweep will remove them
  // with the work, so the recycle bin counts them rather than staying silent.
  const comment = await post(`/api/articles/${slug}/comments`, JSON.stringify({ body: "值得一读" }), {
    cookie: `nw_access=${MOCK_TOKENS.accessToken}`,
  });
  assert.equal(comment.status, 201);
  await del(`/api/authoring/articles/${id}`, { cookie: DESK_COOKIE });

  // The recycle bin is where the work went: the author's to find, carrying both
  // the moment it was deleted and the moment the sweep will make that permanent.
  const trash = await get("/api/authoring/deleted-articles", { cookie: DESK_COOKIE });
  assert.equal(trash.status, 200);
  const trashed = (JSON.parse(trash.body) as { data: Array<{ id: string; deletedAt: string; purgesAt: string; commentCount: number }> }).data;
  const entry = trashed.find((item) => item.id === id);
  assert.ok(entry, "a deleted work is in the recycle bin, not nowhere");
  assert.ok(entry.deletedAt);
  assert.equal(entry.commentCount, 1, "the sweep takes the comments with it, so the row must say how many");
  assert.ok(new Date(entry.purgesAt).getTime() > new Date(entry.deletedAt).getTime(), "the expiry follows the deletion");

  const restored = await postEmpty(`/api/authoring/articles/${id}/restore`, { cookie: DESK_COOKIE });
  assert.equal(restored.status, 200);
  const restoredData = (JSON.parse(restored.body) as { data: { id: string; status: string; slug: string } }).data;
  assert.equal(restoredData.id, id);
  // A restore must not republish: deleting withdrew the work, and putting it
  // back is the author's decision to make again.
  assert.equal(restoredData.status, "draft");
  assert.equal(restoredData.slug, slug, "the address the deletion released comes back with it");

  const list = await get("/api/authoring/articles", { cookie: DESK_COOKIE });
  assert.match(list.body, /Desk Restore Epsilon/);
  const afterTrash = await get("/api/authoring/deleted-articles", { cookie: DESK_COOKIE });
  assert.doesNotMatch(afterTrash.body, new RegExp(id));

  // A work that is not a tombstone cannot be restored, and the recycle bin and
  // the restore are as authenticated and origin-checked as every desk write.
  const again = await postEmpty(`/api/authoring/articles/${id}/restore`, { cookie: DESK_COOKIE });
  assert.equal(again.status, 404);
  const anonymousRestore = await postEmpty(`/api/authoring/articles/${id}/restore`);
  assert.equal(anonymousRestore.status, 401);
  const cross = await postEmpty(`/api/authoring/articles/${id}/restore`, { cookie: DESK_COOKIE, origin: "https://attacker.example" });
  assert.equal(cross.status, 403);
  assert.match(cross.body, /ORIGIN_REJECTED/);
  const anonymousTrash = await get("/api/authoring/deleted-articles");
  assert.equal(anonymousTrash.status, 401);
});

test("the desk's writes are origin-checked, and the origin check comes first", async () => {
  const cross = await post("/api/authoring/articles", articleBody("Cross Origin"), {
    cookie: DESK_COOKIE,
    origin: "https://attacker.example",
  });
  assert.equal(cross.status, 403);
  assert.match(cross.body, /ORIGIN_REJECTED/);

  const malformed = await put("/api/authoring/articles/not-a-uuid", "{}", { cookie: DESK_COOKIE });
  assert.equal(malformed.status, 400);
  assert.match(malformed.body, /BAD_USER_INPUT/);

  // Order: a cross-origin request must be refused for its origin, so it cannot
  // use the status code to learn whether the id it guessed exists.
  const both = await put("/api/authoring/articles/not-a-uuid", "{}", {
    cookie: DESK_COOKIE,
    origin: "https://attacker.example",
  });
  assert.equal(both.status, 403);
});
