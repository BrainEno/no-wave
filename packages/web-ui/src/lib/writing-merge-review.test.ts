import assert from "node:assert/strict";
import { test } from "node:test";
import { createWritingBackup, parseWritingBackup } from "./writing-backup.ts";
import { analyzeWritingMerge, prepareWritingMerge } from "./writing-merge.ts";
import {
  MERGE_REVIEW_PAGE_SIZE,
  writingMergeConflictTarget,
  writingMergeDecisionChanges,
  writingMergeResultReview,
  writingMergeReviewPage,
  writingMergeReviewRows,
} from "./writing-merge-review.ts";
const now = new Date("2026-11-12T00:00:00.000Z");
const backup = (blocks: string[]) =>
  parseWritingBackup(
    createWritingBackup(
      {
        title: "标题",
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
async function analysis() {
  const base = Array.from({ length: 39 }, (_, index) => `基线${index}`);
  return analyzeWritingMerge({
    base: backup(base),
    current: backup(
      base.map((text, index) => (index % 2 ? text : `当前${index}`)),
    ),
    incoming: backup(
      base.map((text, index) => (index % 2 ? text : `另一${index}`)),
    ),
  });
}

test("review pagination clamps a shrinking view without dropping hidden decisions", async () => {
  const source = await analysis(),
    conflict = source.units.find((unit) => unit.status === "conflict")!;
  const decisions = [{ unit: conflict.id, choice: "base" as const }];
  const rows = writingMergeReviewRows(source, decisions, "conflicts");
  assert.equal(rows.length, 20);
  const first = writingMergeReviewPage(rows, 0),
    last = writingMergeReviewPage(rows, 999);
  assert.equal(first.rows.length, MERGE_REVIEW_PAGE_SIZE);
  assert.equal(last.page, 1);
  assert.equal(last.rows.length, 8);
  assert.equal(
    writingMergeReviewRows(source, decisions, "unresolved").length,
    19,
  );
  assert.equal(
    writingMergeReviewRows(source, decisions, "manual")[0]!.unit.id,
    conflict.id,
  );
  assert.deepEqual(decisions, [{ unit: conflict.id, choice: "base" }]);
  assert.equal(writingMergeReviewPage([], 3).page, 0);
  assert.throws(() => writingMergeReviewPage(rows, -1), /页码/);
});

test("conflict navigation wraps in source order, ignores resolved choices and rejects stale anchors", async () => {
  const source = await analysis(),
    pending = writingMergeReviewRows(source, [], "unresolved");
  const first = pending[0]!.unit.id,
    last = pending.at(-1)!.unit.id;
  assert.equal(writingMergeConflictTarget(source, [], null, 1), first);
  assert.equal(writingMergeConflictTarget(source, [], null, -1), last);
  assert.equal(writingMergeConflictTarget(source, [], first, -1), last);
  assert.equal(writingMergeConflictTarget(source, [], last, 1), first);
  assert.equal(
    writingMergeConflictTarget(
      source,
      [{ unit: first, choice: "current" }],
      last,
      1,
    ),
    pending[1]!.unit.id,
  );
  assert.throws(
    () => writingMergeConflictTarget(source, [], "missing", 1),
    /过期/,
  );
  assert.equal(
    writingMergeConflictTarget(
      source,
      pending.map((row) => ({ unit: row.unit.id, choice: "base" })),
      first,
      1,
    ),
    null,
  );
});

test("plan replacement review exposes removals and fallback defaults, not only newly added choices", async () => {
  const source = await analysis(),
    conflict = source.units.find((unit) => unit.status === "conflict")!,
    title = source.units.find((unit) => unit.id === "field:title")!;
  const changes = writingMergeDecisionChanges(
    source,
    [
      { unit: conflict.id, choice: "incoming" },
      { unit: title.id, choice: "base" },
    ],
    [],
  );
  assert.equal(changes.length, 2);
  assert.equal(
    changes.find((row) => row.unit.id === conflict.id)!.afterEffective,
    null,
  );
  assert.equal(
    changes.find((row) => row.unit.id === title.id)!.afterEffective,
    "base",
  );
  assert.equal(changes.find((row) => row.unit.id === title.id)!.after, null);
});

test("result accounting includes all filtered-out selections and refuses stale prepared snapshots", async () => {
  const source = await analysis(),
    decisions = source.units
      .filter((unit) => unit.status === "conflict")
      .map((unit) => ({ unit: unit.id, choice: "base" as const }));
  const prepared = await prepareWritingMerge(source, decisions, now);
  const report = writingMergeResultReview(source, decisions, prepared);
  assert.equal(report.blockCount, 39);
  assert.equal(report.baseConflicts, 20);
  assert.equal(
    report.from.base + report.from.current + report.from.incoming,
    39,
  );
  assert.equal(report.fields.length, 4);
  assert.throws(() => writingMergeResultReview(source, [], prepared), /过期/);
});
