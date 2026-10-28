import assert from "node:assert/strict";
import test from "node:test";
import { normalizeCommentContentInput, validateStoredCommentContent } from "./comment-content.ts";

const text = (value, format = 0) => ({ detail: 0, format, mode: "normal", style: "", text: value, type: "text", version: 1 });
const para = (children) => ({ children, direction: null, format: "", indent: 0, type: "paragraph", version: 1 });
const state = (children) => ({ root: { children, direction: null, format: "", indent: 0, type: "root", version: 1 } });

test("legacy plain-text comments keep version 0 and trimmed content", () => {
  assert.deepEqual(normalizeCommentContentInput({ content: "  一条评论  " }), { content: "一条评论", contentBlocks: null, contentBlocksVersion: 0 });
  assert.deepEqual(validateStoredCommentContent({ content: " 一条评论 " }), { content: "一条评论", contentBlocks: null, contentBlocksVersion: 0 });
});

test("comment v1 supports multiple paragraphs, basic marks and safe links with matching fallback", () => {
  const lexical = state([
    para([text("中文 "), text("重点", 1)]),
    para([{ children: [text("链接")], direction: null, format: "", indent: 0, type: "link", url: "https://example.test/comment", rel: null, target: null, title: null, version: 1 }]),
  ]);
  const normalized = normalizeCommentContentInput({ editorState: lexical });
  assert.equal(normalized.content, "中文 重点\n链接");
  assert.equal(normalized.contentBlocksVersion, 1);
  assert.deepEqual(normalized.contentBlocks, [
    { id: "lexical-block-1", type: "paragraph", text: "中文 重点", inlines: [{ text: "中文 " }, { text: "重点", marks: ["bold"] }] },
    { id: "lexical-block-2", type: "paragraph", text: "链接", inlines: [{ text: "链接", href: "https://example.test/comment" }] },
  ]);
  assert.deepEqual(validateStoredCommentContent(normalized), normalized);
});

test("application-owned paragraph blocks may be supplied directly as v1", () => {
  const blocks = [{ id: "p1", type: "paragraph", text: "Text", inlines: [{ text: "Text", marks: ["italic"] }] }];
  assert.deepEqual(normalizeCommentContentInput({ contentBlocks: blocks }), { content: "Text", contentBlocks: blocks, contentBlocksVersion: 1 });
});

test("comments reject ambiguous sources, wrong versions and non-paragraph/unsafe Lexical nodes", () => {
  const cases = [
    { content: "text", contentBlocks: [{ id: "p", type: "paragraph", text: "text" }] },
    { content: "text", contentBlocksVersion: 1 },
    { contentBlocks: [{ id: "p", type: "paragraph", text: "text" }], contentBlocksVersion: 0 },
    { editorState: state([{ ...para([text("code")]), type: "code", language: "javascript", theme: "" }]) },
    { editorState: state([{ ...para([text("heading")]), type: "heading", tag: "h2" }]) },
    { editorState: state([{ children: [text("image")], direction: null, format: "", indent: 0, type: "image", version: 1, src: "/image.png" }]) },
    { editorState: state([para([{ children: [text("x")], direction: null, format: "", indent: 0, type: "link", url: "javascript:alert(1)", rel: null, target: null, title: null, version: 1 }])]) },
  ];
  for (const input of cases) assert.throws(() => normalizeCommentContentInput(input), { code: "BAD_USER_INPUT" });
});

test("rich fallback must match blocks exactly and limits are enforced", () => {
  const blocks = [{ id: "p1", type: "paragraph", text: "Rich", inlines: [{ text: "Rich" }] }];
  assert.throws(() => validateStoredCommentContent({ content: "Not rich", contentBlocks: blocks, contentBlocksVersion: 1 }), /fallback must exactly match/i);
  assert.throws(() => normalizeCommentContentInput({ content: " " }), { code: "BAD_USER_INPUT" });
  assert.throws(() => normalizeCommentContentInput({ content: "x".repeat(5001) }), { code: "BAD_USER_INPUT" });
  assert.throws(() => normalizeCommentContentInput({ contentBlocks: Array.from({ length: 21 }, (_, i) => ({ id: "p"+i, type: "paragraph", text: "x" })) }), { code: "BAD_USER_INPUT" });
});
