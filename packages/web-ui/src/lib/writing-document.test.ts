import assert from "node:assert/strict";
import test from "node:test";
import { articleBlocksToLexicalEditorState } from "./lexical-article-state.ts";
import { inspectWriting, writingSectionStatistics } from "./writing-document.ts";
import type { WritingDraft } from "./writing-session.ts";

const draft = (): WritingDraft => ({ title: "海风", summary: "", locale: "zh-CN", workType: "essay", editorState: articleBlocksToLexicalEditorState([
  { type: "heading", level: 2, text: "一" },
  { type: "paragraph", text: "海风 one two 🌊" },
  { type: "heading", level: 4, text: " 二 " },
  { type: "heading", level: 2, text: "一" },
  { type: "list", ordered: false, items: ["第一项", "第二项"] },
  { type: "code", language: "text", code: "excluded words" },
  { type: "image", src: "/api/media/11111111-1111-4111-8111-111111111111", alt: "" },
]) });

test("outline and issues point to serialized node paths without changing the document", () => {
  const source = draft();
  const before = JSON.stringify(source);
  const inspection = inspectWriting(source);
  assert.deepEqual(inspection.outline.map(item => item.path), [[0], [2], [3]]);
  assert.deepEqual(inspection.outline.map(item => item.level), [2, 4, 2]);
  for (const code of ["heading-gap", "heading-duplicate", "image-alt"]) assert.ok(inspection.issues.some(issue => issue.code === code));
  assert.ok(inspection.blocks.some(block => block.path.join(".") === "4.1" && block.text === "第二项"));
  assert.equal(inspection.statistics.images, 1);
  assert.equal(inspection.statistics.codeBlocks, 1);
  assert.ok(inspection.statistics.characters > 10);
  assert.equal(JSON.stringify(source), before);
});

test("checks are actionable and incomplete or unsupported content is never silently graded as valid", () => {
  const source = draft();
  source.title = " ";
  source.editorState!.root.children.push({ type: "mystery", version: 1 });
  const inspection = inspectWriting(source);
  assert.ok(inspection.issues.some(issue => issue.code === "title-empty" && issue.path === null));
  assert.ok(inspection.issues.some(issue => issue.code === "unsupported-node"));
  const empty = inspectWriting({ ...source, editorState: articleBlocksToLexicalEditorState(null) });
  assert.ok(empty.issues.some(issue => issue.code === "body-empty"));
  const long = inspectWriting({ ...source, editorState: articleBlocksToLexicalEditorState([{ type: "paragraph", text: "字".repeat(1200) }]) });
  assert.ok(long.issues.some(issue => issue.code === "paragraph-long"));
});

test("section sizes include child headings but stop at the next peer, excluding code and image descriptions", () => {
  const source = draft();
  const sections = writingSectionStatistics(source, inspectWriting(source));
  assert.deepEqual(sections.map(item => [item.startBlock, item.endBlock]), [[0, 3], [2, 3], [3, 7]]);
  assert.equal(sections[1]!.characters, 1);
  assert.equal(sections[2]!.characters, 7, "heading plus two list items, not code or image alt");
  assert.equal(sections[2]!.images, 1);
  assert.equal(sections[0]!.minutes, 1);
  assert.equal(writingSectionStatistics({ ...source, editorState: null }, inspectWriting({ ...source, editorState: null })).length, 0);
});

test("inspection stops traversing at its node budget and reports omitted top-level blocks as partial", () => {
  const source = draft();
  const children = Array.from({ length: 12_002 }, () => ({ type: "text", version: 1, text: "" }));
  Object.defineProperty(children, 12_001, { get() { throw new Error("inspection read beyond its node budget"); } });
  source.editorState!.root.children = [{ type: "paragraph", version: 1, children }];
  assert.equal(inspectWriting(source).limited, true);
  source.editorState!.root.children = Array.from({ length: 202 }, () => ({ type: "paragraph", version: 1, children: [] }));
  const partial = inspectWriting(source);
  assert.equal(partial.limited, true);
  assert.deepEqual(writingSectionStatistics(source, partial), []);
});
