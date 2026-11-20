import {
  openWritingCollection,
  type OpenedCollection,
} from "./writing-collection.ts";
import { inspectWriting, writingNodeAt } from "./writing-document.ts";
import { termsActive, termsCheckpoint } from "./writing-terms-recipe.ts";
import type {
  TermsBudgets,
  TermsCoverage,
  TermsOptions,
  TermsPolicy,
  TermsUnit,
} from "./writing-terms-model.ts";

export async function prepareTermsSource(
  opened: OpenedCollection,
  policy: TermsPolicy,
  budgets: TermsBudgets,
  signal: AbortSignal,
  pause: () => Promise<void>,
  progress: NonNullable<TermsOptions["progress"]>,
) {
  termsActive(signal);
  const text = opened.prepared.text,
    expected = opened.prepared.collection.digest;
  const owned = await openWritingCollection(text, signal);
  if (owned.prepared.collection.digest !== expected)
    throw new Error("文稿来源快照与摘要不符，未猜测旧来源。");
  const documents = owned.prepared.collection.entries.map((entry) => entry.key);
  const units: TermsUnit[] = [];
  const coverage: TermsCoverage = {
    documents: documents.length,
    units: 0,
    eligibleUnits: 0,
    excludedUnits: 0,
    points: 0,
    characters: 0,
    scannedUnits: 0,
    scannedPoints: 0,
    scannedCharacters: 0,
    steps: 0,
    outputs: 0,
    wordRejected: 0,
    boundaryRejected: 0,
  };
  const kinds = {
    all: ["paragraph", "heading", "quote", "listitem"],
    paragraphs: ["paragraph"],
    headings: ["heading"],
    quotes: ["quote"],
    lists: ["listitem"],
  };
  let totalCharacters = 0;
  for (const [ordinal, entry] of owned.prepared.collection.entries.entries()) {
    await termsCheckpoint(signal, pause);
    const inspection = inspectWriting(entry.backup.draft);
    if (
      inspection.limited ||
      inspection.issues.some((issue) => issue.code === "unsupported-node")
    )
      throw new Error("来源含不能完整提取的正文或达到检查上限，未部分扫描。");
    for (const block of inspection.blocks) {
      if (++coverage.units > budgets.units)
        throw new Error("正文单元超过本轮上限，未截断来源。");
      totalCharacters += block.text.length;
      if (totalCharacters > budgets.characters)
        throw new Error("正文字符超过本轮预算，未截断来源。");
      if (coverage.units % 32 === 0) await termsCheckpoint(signal, pause);
      if (!kinds[policy.scope].includes(block.kind)) {
        coverage.excludedUnits++;
        continue;
      }
      if (
        !entry.backup.draft.editorState ||
        !writingNodeAt(entry.backup.draft.editorState.root, block.path)
      )
        throw new Error("正文位置缺失，没有定位相邻内容。");
      const blocked = block.runs
        .filter((run) => run.boundary)
        .map((run) => Object.freeze({ start: run.start, end: run.end }));
      Object.freeze(blocked);
      const path = [...block.path];
      Object.freeze(path);
      units.push(
        Object.freeze({
          id: `${entry.key}:${path.join(".")}`,
          document: entry.key,
          path,
          kind: block.kind,
          text: block.text,
          blocked,
        }),
      );
      coverage.eligibleUnits++;
      coverage.characters += block.text.length;
      coverage.points += [...block.text].length;
    }
    progress("source", ordinal + 1, documents.length);
    termsActive(signal);
  }
  return { sourceKey: expected, units, documents, coverage };
}
