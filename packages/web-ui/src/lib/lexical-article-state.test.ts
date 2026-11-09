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

test("approved image blocks round-trip as the registered custom Lexical image node", () => {
  const state = articleBlocksToLexicalEditorState([{
    id: "image-1", type: "image", src: "/api/media/11111111-1111-4111-8111-111111111111",
    alt: "Cover", caption: "Cover caption",
  }]);
  assert.deepEqual(state.root.children[0], {
    type: "image", version: 1, src: "/api/media/11111111-1111-4111-8111-111111111111",
    alt: "Cover", caption: "Cover caption",
  });
  assert.throws(
    () => articleBlocksToLexicalEditorState([{ id: "image-2", type: "image", src: "javascript:alert(1)", alt: "unsafe" }]),
    /unsafe image URL/,
  );
});

test("the editor refuses inconsistent inline text instead of silently dropping content", () => {
  assert.throws(
    () => articleBlocksToLexicalEditorState([{ id: "text-1", type: "paragraph", text: "expected", inlines: [{ text: "different" }] }]),
    /do not match/,
  );
});

/**
 * The mark bitmask is a wire format (#240).
 *
 * A paragraph is turned into Lexical text nodes whose `format` is a bitmask, and
 * the API's adapter turns those numbers back into marks. When this table had
 * underline and strikethrough the other way round, every save from the editor
 * silently swapped the two — the text survived, the emphasis did not. The
 * numbers below are Lexical's own, and they are asserted one by one so a future
 * "tidy-up" of the table fails here instead of in somebody's article.
 */
test("text format bits are Lexical's IS_BOLD/IS_ITALIC/IS_STRIKETHROUGH/IS_UNDERLINE/IS_CODE", () => {
  const state = articleBlocksToLexicalEditorState([{
    id: "format-bits",
    type: "paragraph",
    text: "biusdcl",
    inlines: [
      { text: "b", marks: ["bold"] },
      { text: "i", marks: ["italic"] },
      { text: "u", marks: ["underline"] },
      { text: "s", marks: ["strikethrough"] },
      { text: "d", marks: ["bold", "italic"] },
      { text: "c", marks: ["code"] },
      { text: "l", marks: ["bold", "italic", "underline", "strikethrough", "code"] },
    ],
  }]);
  const runs = state.root.children[0].children as Record<string, unknown>[];
  assert.deepEqual(runs.map((run) => run.format), [1, 2, 8, 4, 3, 16, 31]);
  // Named, not just numbered: an underscore is 8 and a strike-through is 4 in
  // Lexical, and reading the list above without this line is how it was missed.
  assert.equal(runs[2]?.text, "u");
  assert.equal(runs[3]?.text, "s");
});

