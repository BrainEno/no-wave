import assert from "node:assert/strict";
import test from "node:test";
import { lexicalEditorStateToArticleDocument } from "./lexical-document-adapter.ts";
// Intentional test-only cross-package import: validate the actual Web block
// serializer (`@bot-thk/web-ui`) against the API contract.
import { articleBlocksToLexicalEditorState } from "../../../../packages/web-ui/src/lib/lexical-article-state.ts";

test("Web-generated Lexical state round-trips through the real API content adapter", () => {
  const blocks: unknown[] = [
    { id: "p1", type: "paragraph", text: "hello bold", inlines: [{ text: "hello " }, { text: "bold", marks: ["bold"] }] },
    { id: "h1", type: "heading", level: 3, text: "heading" },
    { id: "q1", type: "quote", text: "quote" },
    { id: "l1", type: "list", ordered: false, items: ["first", "second"] },
    { id: "c1", type: "code", language: "text", code: "const answer = 42;" },
    { id: "image1", type: "image", src: "/api/media/11111111-1111-4111-8111-111111111111", alt: "cover", caption: "A caption" },
  ];
  const editorState = articleBlocksToLexicalEditorState(blocks);
  const converted = lexicalEditorStateToArticleDocument(editorState, { previousBlocks: blocks });
  assert.deepEqual(converted.contentBlocks, blocks);
  assert.equal(converted.contentBlocksVersion, 1);
});

/**
 * Every mark, in both directions (#240).
 *
 * The original test round-tripped one bold word, which is why the Web editor
 * could ship with underline and strikethrough swapped for as long as it did: the
 * one mark that was asserted is the one mark both tables agreed on. The runs
 * below cover each mark alone and two combinations, so a mismatch in either table
 * changes the result.
 */
test("Web-generated inline marks survive the API adapter for every mark", () => {
  const blocks: unknown[] = [{
    id: "p1",
    type: "paragraph",
    text: "加粗斜体下划线删除线代码",
    inlines: [
      { text: "加粗", marks: ["bold"] },
      { text: "斜体", marks: ["italic"] },
      { text: "下划线", marks: ["underline"] },
      { text: "删除线", marks: ["strikethrough"] },
      { text: "代码", marks: ["code"] },
    ],
  }, {
    id: "p2",
    type: "paragraph",
    text: "组合",
    inlines: [{ text: "组合", marks: ["bold", "italic", "underline", "strikethrough", "code"] }],
  }];
  const converted = lexicalEditorStateToArticleDocument(articleBlocksToLexicalEditorState(blocks), { previousBlocks: blocks });
  // Marks are compared as sets per run: the adapter emits them in its own order,
  // and the question here is which marks survived, not what order they are in.
  const runs = (index: number): Array<{ text: string; marks: string[] }> => {
    const block = converted.contentBlocks[index] as { inlines?: Array<{ text: string; marks?: string[] }> };
    return (block.inlines ?? []).map((run) => ({ text: run.text, marks: [...(run.marks ?? [])].sort() }));
  };
  assert.deepEqual(runs(0), [
    { text: "加粗", marks: ["bold"] },
    { text: "斜体", marks: ["italic"] },
    { text: "下划线", marks: ["underline"] },
    { text: "删除线", marks: ["strikethrough"] },
    { text: "代码", marks: ["code"] },
  ], "a mark must not become a different mark on the way through");
  assert.deepEqual(runs(1), [{ text: "组合", marks: ["bold", "code", "italic", "strikethrough", "underline"] }]);
});

