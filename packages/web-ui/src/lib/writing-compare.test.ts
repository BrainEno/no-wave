import assert from "node:assert/strict";
import test from "node:test";
import { articleBlocksToLexicalEditorState } from "./lexical-article-state.ts";
import { compareWritingDrafts, writingTextDifference } from "./writing-compare.ts";
import { restoreWritingSelection } from "./writing-restore.ts";
import { createWritingBackup, parseWritingBackup, previewWritingRestore } from "./writing-backup.ts";
import { writingDraftKey, type WritingDraft } from "./writing-session.ts";

const draft = (texts: string[]): WritingDraft => ({ title: "风", summary: "", locale: "zh-CN", workType: "essay", editorState: articleBlocksToLexicalEditorState(texts.map(text => ({ type: "paragraph", text }))) });

test("comparison identifies unchanged, edited, added, removed and moved blocks, with deterministic duplicate matching", () => {
  const before = draft(["相同", "改前", "移走", "删去", "重复", "重复"]);
  const after = draft(["移走", "相同", "改后", "重复", "新增", "重复"]);
  const compare = compareWritingDrafts(before, after);
  assert.equal(compare.limited, false);
  assert.equal(compare.rows.filter(row => row.kind === "same").length, 3);
  assert.equal(compare.rows.filter(row => row.kind === "moved").length, 1);
  const currentIndexes = compare.rows.map(row => row.currentIndex).filter(index => index !== null);
  const backupIndexes = compare.rows.map(row => row.backupIndex).filter(index => index !== null);
  assert.deepEqual([...currentIndexes].sort(), [0, 1, 2, 3, 4, 5]);
  assert.deepEqual([...backupIndexes].sort(), [0, 1, 2, 3, 4, 5]);
  assert.ok(compare.rows.some(row => row.kind === "changed" && row.currentText === "改前" && row.backupText === "改后"));
  assert.deepEqual(compare, compareWritingDrafts(before, after));
});

test("format-only changes are visible while Lexical defaults do not create false differences", () => {
  const current = draft(["一样的字"]);
  const normalized = structuredClone(current);
  normalized.editorState!.root.children[0]!.textFormat = 0;
  assert.equal(compareWritingDrafts(current, normalized).rows[0]!.kind, "same");
  const changed = structuredClone(current);
  (changed.editorState!.root.children[0]!.children as Record<string, unknown>[])[0]!.format = 1;
  const row = compareWritingDrafts(current, changed).rows[0]!;
  assert.equal(row.kind, "changed");
  assert.equal(row.formatChanged, true);
  assert.equal(row.difference.textEqual, true);
});

test("text difference keeps emoji intact, bounds rendered excerpts, and reports changes outside the excerpt", () => {
  const diff = writingTextDifference("前🌊后", "前🌙后");
  assert.equal(diff.prefix, "前");
  assert.equal(diff.removed, "🌊");
  assert.equal(diff.inserted, "🌙");
  assert.equal(diff.suffix, "后");
  const long = writingTextDifference("字".repeat(1500) + "旧", "字".repeat(1500) + "新");
  assert.equal(long.textEqual, false);
  assert.equal(long.truncated, true);
  assert.ok(long.prefix.length <= 1200);
});

test("selected backup blocks append atomically without overwriting current text or unchecked metadata", () => {
  const current = draft(["现有正文"]);
  const incoming = { ...draft(["备份一", "备份二", "备份三"]), title: "备份标题" };
  const plan = previewWritingRestore(current, parseWritingBackup(createWritingBackup(incoming)));
  const restored = restoreWritingSelection(current, plan, ["editorState"], { mode: "append", blocks: [2, 0] });
  assert.equal(restored.title, current.title);
  assert.deepEqual(restored.editorState!.root.children.map(node => (node.children as Record<string, unknown>[])[0]!.text), ["现有正文", "备份一", "备份三"], "selected blocks retain backup order, not checkbox-click order");
  assert.equal(writingDraftKey(current), writingDraftKey(draft(["现有正文"])));
  for (const indexes of [[], [0, 0], [-1], [999], [0.1]]) assert.throws(() => restoreWritingSelection(current, plan, ["editorState"], { mode: "append", blocks: indexes }));
  assert.throws(() => restoreWritingSelection({ ...current, summary: "后来改了" }, plan, ["editorState"], { mode: "append", blocks: [0] }), /预览已过期/);
});

test("append refuses block/text/serialization limits and invalid existing structure without partial changes", () => {
  const current = draft(Array.from({ length: 200 }, (_, index) => `现有 ${index}`));
  const incoming = draft(["备份"]);
  const plan = previewWritingRestore(current, parseWritingBackup(createWritingBackup(incoming)));
  assert.throws(() => restoreWritingSelection(current, plan, ["editorState"], { mode: "append", blocks: [0] }), /200/);
  assert.equal(current.editorState!.root.children.length, 200);
  const unsupported = draft(["本地"]);
  unsupported.editorState!.root.children[0]!.indent = 2;
  const unsafe = previewWritingRestore(unsupported, parseWritingBackup(createWritingBackup(incoming)));
  assert.throws(() => restoreWritingSelection(unsupported, unsafe, ["editorState"], { mode: "append", blocks: [0] }), /格式/);
});
