import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

import {
  canEditComment,
  commentCopy,
  commentCreatePath,
  commentDocumentToSubmit,
  commentDraftDocument,
  commentEditBody,
  commentEditPath,
  commentSurfaceDraft,
  editedMarker,
  COMMENT_SURFACE_CONTENT_IS_REACT_MANAGED,
} from "./comment-edit.ts";
import type { LexicalEditorStateJson } from "./lexical-article-state.ts";

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
  assert.equal(commentEditPath(id, "zh-CN"), `/api/authoring/comments/${id}?locale=zh-CN`);
  assert.equal(
    commentEditPath(id, "en"),
    `/api/authoring/comments/${id}?locale=en`,
    "the locale decides which edition of the author's name and date comes back",
  );
  assert.equal(
    commentEditPath("a b/c", "zh-CN"),
    "/api/authoring/comments/a%20b%2Fc?locale=zh-CN",
    "an id is data, not a path segment",
  );
});

/**
 * #242: both writes live where the credential lives.
 *
 * `nw_access` is scoped to `/api/authoring` (ADR 0025), so a form that posted to
 * `/api/articles/:slug/comments` arrived anonymous, took a 401 and forced a
 * refresh-token rotation before the retry could work. The read stays on the
 * public path — that is the half that must not need a credential — while every
 * write carries the prefix. This is a source-level assertion because the cookie
 * path is enforced by the browser, not by any code the test can call.
 */
test("comment writes are addressed under /api/authoring, and the reader is not", () => {
  const id = "3f2b6c2e-0d1a-4c3a-9a6f-1c1f0b7d2e44";
  for (const path of [commentCreatePath("a-story", "zh-CN"), commentEditPath(id, "zh-CN")]) {
    assert.ok(path.startsWith("/api/authoring/"), `${path} must be under the authoring prefix`);
  }
  assert.equal(commentCreatePath("a-story", "zh-CN"), "/api/authoring/articles/a-story/comments?locale=zh-CN");
  assert.equal(
    commentCreatePath("a b/c", "zh-CN"),
    "/api/authoring/articles/a%20b%2Fc/comments?locale=zh-CN",
    "a slug is data, not a path segment",
  );
});

test("an edit sends the versioned document the composer already produces", () => {
  const editorState = { root: { children: [] } };
  assert.deepEqual(commentEditBody(editorState), { editorState, contentBlocksVersion: 1 });
  assert.equal("parentCommentId" in commentEditBody(editorState), false, "an edit cannot re-parent a reply");
});

/**
 * The document a comment submits.
 *
 * The composer mirrors the editor's document in React, but the mirror can lag
 * behind the box: an update that lands before the composer subscribes is never
 * reported, and the reader's text sits in the editor with the mirror still
 * holding the empty document it started with. A comment was then refused for
 * text that was plainly on the screen. The editor is the source of truth when
 * the reader presses submit.
 */
test("a comment is submitted from the editor's live document, not from the last one React heard", () => {
  const live: LexicalEditorStateJson = {
    root: { children: [{ type: "paragraph", children: [{ type: "text", text: "读者写下的回应" }] }] },
  };
  const stale: LexicalEditorStateJson = { root: { children: [{ type: "paragraph", children: [] }] } };
  const editor = {
    read: <T,>(callback: () => T): T => callback(),
    getEditorState: () => ({ toJSON: () => live }),
  };
  assert.deepEqual(
    commentDocumentToSubmit(editor, stale),
    live,
    "the text in the box is the comment, even when the mirror is behind it",
  );
  assert.deepEqual(
    commentDocumentToSubmit(null, stale),
    stale,
    "without an editor there is only the document the composer started with",
  );
});

test("the comment section is fully bilingual", () => {
  for (const locale of ["zh-CN", "en"] as const) {
    const copy = commentCopy(locale);
    for (const [key, value] of Object.entries(copy)) {
      if (typeof value === "string") {
        assert.ok(value.length > 0, `${locale}.${key} must not be empty`);
        continue;
      }
      for (const [name, label] of Object.entries(value)) {
        assert.equal(typeof label, "string", `${locale}.${key}.${name} must be copy, not a placeholder`);
        assert.ok(label.length > 0, `${locale}.${key}.${name} must not be empty`);
      }
    }
  }
  assert.notEqual(commentCopy("zh-CN").edit, commentCopy("en").edit);
  assert.notEqual(commentCopy("zh-CN").save, commentCopy("en").save);
});

