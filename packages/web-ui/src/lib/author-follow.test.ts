import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

/**
 * Regression for #198 (关注): the author page had no way to follow anybody.
 *
 * Source assertions rather than interaction tests, because there is no DOM here.
 * Each one is written to fail on a specific way this could look right and be
 * wrong — particularly the two facts that make following different from saving:
 * the server-rendered `isFollowing` is always false, and the API takes verbs
 * rather than a boolean.
 */

const followPath = new URL("../components/public/author-follow.tsx", import.meta.url);
const viewPath = new URL("../components/public/author-view.tsx", import.meta.url);
const routePath = new URL(
  "../../../../apps/web-rr/app/routes/api.users.$userId.follow.ts",
  import.meta.url,
);

test("the author page renders a follow control", async () => {
  const view = await readFile(viewPath, "utf8");
  assert.match(view, /AuthorFollow/, "AuthorPageView must render the control");
  // Under the name and above the bio: the profile header is where a reader
  // decides whether they want more of this writer.
  const h1 = view.indexOf("<h1");
  const follow = view.indexOf("<AuthorFollow");
  assert.ok(h1 > 0 && follow > h1, "the control follows the name");
});

test("the control does not trust the server-rendered isFollowing", async () => {
  const source = await readFile(followPath, "utf8");
  // `loadAuthorPage` calls the API with no cookie, so the HTML always carries
  // `isFollowing: false`. The button must fetch the real answer with the
  // browser's cookie before it is usable.
  assert.match(source, /\/api\/authoring\/authors\//, "the follow state is read within the viewer's access-cookie path");
  assert.match(source, /setLoading\(true\)/, "it starts in a loading state, not a guessed one");
  assert.match(source, /state === null/, "an unknown state disables the button");
  assert.match(source, /disabled = loading \|\| pending \|\| state === null/);
});

test("the write sends a verb, not a boolean", async () => {
  const source = await readFile(followPath, "utf8");
  // Following is a relationship at the API: POST creates it, DELETE removes it.
  // A `PUT {following}` here would be a second definition of the operation.
  assert.match(source, /method: nextFollowing \? "POST" : "DELETE"/);
  assert.ok(!/method:\s*"PUT"/.test(source), "the proxy speaks the API's verbs");
  // And the verb must be chosen explicitly from the state it wants, never from
  // "flip whatever I have" — a retry computed from a stale read unfollows.
  assert.match(source, /const nextFollowing = !current\.isFollowing/);
});

test("the control is optimistic and rolls back on failure", async () => {
  const source = await readFile(followPath, "utf8");
  assert.match(source, /setState\(optimistic\)/);
  const optimistic = source.indexOf("setState(optimistic)");
  const request = source.indexOf("await fetch(", source.indexOf("const toggle"));
  assert.ok(optimistic > 0 && optimistic < request, "the press shows before the round trip");
  assert.match(source, /setState\(current\)/, "a failed write reverts");
  assert.match(source, /Math\.max\(0,/, "the count can never go negative on a rollback");
});

test("signed out is a sign-in prompt, not an error", async () => {
  const source = await readFile(followPath, "utf8");
  assert.match(source, /response\.status === 401/);
  assert.match(source, /setNeedsSignIn\(true\)/);
  // The revert must happen too: the optimistic press was not real. Checked
  // inside the branch, not by searching the rest of the file — "setState(current)"
  // also appears in the generic failure path and in a comment, so a looser
  // assertion passes even when the 401 branch forgets to undo the press.
  const start = source.indexOf("if (response.status === 401)");
  const end = source.indexOf("return;", start);
  assert.ok(start > 0 && end > start, "the 401 branch must exist and return");
  const branch = source.slice(start, end);
  assert.match(branch, /setState\(current\)/, "a 401 undoes the optimistic press before prompting");
  assert.match(branch, /setNeedsSignIn\(true\)/);
  assert.match(source, /\/sign-in\?next=/, "with somewhere to go");
});

test("a second click while a write is in flight is dropped", async () => {
  const source = await readFile(followPath, "utf8");
  assert.match(source, /if \(!state \|\| pending\) return;/);
  // The button is disabled for the same reasons, so the second click is refused
  // before it can start rather than being dropped silently after the fact.
  assert.match(source, /const disabled = loading \|\| pending \|\| state === null/);
  assert.match(source, /disabled=\{disabled\}/);
});

test("the server's numbers win over the optimistic guess", async () => {
  const source = await readFile(followPath, "utf8");
  assert.match(source, /setState\(data\)/);
  assert.doesNotMatch(source, /setState\(data \?\? optimistic\)/);
  // Read defensively: a missing field must not become a confident `false`.
  assert.match(source, /typeof isFollowing !== "boolean"/);
});

test("the route exposes the two verbs and no read", async () => {
  const route = await readFile(routePath, "utf8");
  assert.match(route, /export async function action/);
  assert.match(route, /export async function loader/, "a loader exists so GET answers 405, not React Router's 400");
  assert.match(route, /handleUserFollowRequest/);
});

test("the UI language covers 关注 in both locales", async () => {
  const copy = await readFile(new URL("./ui-copy.ts", import.meta.url), "utf8");
  for (const key of ["follow:", "following:", "unfollow:", "followerCount:", "followerNone:", "followSignIn:", "followFailed:", "followLoading:"]) {
    const occurrences = copy.split(key).length - 1;
    assert.ok(occurrences >= 2, `${key} needs a zh and an en form, saw ${occurrences}`);
  }
});
