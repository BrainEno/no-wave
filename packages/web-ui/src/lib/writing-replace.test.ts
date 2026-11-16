import assert from "node:assert/strict";
import test from "node:test";
import { articleBlocksToLexicalEditorState } from "./lexical-article-state.ts";
import { previewWritingReplacement, applyWritingReplacement, writingMatchAnchors } from "./writing-replace.ts";
import { inspectWriting } from "./writing-document.ts";
import type { WritingDraft } from "./writing-session.ts";

function draft(text = "海浪与海浪"): WritingDraft {
  return { title: "海", summary: "", locale: "zh-CN", workType: "poetry", editorState: articleBlocksToLexicalEditorState([{ type: "paragraph", text }]) };
}

function bodyText(value: WritingDraft): string { return inspectWriting(value).blocks.map(block => block.text).join("\n"); }

test("replacement is a literal, non-overlapping preview with explicit selection", () => {
  const source = draft("a.* a.* aaa");
  const plan = previewWritingReplacement(source, "a.*", "$&", true);
  assert.equal(plan.matches.length, 2);
  assert.equal(bodyText(applyWritingReplacement(source, plan, [1])), "a.* $& aaa");
  assert.equal(bodyText(source), "a.* a.* aaa", "the preview and application do not mutate their input");
  const overlap = previewWritingReplacement(draft("aaa"), "aa", "b", true);
  assert.equal(overlap.matches.length, 1);
});

test("matching across inline formats preserves outside text, marks, links, code and images", () => {
  const source = draft();
  source.editorState = articleBlocksToLexicalEditorState([
    { type: "paragraph", text: "前海浪后海浪", inlines: [
      { text: "前海", marks: ["bold"] }, { text: "浪后", marks: ["italic"], href: "https://example.test/海浪" }, { text: "海浪" },
    ] },
    { type: "code", language: "text", code: "海浪" },
    { type: "image", src: "/api/media/11111111-1111-4111-8111-111111111111", alt: "海浪" },
  ]);
  const plan = previewWritingReplacement(source, "海浪", "潮汐", true);
  assert.equal(plan.matches.length, 2, "code, image descriptions and hrefs are not editable search text");
  const next = applyWritingReplacement(source, plan, [0]);
  const nodes = next.editorState!.root.children[0]!.children as Record<string, unknown>[];
  assert.equal(nodes[0]!.text, "前潮汐");
  assert.equal(nodes[0]!.format, 1);
  const link = nodes[1]!;
  assert.equal(link.url, "https://example.test/海浪");
  assert.equal((link.children as Record<string, unknown>[])[0]!.text, "后");
  assert.equal((link.children as Record<string, unknown>[])[0]!.format, 2);
  assert.deepEqual(next.editorState!.root.children.slice(1), source.editorState.root.children.slice(1));
});

test("one batch edits multiple matches in the same run from right to left", () => {
  const source = draft("海浪 海浪 海浪");
  const plan = previewWritingReplacement(source, "海浪", "潮", true);
  assert.equal(bodyText(applyWritingReplacement(source, plan, [0, 2])), "潮 海浪 潮");
  assert.equal(bodyText(applyWritingReplacement(source, plan, [0, 1, 2])), "潮 潮 潮");
});

test("Unicode case-insensitive matching retains original UTF-16 offsets and literal whitespace", () => {
  const source = draft("🌊 Wave WAVE İ i  a  a");
  const plan = previewWritingReplacement(source, "wave", "潮", false);
  assert.equal(bodyText(applyWritingReplacement(source, plan, [0, 1])), "🌊 潮 潮 İ i  a  a");
  const spaces = previewWritingReplacement(source, "  ", " ", true);
  assert.equal(spaces.matches.length, 2);
  assert.equal(previewWritingReplacement(draft("🌊"), "\udf0a", "x", true).error !== null, true);
});

test("stale previews cannot alter later text, metadata or formatting; invalid selections fail closed", () => {
  const source = draft();
  const plan = previewWritingReplacement(source, "海浪", "潮", true);
  assert.throws(() => applyWritingReplacement({ ...source, title: "后来改名" }, plan, [0]), /预览已过期/);
  assert.throws(() => applyWritingReplacement(draft("海浪后来"), plan, [0]), /预览已过期/);
  const changed = structuredClone(source);
  (changed.editorState!.root.children[0]!.children as Record<string, unknown>[])[0]!.format = 1;
  assert.throws(() => applyWritingReplacement(changed, plan, [0]), /预览已过期/);
  for (const selected of [[], [0, 0], [-1], [999], [0.1]]) assert.throws(() => applyWritingReplacement(source, plan, selected), /选择/);
});

test("preview limits are explicit and unshown matches are never replaced", () => {
  const source = draft("浪".repeat(250));
  const plan = previewWritingReplacement(source, "浪", "潮", true);
  assert.equal(plan.matches.length, 200);
  assert.equal(plan.more, true);
  const next = applyWritingReplacement(source, plan, plan.matches.map(match => match.id));
  assert.equal(bodyText(next), "潮".repeat(200) + "浪".repeat(50));
  for (const [query, replacement] of [["", "x"], ["a".repeat(201), ""], ["a", "x".repeat(1001)]]) {
    assert.ok(previewWritingReplacement(source, query!, replacement!, true).error);
  }
});

test("list items are separate searchable blocks and an explicit line break is a safe boundary", () => {
  const source = draft();
  source.editorState = articleBlocksToLexicalEditorState([{ type: "list", ordered: false, items: ["海浪", "海浪"] }]);
  assert.equal(previewWritingReplacement(source, "浪海", "x", true).matches.length, 0);
  assert.equal(previewWritingReplacement(source, "海浪", "潮", true).matches.length, 2);
  const first = source.editorState.root.children[0]!.children as Record<string, unknown>[];
  first[0]!.children = [{ type: "text", version: 1, text: "海", format: 0 }, { type: "linebreak", version: 1 }, { type: "text", version: 1, text: "浪", format: 0 }];
  assert.equal(previewWritingReplacement(source, "海\n浪", "潮", true).matches.length, 0, "structural breaks are not silently removed");
});

test("search scope restricts eligible blocks and navigation anchors preserve exact inline offsets", () => {
  const source = draft();
  source.editorState = articleBlocksToLexicalEditorState([
    { type: "heading", level: 2, text: "海浪" },
    { type: "quote", text: "海浪" },
    { type: "paragraph", text: "前海浪后", inlines: [{ text: "前海", marks: ["bold"] }, { text: "浪后", href: "/articles/wave" }] },
    { type: "list", ordered: false, items: ["海浪"] },
  ]);
  const plan = previewWritingReplacement(source, "海浪", "潮", true, "paragraphs");
  assert.equal(plan.matches.length, 1);
  assert.deepEqual(writingMatchAnchors(source, plan.matches[0]!), { anchor: { path: [2, 0], offset: 1 }, focus: { path: [2, 1, 0], offset: 1 } });
  assert.equal(writingMatchAnchors(draft("不同正文"), plan.matches[0]!), null);
  for (const scope of ["headings", "quotes", "lists"] as const) assert.equal(previewWritingReplacement(source, "海浪", "潮", true, scope).matches.length, 1);
  assert.equal(bodyText(applyWritingReplacement(source, plan, [0])), "海浪\n海浪\n前潮后\n海浪");
});
