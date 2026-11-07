import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

import {
  canEditComment,
  commentCopy,
  commentEditBody,
  commentEditPath,
  editedMarker,
} from "./comment-edit.ts";

/**
 * Comment editing (ADR 0031): the rules the section renders, held apart from it.
 *
 * Two of these are the whole point of the feature and one is its safety net.
 * The point: a reader is told when text changed, and the author's own words can
 * be corrected in place. The net: the browser offering an edit is not the same as
 * being allowed to edit — the API is the authority, and this helper must never
 * claim otherwise for anyone but the comment's own author.
 */

test("only the comment's own author is offered an edit", () => {
  const mine = { authorId: "reader-1" };
  assert.equal(canEditComment("reader-1", mine), true);
  assert.equal(canEditComment("reader-2", mine), false, "another member's comment is not editable");
  assert.equal(canEditComment(null, mine), false, "an anonymous visitor is not editable");
  assert.equal(canEditComment(undefined, mine), false);
  assert.equal(canEditComment("", mine), false, "an empty id is not an identity");
  assert.equal(canEditComment("reader-1", {}), false);
  assert.equal(canEditComment("reader-1", { authorId: null }), false);
  // The API never returns a comment without an author, but an older payload
  // must degrade to "no button" rather than to "everyone may edit".
  assert.equal(canEditComment("reader-1", { authorId: "" }), false);
});

test("the edited marker appears only after an edit, and in the reader's language", () => {
  assert.equal(editedMarker("zh-CN", { editedAt: null }), null);
  assert.equal(editedMarker("zh-CN", {}), null, "a legacy comment has no editedAt at all");
  assert.equal(editedMarker("zh-CN", { editedAt: "" }), null, "an empty timestamp is not a timestamp");
  assert.equal(editedMarker("zh-CN", { editedAt: "2026-11-08T09:30:00.000Z" }), "已编辑");
  assert.equal(editedMarker("en", { editedAt: "2026-11-08T09:30:00.000Z" }), "edited");
});

test("an edit addresses one comment by id, in the edition being read", () => {
  const id = "3f2b6c2e-0d1a-4c3a-9a6f-1c1f0b7d2e44";
  assert.equal(commentEditPath(id, "zh-CN"), `/api/comments/${id}?locale=zh-CN`);
  assert.equal(
    commentEditPath(id, "en"),
    `/api/comments/${id}?locale=en`,
    "the locale decides which edition of the author's name and date comes back",
  );
  assert.equal(
    commentEditPath("a b/c", "zh-CN"),
    "/api/comments/a%20b%2Fc?locale=zh-CN",
    "an id is data, not a path segment",
  );
});

test("an edit sends the versioned document the composer already produces", () => {
  const editorState = { root: { children: [] } };
  assert.deepEqual(commentEditBody(editorState), { editorState, contentBlocksVersion: 1 });
  assert.equal("parentCommentId" in commentEditBody(editorState), false, "an edit cannot re-parent a reply");
});

test("the comment section is fully bilingual", () => {
  for (const locale of ["zh-CN", "en"] as const) {
    const copy = commentCopy(locale);
    for (const [key, value] of Object.entries(copy)) {
      assert.equal(typeof value, "string", `${locale}.${key} must be copy, not a placeholder`);
      assert.ok(value.length > 0, `${locale}.${key} must not be empty`);
    }
  }
  assert.notEqual(commentCopy("zh-CN").edit, commentCopy("en").edit);
  assert.notEqual(commentCopy("zh-CN").save, commentCopy("en").save);
});

/**
 * The wiring, asserted at the source level.
 *
 * These are not interaction tests — there is no DOM here — they are checks that
 * fail on the specific ways the feature could go quiet: the marker computed but
 * never rendered, the edit sent to the anonymous slug-addressed thread route
 * instead of the id-addressed one, or the button offered without asking whether
 * the signed-in reader wrote the comment.
 */
const component = new URL("../components/comments/article-comments.tsx", import.meta.url);

test("the comment section renders the marker and edits through the id-addressed proxy", async () => {
  const source = await readFile(component, "utf8");
  assert.match(source, /editedMarker\(locale, comment\)/, "the edited marker must be computed from the comment");
  assert.match(source, /\{marker \?/, "the marker must be rendered, not only computed");
  assert.match(source, /fetch\(commentEditPath\(comment\.id, locale\)/, "an edit must address the comment by id");
  assert.match(source, /method: "PATCH"/, "an edit is a PATCH, not a second POST");
  assert.match(source, /commentEditBody\(editorState\)/, "the edit body must come from the shared helper");
  assert.match(source, /canEditComment\(viewerId, comment\)/, "the button must depend on who is reading");
  assert.match(
    source,
    /viewerId=\{viewerId\} onEdit=\{edit\}/,
    "replies are comments too: the edit props must reach them",
  );
});
