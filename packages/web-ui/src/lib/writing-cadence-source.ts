import {
  openWritingCollection,
  type OpenedCollection,
} from "./writing-collection.ts";
import {
  inspectWriting,
  writingNodeAt,
  type WritingBlock,
} from "./writing-document.ts";
import type {
  CadenceBudgets,
  CadenceCoverage,
  CadencePolicy,
  CadenceProgress,
  CadenceRange,
  CadenceUnit,
} from "./writing-cadence-model.ts";
import { cadenceActive, cadenceCheckpoint } from "./writing-cadence-symbols.ts";

const kinds = {
  all: ["paragraph", "heading", "quote", "listitem"],
  paragraphs: ["paragraph"],
  headings: ["heading"],
  quotes: ["quote"],
  lists: ["listitem"],
};

function ranges(
  block: WritingBlock,
  root: Parameters<typeof writingNodeAt>[0],
): Pick<CadenceUnit, "runs" | "barriers"> & { points: number } {
  const pointAt = new Map<number, number>([[0, 0]]);
  let offset = 0,
    points = 0;
  for (const point of block.text) {
    offset += point.length;
    pointAt.set(offset, ++points);
  }
  const range = (start: number, end: number): CadenceRange => {
    const from = pointAt.get(start),
      to = pointAt.get(end);
    if (from === undefined || to === undefined || start >= end)
      throw new Error("正文结构切开了Unicode代码点，未猜测扫描边界。");
    return { start, end, pointStart: from, pointEnd: to };
  };
  const barriers: CadenceUnit["barriers"] = [];
  let accounted = 0;
  for (const run of block.runs) {
    const node = writingNodeAt(root, run.path);
    if (
      !node ||
      run.start !== accounted ||
      run.end !== run.start + run.text.length ||
      block.text.slice(run.start, run.end) !== run.text
    )
      throw new Error("文字游程与原节点位置不一致，没有拼接部分正文。");
    accounted = run.end;
    if (!run.text.length) continue;
    if (typeof node.format === "number" && (node.format & 16) !== 0) {
      barriers.push({ ...range(run.start, run.end), kind: "inline-code" });
      continue;
    }
    let start = run.start;
    for (const point of run.text) {
      if (point === "\n" || point === "\t" || point === "\r")
        barriers.push({ ...range(start, start + point.length), kind: "break" });
      start += point.length;
    }
  }
  if (accounted !== block.text.length)
    throw new Error("文字游程没有完整覆盖本单元，未继续分析。");
  const runs: CadenceRange[] = [];
  let cursor = 0;
  for (const barrier of barriers) {
    if (barrier.start < cursor)
      throw new Error("受保护结构范围重叠，未继续分析。");
    if (barrier.start > cursor) runs.push(range(cursor, barrier.start));
    cursor = barrier.end;
  }
  if (cursor < block.text.length) runs.push(range(cursor, block.text.length));
  return { runs, barriers, points };
}

/** Reuse the strict collection format; only the captured serialized snapshot supplies manuscript data. */
export async function prepareCadenceSource(
  opened: OpenedCollection,
  policy: CadencePolicy,
  budgets: CadenceBudgets,
  signal: AbortSignal,
  pause: () => Promise<void>,
  progress: (value: CadenceProgress) => void,
) {
  cadenceActive(signal);
  const serialized = opened.prepared.text,
    expected = opened.prepared.collection.digest,
    source = opened.source;
  if (source !== "single" && source !== "collection")
    throw new Error("来源类型无效，未建立本机分析。");
  const owned = await openWritingCollection(serialized, signal);
  if (owned.prepared.collection.digest !== expected)
    throw new Error("来源快照摘要不符，未使用可变调用者树。");
  const entries = owned.prepared.collection.entries;
  const coverage: CadenceCoverage = {
    documents: entries.length,
    units: 0,
    excludedUnits: 0,
    eligibleUnits: 0,
    characters: 0,
    points: 0,
    protectedCharacters: 0,
    scannedUnits: 0,
    scannedCharacters: 0,
    scannedPoints: 0,
    steps: 0,
  };
  const units: CadenceUnit[] = [];
  let allCharacters = 0;
  for (const [ordinal, entry] of entries.entries()) {
    await cadenceCheckpoint(signal, pause);
    const inspection = inspectWriting(entry.backup.draft);
    if (
      inspection.limited ||
      inspection.issues.some((issue) => issue.code === "unsupported-node")
    )
      throw new Error("来源不能被完整提取，未把部分检查当成完整正文。");
    const root = entry.backup.draft.editorState!.root;
    for (const block of inspection.blocks) {
      if (++coverage.units > budgets.units)
        throw new Error("来源文字单元超过固定上限，整轮拒绝。");
      allCharacters += block.text.length;
      if (allCharacters > budgets.characters)
        throw new Error("来源正文字符超过预算，整轮拒绝而不截短。");
      if (coverage.units % 32 === 0) await cadenceCheckpoint(signal, pause);
      if (!kinds[policy.scope].includes(block.kind)) {
        coverage.excludedUnits++;
        continue;
      }
      if (!writingNodeAt(root, block.path))
        throw new Error("原文路径缺失，未定位相邻段落。");
      const { runs, barriers, points } = ranges(block, root);
      units.push({
        id: `${entry.key}:${block.path.join(".")}`,
        document: entry.key,
        path: [...block.path],
        kind: block.kind,
        text: block.text,
        runs,
        barriers,
      });
      coverage.eligibleUnits++;
      coverage.characters += block.text.length;
      coverage.points += points;
      coverage.protectedCharacters += barriers.reduce(
        (sum, barrier) => sum + barrier.end - barrier.start,
        0,
      );
    }
    progress({ stage: "source", done: ordinal + 1, total: entries.length });
    cadenceActive(signal);
  }
  return {
    sourceKey: expected,
    source,
    documents: entries.map((entry) => entry.key),
    units,
    coverage,
  };
}
