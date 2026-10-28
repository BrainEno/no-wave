import assert from "node:assert/strict";
import test from "node:test";
import { articleBlocksToLexicalEditorState } from "./lexical-article-state.ts";

test("application article blocks become a Lexical EditorState with formatting, links, lists and code", () => {
  const blocks: unknown[] = [
    { id: "paragraph-1", type: "paragraph", text: "你好 Lexical", inlines: [
      { text: "你好 " },
      { text: "Lexical", marks: ["bold", "italic"], href: "https://example.test/read" },
    ] },
    { id: "heading-1", type: "heading", level: 2, text: "标题" },
    { id: "quote-1", type: "quote", text: "引用" },
    { id: "list-1", type: "list", ordered: true, items: ["第一项", "第二项"] },
    { id: "code-1", type: "code", language: "text", code: "const wave = true;" },
  ];
  const state = articleBlocksToLexicalEditorState(blocks);
  assert.equal(state.root.type, "root");
  assert.equal(state.root.children.length, blocks.length);
  assert.equal(state.root.children[0].type, "paragraph");
  const paragraph = state.root.children[0];
  const paragraphChildren = paragraph.children as Record<string, unknown>[];
  assert.equal(paragraphChildren[0].type, "text");
  assert.equal(paragraphChildren[1].type, "link");
  const link = paragraphChildren[1] as Record<string, unknown>;
  assert.equal(link.url, "https://example.test/read");
  const linkChildren = link.children as Record<string, unknown>[];
  assert.equal(linkChildren[0].format, 3);
  assert.equal(state.root.children[1].tag, "h2");
  assert.equal(state.root.children[3].listType, "number");
  assert.equal(state.root.children[4].type, "code");
});

test("the editor refuses unsupported media blocks instead of silently deleting them", () => {
  assert.throws(
    () => articleBlocksToLexicalEditorState([{ id: "image-1", type: "image", src: "/image.png", alt: "cover" }]),
    /media-upload workflow/,
  );
});

test("the editor refuses inconsistent inline text instead of silently dropping content", () => {
  assert.throws(
    () => articleBlocksToLexicalEditorState([{ id: "text-1", type: "paragraph", text: "expected", inlines: [{ text: "different" }] }]),
    /do not match/,
  );
});
