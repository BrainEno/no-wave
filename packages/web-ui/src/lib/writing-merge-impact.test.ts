import assert from "node:assert/strict";
import { test } from "node:test";
import { createWritingBackup, parseWritingBackup } from "./writing-backup.ts";
import {
  analyzeWritingMerge,
  prepareWritingMerge,
  type WritingMergeDecision,
} from "./writing-merge.ts";
import {
  reviewWritingMergeImpact,
  writingMergeImpactRows,
} from "./writing-merge-impact.ts";
const now = new Date("2026-11-12T00:00:00.000Z");
function backup(blocks: string[], title = "标题") {
  return parseWritingBackup(
    createWritingBackup(
      {
        title,
        summary: "摘要",
        locale: "zh-CN",
        workType: "essay",
        editorState: {
          root: {
            type: "root",
            version: 1,
            children: blocks.map((text) => ({
              type: "paragraph",
              version: 1,
              children: [{ type: "text", version: 1, text }],
            })),
          },
        },
      },
      now,
    ),
  );
}

test("nonconflicting changes remain adopted, while exact output reconciliation distinguishes each source and ignores no fields", async () => {
  const sources = {
    base: backup(["一", "二", "三"]),
    current: backup(["当前一", "二", "三"], "新标题"),
    incoming: backup(["一", "二", "另一三"]),
  };
  const analysis = await analyzeWritingMerge(sources),
    prepared = await prepareWritingMerge(analysis, [], now);
  const report = reviewWritingMergeImpact(analysis, [], prepared);
  assert.deepEqual(report.items, []);
  assert.equal(report.sources.current.bodyEqual, false);
  assert.equal(report.sources.incoming.bodyEqual, false);
  assert.deepEqual(report.sources.base.fields, ["title"]);
  assert.deepEqual(report.sources.current.fields, []);
  assert.equal(report.sources.current.rootEqual, true);
  assert.deepEqual(report.unadopted, { current: 0, incoming: 0 });
});

test("conflict-to-base and overridden agreements list both unadopted branch candidates but never call their prose deleted", async () => {
  const analysis = await analyzeWritingMerge({
    base: backup(["旧正文"], "旧标题"),
    current: backup(["当前正文"], "共同新标题"),
    incoming: backup(["另一正文"], "共同新标题"),
  });
  const decisions: WritingMergeDecision[] = analysis.units
    .filter((unit) => unit.status !== "same")
    .map((unit) => ({ unit: unit.id, choice: "base" }));
  const prepared = await prepareWritingMerge(analysis, decisions, now),
    report = reviewWritingMergeImpact(analysis, decisions, prepared);
  assert.equal(report.items.length, 2);
  assert.deepEqual(report.unadopted, { current: 2, incoming: 2 });
  assert.equal(report.overrides, 1);
  assert.equal(report.baseConflicts, 1);
  assert.equal(report.sources.base.bodyEqual, true);
  assert.deepEqual(report.sources.base.fields, []);
  const metadata = report.items.find((item) => item.unit.kind === "field")!;
  assert.deepEqual(metadata.unadopted, ["current", "incoming"]);
  assert.equal(metadata.override, true);
  assert.equal(writingMergeImpactRows(report, "overrides").length, 1);
  assert.equal(writingMergeImpactRows(report, "conflicts").length, 1);
  assert.throws(
    () => writingMergeImpactRows(report, "missing" as "all"),
    /筛选/,
  );
});

test("zero-block choices distinguish explicit deletion from matching nonempty output, and preserve the rejected branch candidate", async () => {
  const analysis = await analyzeWritingMerge({
    base: backup(["一", "二", "尾"]),
    current: backup(["尾"]),
    incoming: backup(["修改一", "二", "尾"]),
  });
  const conflict = analysis.units.find((unit) => unit.status === "conflict")!;
  const decisions: WritingMergeDecision[] = [
    { unit: conflict.id, choice: "current" },
  ];
  const report = reviewWritingMergeImpact(
    analysis,
    decisions,
    await prepareWritingMerge(analysis, decisions, now),
  );
  assert.equal(report.emptySelections, 1);
  assert.deepEqual(report.items[0]!.unadopted, ["incoming"]);
  assert.equal(report.items[0]!.selectedBlocks, 0);
  assert.equal(report.sources.current.bodyEqual, true);
  assert.equal(report.sources.current.blocks, 1);
  assert.equal(writingMergeImpactRows(report, "empty").length, 1);
  assert.equal(analysis.units.filter((unit) => unit.kind === "body").length, 2);
});

test("root-only changes and opaque duplicate conflicts remain exact, and stale or corrupted output cannot produce a reassuring impact report", async () => {
  const base = backup(["重复", "重复", "尾"]),
    current = backup(["当前", "重复", "尾"]),
    incoming = backup(["重复", "另一", "尾"]);
  current.draft.editorState!.root.direction = "ltr";
  const analysis = await analyzeWritingMerge({ base, current, incoming }),
    conflict = analysis.units.find((unit) => unit.status === "conflict")!;
  const decisions: WritingMergeDecision[] = [
    { unit: conflict.id, choice: "incoming" },
  ];
  const prepared = await prepareWritingMerge(analysis, decisions, now),
    report = reviewWritingMergeImpact(analysis, decisions, prepared);
  assert.equal(report.ambiguous, 1);
  assert.equal(report.sources.current.rootEqual, true);
  assert.equal(report.sources.incoming.rootEqual, false);
  assert.deepEqual(
    report.items.find((item) => item.unit.kind === "body")!.unadopted,
    ["current"],
  );
  assert.throws(
    () =>
      reviewWritingMergeImpact(
        analysis,
        [{ unit: conflict.id, choice: "base" }],
        prepared,
      ),
    /过期/,
  );
  const corrupted = structuredClone(prepared);
  corrupted.backup.draft.title = "静默损坏";
  assert.throws(
    () => reviewWritingMergeImpact(analysis, decisions, corrupted),
    /守恒/,
  );
  const alteredText = structuredClone(prepared);
  alteredText.text = alteredText.text.replace("标题", "错误标题");
  assert.throws(
    () => reviewWritingMergeImpact(analysis, decisions, alteredText),
    /守恒/,
  );
  assert.equal(report.sources.incoming.bodyEqual, true);
});
