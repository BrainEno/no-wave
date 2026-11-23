import assert from "node:assert/strict";
import { test } from "node:test";
import { createWritingBackup, parseWritingBackup } from "./writing-backup.ts";
import { analyzeWritingMerge, prepareWritingMerge } from "./writing-merge.ts";
import {
  verifyWritingMergeOutput,
  verifyWritingMergePartition,
} from "./writing-merge-integrity.ts";
const now = new Date("2026-11-12T00:00:00.000Z");
const backup = (blocks: string[]) =>
  parseWritingBackup(
    createWritingBackup(
      {
        title: "标题",
        summary: "摘要",
        locale: "zh-CN",
        workType: "other",
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
const inputs = () => ({
  base: backup(["一", "二", "三"]),
  current: backup(["当前一", "二", "三"]),
  incoming: backup(["一", "二", "另一三"]),
});

test("independent partition verification accounts for every source node exactly once in original order", async () => {
  const sources = inputs(),
    analysis = await analyzeWritingMerge(sources);
  assert.deepEqual(verifyWritingMergePartition(sources, analysis.units), {
    base: 3,
    current: 3,
    incoming: 3,
  });
  for (const defect of [
    "omit",
    "duplicate",
    "reorder",
    "alter-candidate",
    "wrong-range",
    "metadata",
  ] as const) {
    const units = structuredClone(analysis.units);
    const body = units.findIndex((unit) => unit.kind === "body");
    if (defect === "omit") units.splice(body, 1);
    if (defect === "duplicate") units.push(structuredClone(units[body]!));
    if (defect === "reorder")
      [units[body], units[body + 1]] = [units[body + 1]!, units[body]!];
    if (defect === "alter-candidate") {
      const unit = units[body]!;
      if (unit.kind === "body")
        unit.values.current[0]!.children = [
          { type: "text", version: 1, text: "静默损坏" },
        ];
    }
    if (defect === "wrong-range") {
      const unit = units[body]!;
      if (unit.kind === "body") unit.end++;
    }
    if (defect === "metadata") {
      const unit = units.find((unit) => unit.kind === "field")!;
      if (unit.kind === "field") unit.values.incoming = "伪造标题";
    }
    assert.throws(
      () => verifyWritingMergePartition(sources, units),
      /守恒|区间|重复|元数据/,
      defect,
    );
  }
});

test("root metadata and missing fields cannot slip through a complete-body check", async () => {
  const sources = inputs(),
    analysis = await analyzeWritingMerge(sources);
  const altered = structuredClone(analysis.units);
  const root = altered.find((unit) => unit.kind === "root")!;
  if (root.kind === "root") root.values.current.direction = "ltr";
  assert.throws(
    () => verifyWritingMergePartition(sources, altered),
    /根结构|守恒/,
  );
  assert.throws(
    () =>
      verifyWritingMergePartition(
        sources,
        analysis.units.filter((unit) => unit.id !== "field:locale"),
      ),
    /元数据|守恒/,
  );
});

test("selected-output verification rejects silent formatting, field, order and extra-block changes", async () => {
  const analysis = await analyzeWritingMerge(inputs()),
    prepared = await prepareWritingMerge(analysis, [], now);
  assert.doesNotThrow(() =>
    verifyWritingMergeOutput(analysis, [], prepared.backup),
  );
  for (const defect of ["format", "title", "order", "extra"] as const) {
    const output = structuredClone(prepared.backup),
      blocks = output.draft.editorState!.root.children;
    if (defect === "format")
      (blocks[0]!.children as Record<string, unknown>[])[0]!.format = 1;
    if (defect === "title") output.draft.title = "错误标题";
    if (defect === "order") blocks.reverse();
    if (defect === "extra") blocks.push(structuredClone(blocks[0]!));
    assert.throws(
      () => verifyWritingMergeOutput(analysis, [], output),
      /守恒|取舍|元数据/,
      defect,
    );
  }
});

test("a deterministic edit corpus conserves every source and symmetric conflict-to-base choices give the same result", async () => {
  let seed = 0x47db351;
  const random = (max: number) => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed % max;
  };
  function mutate(base: string[], label: string) {
    const nodes = base
      .filter(() => random(5) !== 0)
      .map((text) => (random(4) === 0 ? `${label}-${text}` : text));
    if (!nodes.length) nodes.push(`${label}-empty`);
    if (random(2))
      nodes.splice(random(nodes.length + 1), 0, `${label}-insert-${seed}`);
    if (random(7) === 0) nodes.reverse();
    if (random(9) === 0) nodes.push(nodes[0]!);
    return nodes;
  }
  for (let iteration = 0; iteration < 80; iteration++) {
    const base = ["A", "B", "C", "D", "E"],
      current = mutate(base, "current"),
      incoming = mutate(base, "incoming");
    const sources = {
      base: backup(base),
      current: backup(current),
      incoming: backup(incoming),
    };
    const analysis = await analyzeWritingMerge(sources);
    assert.deepEqual(analysis.coverage, {
      base: base.length,
      current: current.length,
      incoming: incoming.length,
    });
    const decisions = analysis.units
      .filter((unit) => unit.status === "conflict")
      .map((unit) => ({ unit: unit.id, choice: "base" as const }));
    const prepared = await prepareWritingMerge(analysis, decisions, now);
    const swapped = await analyzeWritingMerge({
      base: sources.base,
      current: sources.incoming,
      incoming: sources.current,
    });
    const other = await prepareWritingMerge(
      swapped,
      swapped.units
        .filter((unit) => unit.status === "conflict")
        .map((unit) => ({ unit: unit.id, choice: "base" as const })),
      now,
    );
    assert.deepEqual(
      prepared.backup.draft,
      other.backup.draft,
      `deterministic corpus ${iteration}`,
    );
  }
});

test("an explicitly chosen empty interval deletes only that interval and cannot invent a replacement paragraph", async () => {
  const sources = {
    base: backup(["一", "二", "尾"]),
    current: backup(["尾"]),
    incoming: backup(["另一一", "二", "尾"]),
  };
  const analysis = await analyzeWritingMerge(sources),
    conflict = analysis.units.find((unit) => unit.status === "conflict")!;
  const decisions = [{ unit: conflict.id, choice: "current" as const }];
  const prepared = await prepareWritingMerge(analysis, decisions, now);
  assert.deepEqual(
    prepared.backup.draft.editorState,
    sources.current.draft.editorState,
  );
  assert.doesNotThrow(() =>
    verifyWritingMergeOutput(analysis, decisions, prepared.backup),
  );
});

test("whole-body ambiguity decisions still pass exact conservation checks", async () => {
  const sources = {
    base: backup(["重复", "重复", "尾"]),
    current: backup(["当前", "重复", "尾"]),
    incoming: backup(["重复", "另一", "尾"]),
  };
  const analysis = await analyzeWritingMerge(sources),
    unit = analysis.units.find((item) => item.kind === "body")!;
  assert.deepEqual(verifyWritingMergePartition(sources, analysis.units), {
    base: 3,
    current: 3,
    incoming: 3,
  });
  const decisions = [{ unit: unit.id, choice: "incoming" as const }];
  const prepared = await prepareWritingMerge(analysis, decisions, now);
  assert.doesNotThrow(() =>
    verifyWritingMergeOutput(analysis, decisions, prepared.backup),
  );
});
