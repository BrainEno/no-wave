import assert from "node:assert/strict";
import test from "node:test";
import { lexicalEditorStateToArticleDocument } from "../../../api/src/domain/lexical-document-adapter.ts";
import { articleBlocksToLexicalEditorState } from "./lexical-article-state.ts";

test("Lexical-shaped output round-trips article blocks with links, marks, headings, lists and code", () => {
  const blocks = [
    { id: "paragraph-1", type: "paragraph", text: "你好 Lexical", inlines: [
      { text: "你好 " },
      { text: "Lexical", marks: ["bold", "italic"], href: "https://example.test/read" },
    ] },
    { id: "heading-1", type: "heading", level: 2, text: "标题" },
    { id: "quote-1", type: "quote", text: "引用" },
    { id: "list-1", type: "list", ordered: true, items: ["第一项", "第二项"] },
    { id: "code-1", type: "code", language: "text", code: "const wave = true;" },
  ];
  const editorState = articleBlocksToLexicalEditorState(blocks);
  assert.equal(editorState.root.type, "root");
  assert.equal(editorState.root.children.length, blocks.length);
  const result = lexicalEditorStateToArticleDocument(editorState, { previousBlocks: blocks });
  assert.deepEqual(result.contentBlocks, blocks);
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
