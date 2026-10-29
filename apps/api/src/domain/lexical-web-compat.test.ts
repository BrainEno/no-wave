import assert from "node:assert/strict";
import test from "node:test";
import { lexicalEditorStateToArticleDocument } from "./lexical-document-adapter.ts";
// Intentional test-only cross-app import: validate the actual Web block serializer against the API contract.
import { articleBlocksToLexicalEditorState } from "../../../web/src/lib/lexical-article-state.ts";

test("Web-generated Lexical state round-trips through the real API content adapter", () => {
  const blocks: unknown[] = [
    { id: "p1", type: "paragraph", text: "hello bold", inlines: [{ text: "hello " }, { text: "bold", marks: ["bold"] }] },
    { id: "h1", type: "heading", level: 3, text: "heading" },
    { id: "q1", type: "quote", text: "quote" },
    { id: "l1", type: "list", ordered: false, items: ["first", "second"] },
    { id: "c1", type: "code", language: "text", code: "const answer = 42;" },
  ];
  const editorState = articleBlocksToLexicalEditorState(blocks);
  const converted = lexicalEditorStateToArticleDocument(editorState, { previousBlocks: blocks });
  assert.deepEqual(converted.contentBlocks, blocks);
  assert.equal(converted.contentBlocksVersion, 1);
});
