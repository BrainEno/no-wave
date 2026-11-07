import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

/**
 * Regression for #198 (关注流): the read side of following.
 *
 * The three states that must not collapse are signed-out, empty, and failed.
 * They render as lists of the same shape and mean completely different things:
 * "your session ended", "nobody you follow has published", and "this broke".
 * A reader who is told the wrong one acts on it — signing in again when nothing
 * was wrong, or concluding their feed is dead when they simply follow nobody.
 */

const viewPath = new URL("../components/public/feed-view.tsx", import.meta.url);
const routePath = new URL("../../../../apps/web-rr/app/routes/feed.tsx", import.meta.url);
const tablePath = new URL("../../../../apps/web-rr/app/routes.ts", import.meta.url);
const resourcePath = new URL("../../../../apps/web-rr/app/routes/api.feed.ts", import.meta.url);

test("a 401 is a sign-in prompt, an empty page is a different message", async () => {
  const source = await readFile(viewPath, "utf8");
  assert.match(source, /kind: "failed"/);
  assert.match(source, /state\.items\.length === 0/, "the empty case is its own branch");

  // The assertions below look *inside* the 401 branch. A file-wide search for
  // `kind: "signed-out"` passes even when the branch sets an empty ready list
  // instead — that substitution is the exact failure this test exists for, and
  // it is invisible unless the branch body itself is inspected.
  const start = source.indexOf("if (response.status === 401)");
  assert.ok(start > 0, "401 must be handled explicitly");
  const end = source.indexOf("return;", start);
  assert.ok(end > start, "the 401 branch must return");
  const branch = source.slice(start, end);
  assert.match(branch, /kind: "signed-out"/, "a 401 shows the sign-in prompt");
  assert.ok(!/items: \[\]/.test(branch), "a 401 must never become an empty list");

  // And it must return before the body is read, so an error payload is never
  // parsed as a page of articles.
  const readBody = source.indexOf("await response.json()");
  assert.ok(readBody > end, "a 401 never reaches the list parsing");
});

test("a failure is not presented as an empty feed", async () => {
  const source = await readFile(viewPath, "utf8");
  // `!response.ok` and a malformed payload both go to `failed`, not to an empty
  // list: a broken read claiming "nothing new" is a lie about the reader's graph.
  assert.match(source, /if \(!response\.ok\) \{\s*\n\s*setState\(\{ kind: "failed" \}\)/);
  assert.match(source, /if \(page === null\) \{\s*\n\s*setState\(\{ kind: "failed" \}\)/);
  assert.match(source, /catch \{\s*\n\s*if \(mine === generation\.current\) setState\(\{ kind: "failed" \}\)/);
});

test("the shell requires a session, decided by the marker not the token", async () => {
  const route = await readFile(routePath, "utf8");
  // The access token is HttpOnly and scoped below `/`: a loader cannot read it.
  // The marker carries no credential and only answers "is this still renewable".
  assert.match(route, /hasUsableSession\(sessionMarkerFrom\(request\)\)/);
  assert.ok(!/ACCESS_TOKEN_COOKIE/.test(route), "the loader must not reach for the token");
  assert.match(route, /redirect\(`\/sign-in\?next=/);
  assert.match(route, /PRIVATE_PAGE_HEADERS/);
});

test("the feed page is never cached or indexed", async () => {
  const route = await readFile(routePath, "utf8");
  // Every signed-in reader gets the same shell; `no-store` is what stops a
  // shared cache handing one reader another reader's page.
  assert.match(route, /export const headers: HeadersFunction = \(\) => PRIVATE_PAGE_HEADERS/);
  assert.match(route, /noindex, nofollow/);
});

test("the list is fetched by the browser, not rendered into the shell", async () => {
  const source = await readFile(viewPath, "utf8");
  assert.match(source, /fetch\(`\/api\/authoring\/feed/);
  assert.match(source, /credentials: "same-origin"/, "the cookie is the identity");
  assert.ok(!/useLoaderData/.test(source), "the list must not arrive pre-rendered");
});

test("a late response cannot overwrite a newer one", async () => {
  const source = await readFile(viewPath, "utf8");
  // Two loads can overlap (retry while the first is in flight); the older answer
  // must not win, or the list flickers back to a state the reader replaced.
  assert.match(source, /generation\.current/);
  assert.match(source, /if \(mine !== generation\.current\) return;/);
});

test("paging asks for the next window and appends it", async () => {
  const source = await readFile(viewPath, "utf8");
  assert.match(source, /load\(offset \+ PAGE_SIZE, true\)/);
  assert.match(source, /previous\.items, \.\.\.page/, "the page is appended, not replaced");
  assert.match(source, /more: page\.length === PAGE_SIZE/, "a short page is the end");
});

test("the feed route and the feed page are both wired", async () => {
  const table = await readFile(tablePath, "utf8");
  assert.match(table, /route\("api\/feed", "routes\/api\.feed\.ts"\)/);
  assert.match(table, /route\("feed", "routes\/feed\.tsx"\)/);
  assert.match(table, /route\("en\/feed", "routes\/feed\.tsx", \{ id: "en-feed" \}\)/);
});

test("the UI language covers 关注流 in both locales", async () => {
  const copy = await readFile(new URL("./ui-copy.ts", import.meta.url), "utf8");
  for (const key of ["eyebrow:", "title:", "intro:", "empty:", "emptyHint:", "signIn:", "failed:", "loading:", "retry:"]) {
    // Each key appears in zh and en; `count:` and `end:`/`more:` likewise.
    const occurrences = copy.split(key).length - 1;
    assert.ok(occurrences >= 2, `${key} needs a zh and an en form, saw ${occurrences}`);
  }
});

test("a wrong verb gets the application's error shape, not the router's", async () => {
  const route = await readFile(resourcePath, "utf8");
  // A route with only a `loader` answers a POST with React Router's own 405 and
  // its own body (`{"message":"Unexpected Server Error"}`). The status is right
  // and the shape is wrong, which is worse than it sounds: a client that parses
  // `{error:{code}}` everywhere meets something else on this one endpoint.
  assert.match(route, /export async function action/);
  // The handler takes React Router's normalized `url` alongside the request
  // (v8's request pass-through), so both exports pass it the same way.
  const loaderAndAction = route.match(/return feed\(request, url\)/g) ?? [];
  assert.ok(loaderAndAction.length >= 2, "loader and action must share one handler");
  assert.match(route, /errorResponse|METHOD_NOT_ALLOWED|handleFeedRequest/, "the handler owns the 405");
});
