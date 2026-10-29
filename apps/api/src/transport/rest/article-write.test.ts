import assert from "node:assert/strict";
import test from "node:test";
import { normalizeArticleWriteBody } from "./bodies.ts";

/**
 * Article write bodies: what the transport accepts before the domain sees it.
 * The slug and the summary are both optional at this layer — creation derives
 * the slug from the title, and a blank summary is derived from the body — so
 * the contract is asserted here rather than inside a route handler.
 */
const editorState = (text: string, extra: Record<string, unknown> = {}) => ({
  root: {
    children: [
      {
        children: [{ detail: 0, format: 0, mode: "normal", style: "", text, type: "text", version: 1 }],
        direction: null,
        format: "",
        indent: 0,
        type: "paragraph",
        version: 1,
        ...extra,
      },
    ],
    direction: null,
    format: "",
    indent: 0,
    type: "root",
    version: 1,
  },
});

const createBody = (overrides: Record<string, unknown> = {}) => ({
  title: "无浪文学的第一篇文章",
  editorState: editorState("第一段正文。第二段正文。"),
  contentBlocksVersion: 1,
  ...overrides,
});

test("creation without a slug leaves the slug to be generated from the title", () => {
  const { input, error } = normalizeArticleWriteBody(createBody(), false);
  assert.equal(error, null);
  assert.equal(input === null, false);
  assert.equal(Object.hasOwn(input ?? {}, "slug"), false);
});

test("a supplied slug is kept (trimmed) so explicit addresses still work", () => {
  const { input } = normalizeArticleWriteBody(createBody({ slug: "  hand-written-slug  " }), false);
  assert.equal(input?.slug, "hand-written-slug");
  const { error } = normalizeArticleWriteBody(createBody({ slug: 42 }), false);
  assert.match(error ?? "", /slug must be a string/);
});

test("updates must name the slug of the article they address", () => {
  const { input, error } = normalizeArticleWriteBody(createBody({ publish: true }), true);
  assert.equal(input, null);
  assert.match(error ?? "", /slug must be supplied/);
  const updated = normalizeArticleWriteBody(createBody({ slug: "existing-slug", publish: true }), true);
  assert.equal(updated.input?.slug, "existing-slug");
});

test("an empty or whitespace summary is derived from the beginning of the body", () => {
  const blank = normalizeArticleWriteBody(createBody({ summary: "" }), false);
  assert.equal(blank.input?.summary, "第一段正文。第二段正文。");
  const whitespace = normalizeArticleWriteBody(createBody({ summary: "   " }), false);
  assert.equal(whitespace.input?.summary, "第一段正文。第二段正文。");
  const omitted = normalizeArticleWriteBody(createBody(), false);
  assert.equal(omitted.input?.summary, "第一段正文。第二段正文。");
});

test("a written summary is preserved verbatim", () => {
  const { input } = normalizeArticleWriteBody(createBody({ summary: "作者自己写的摘要。" }), false);
  assert.equal(input?.summary, "作者自己写的摘要。");
});

test("an element-level Lexical text format no longer fails the conversion", () => {
  const { input, error } = normalizeArticleWriteBody(
    createBody({ editorState: editorState("正文内容", { textFormat: 1, textStyle: "" }) }),
    false,
  );
  assert.equal(error, null);
  assert.equal(input === null, false);
});

test("an editor state without any text content reports empty content", () => {
  const { input, error } = normalizeArticleWriteBody(createBody({ editorState: editorState("") }), false);
  assert.equal(input, null);
  assert.match(error ?? "", /at least one block with text content/);
});
