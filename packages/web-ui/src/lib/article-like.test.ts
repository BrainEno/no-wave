import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

/**
 * Regression for #198: the reading page had **no interaction at all**, so
 * `GET`/`PUT /api/v1/articles/:slug/like` — which the API has served for a long
 * time — was reachable only by clients that already knew it existed.
 *
 * These are source assertions rather than interaction tests because there is no
 * DOM here. They are written to fail on the specific ways this could regress
 * silently, not to describe the file.
 */

const likePath = new URL("../components/public/article-like.tsx", import.meta.url);
const viewPath = new URL("../components/public/article-view.tsx", import.meta.url);

test("the reading page renders a like control", async () => {
  const view = await readFile(viewPath, "utf8");
  assert.match(view, /ArticleLike/, "ArticlePageView must render the control");
  // Placed after the body and before the comments: the one moment the reader
  // still knows what they just finished.
  const bodyEnd = view.indexOf("nw-end");
  const like = view.indexOf("<ArticleLike");
  const comments = view.indexOf("<ArticleComments");
  assert.ok(bodyEnd > 0 && like > bodyEnd, "the control follows the end of the work");
  assert.ok(comments > like, "and precedes the comment thread");
});

test("the control is optimistic and rolls back on failure", async () => {
  const source = await readFile(likePath, "utf8");

  // Optimistic: state is set *before* the request, from the pre-request value.
  assert.match(source, /setState\(optimistic\)/, "the press must show before the round trip");
  const optimistic = source.indexOf("setState(optimistic)");
  const request = source.indexOf("await fetch(");
  assert.ok(optimistic > 0 && optimistic < request, "optimism has to come first, or it is not optimism");

  // Rollback: the captured `current` is restored in the failure path.
  assert.match(source, /setState\(current\)/, "a failed write must revert what it changed");
  // And it must revert *both* halves — a count that moves without the label (or
  // the reverse) is the bug this is guarding.
  assert.match(source, /const optimistic: LikeState = \{[\s\S]*likedByViewer[\s\S]*likeCount/, "the guess covers both fields");
});

test("signed out is a sign-in prompt, not an error", async () => {
  const source = await readFile(likePath, "utf8");
  assert.match(source, /response\.status === 401/, "401 must be handled explicitly");
  assert.match(source, /setNeedsSignIn\(true\)/, "and turn into a prompt");
  assert.match(source, /\/sign-in\?next=/, "with somewhere to go");
  // It must not fall through into the red error path.
  const signIn = source.indexOf("setNeedsSignIn(true)");
  const nextReturn = source.indexOf("return;", signIn);
  assert.ok(nextReturn > signIn, "the 401 branch must return before the generic error handling");
});

test("a second click while a write is in flight is dropped", async () => {
  const source = await readFile(likePath, "utf8");
  // Two concurrent toggles could send "save" and "unsave", and the slower answer
  // would win — leaving the server in a state the reader never asked for.
  assert.match(source, /if \(pending\) return;/, "the toggle must refuse to overlap itself");
  assert.match(source, /disabled=\{[^}]*pending/, "and the button must say so");
});

test("the server's numbers win over the optimistic guess", async () => {
  const source = await readFile(likePath, "utf8");
  // Another reader may have saved the work during the round trip, so the
  // response body replaces the local guess rather than being ignored.
  assert.match(source, /setState\(data\)/, "a valid response adopts the server's state");
  assert.doesNotMatch(source, /setState\(data \?\? optimistic\)/, "an invalid response must not become a confirmed guess");
  assert.match(source, /readState/, "and the payload is read defensively, not cast");
});

test("both directions of the toggle send an explicit boolean", async () => {
  const source = await readFile(likePath, "utf8");
  // The API classifies this as state-setting, not a toggle: a retry must be able
  // to say "save" twice without flipping.
  assert.match(source, /const nextLiked = !current\.likedByViewer/);
  assert.match(source, /body: JSON\.stringify\(\{ liked: nextLiked \}\)/);
});

test("the UI language covers 收藏 in both locales", async () => {
  const copy = await readFile(new URL("./ui-copy.ts", import.meta.url), "utf8");
  for (const key of ["save:", "savedState:", "saveCount:", "saveNone:", "saveSignIn:", "saveFailed:", "saveLoading:"]) {
    const occurrences = copy.split(key).length - 1;
    assert.ok(occurrences >= 2, `${key} needs a zh and an en form, saw ${occurrences}`);
  }
});