test("the formatting controls are named after the glyph that is visible on them", () => {
  // WCAG 2.5.3: the accessible name has to contain the text on the screen, so
  // a reader who says "B" out loud reaches the bold control.
  for (const [name, glyph] of [
    ["bold", "B"],
    ["italic", "I"],
    ["underline", "U"],
    ["strikethrough", "S"],
  ] as const) {
    assert.ok(
      commentCopy("zh-CN").format[name].endsWith(glyph),
      `${name} names its glyph`,
    );
    assert.ok(
      commentCopy("en").format[name].endsWith(glyph),
      `${name} names its glyph in English too`,
    );
  }
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
  assert.match(source, /fetch\(commentCreatePath\(slug, locale\)/, "a new comment must use the authoring-scoped path");
  assert.equal(
    source.includes('"/api/articles/" + encodeURIComponent(slug) + "/comments"'),
    false,
    "the anonymous read path must not be used for a write",
  );
  assert.match(source, /method: "PATCH"/, "an edit is a PATCH, not a second POST");
  assert.match(source, /commentEditBody\(editorState\)/, "the edit body must come from the shared helper");
  assert.match(source, /canEditComment\(viewerId, comment\)/, "the button must depend on who is reading");
  assert.match(
    source,
    /viewerId=\{viewerId\} onEdit=\{edit\}/,
    "replies are comments too: the edit props must reach them",
  );
});

test("the composer submits the editor's live document, and subscribes to the committed one", async () => {
  const source = await readFile(component, "utf8");
  assert.match(
    source,
    /commentDocumentToSubmit\(editorRef\.current, editorState\)/,
    "the submitted document must be read from the editor when the reader submits",
  );
  assert.match(
    source,
    /onChange\(editor\.getEditorState\(\)\.toJSON\(\)/,
    "the composer must publish the committed document when it subscribes",
  );
  assert.match(
    source,
    /editor\.registerUpdateListener\(/,
    "the composer must keep following the editor after it subscribes",
  );
});

/**
 * The comment surface.
 *
 * The comment section is server-rendered, so for a moment the reader is
 * looking at a box no editor has claimed. The server rendered it as an
 * editable box, so the browser let the reader type into it — and the text went
 * nowhere: React compares the surface with the markup it rendered, finds the
 * reader's text where it expected nothing, throws the page away and rebuilds
 * it. The surface's content is therefore not React's to manage, and the editor
 * adopts whatever the reader left there.
 */
test("the comment surface keeps the text the reader left in it", () => {
  assert.equal(
    COMMENT_SURFACE_CONTENT_IS_REACT_MANAGED,
    false,
    "the surface is server-rendered: React must not manage what is inside it",
  );
  assert.equal(commentSurfaceDraft(null), "", "no surface, no draft");
  assert.equal(commentSurfaceDraft({ textContent: "" }), "", "an untouched surface has no draft");
  assert.equal(
    commentSurfaceDraft({ textContent: "水合前写下的字" }),
    "水合前写下的字",
    "what the reader typed before the editor owned the surface is the draft",
  );
  assert.equal(commentSurfaceDraft({ textContent: null }), "");
});

test("the draft becomes the document the editor adopts", () => {
  const document = commentDraftDocument("水合前写下的字");
  assert.equal(document.root.children.length, 1);
  const paragraph = document.root.children[0];
  assert.equal(paragraph.type, "paragraph");
  const runs = paragraph.children as Record<string, unknown>[];
  assert.equal(runs.length, 1);
  assert.equal(runs[0].text, "水合前写下的字");

  // A line break the reader typed is a paragraph break, the way the editor
  // would have made it.
  const lines = commentDraftDocument("第一行\n第二行");
  assert.equal(lines.root.children.length, 2);
  const second = lines.root.children[1].children as Record<string, unknown>[];
  assert.equal(second[0].text, "第二行");
});

test("the composer leaves the surface's content to the reader and adopts the draft", async () => {
  const source = await readFile(component, "utf8");
  assert.match(
    source,
    /dangerouslySetInnerHTML=\{COMMENT_SURFACE_CONTENT_IS_REACT_MANAGED \? undefined : \{ __html: "" \}\}/,
    "React must not manage the content of a surface the reader can type into",
  );
  assert.match(
    source,
    /commentSurfaceDraft\(surface\)/,
    "the composer must read what the reader left in the surface",
  );
  assert.match(
    source,
    /editor\.setEditorState\(editor\.parseEditorState\(JSON\.stringify\(commentDraftDocument\(draft\)\)\)\)/,
    "the draft must become the editor's document before the editor draws the surface",
  );
  assert.match(
    source,
    /ref=\{adopt\}/,
    "the adoption must happen through the ref, which runs before the editor takes the element",
  );
});
