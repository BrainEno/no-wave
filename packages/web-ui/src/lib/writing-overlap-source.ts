import {
  collectionCanonicalJson,
  openWritingCollection,
  type OpenedCollection,
} from "./writing-collection.ts";
import {
  inspectWriting,
  writingNodeAt,
  type WritingNode,
} from "./writing-document.ts";
import {
  normalizeOverlapText,
  overlapActive,
  type OverlapBudgets,
  type OverlapCoverage,
  type OverlapPolicy,
  type OverlapProgress,
  type OverlapUnit,
} from "./writing-overlap-model.ts";

/** Re-open an owned serialized snapshot: later mutation of a caller's tree cannot change the analysis. */
export async function overlapSource(
  opened: OpenedCollection,
  policy: OverlapPolicy,
  budgets: OverlapBudgets,
  signal: AbortSignal,
  pause: () => Promise<void>,
  progress: (value: OverlapProgress) => void,
): Promise<{
  sourceKey: string;
  units: OverlapUnit[];
  coverage: OverlapCoverage;
}> {
  overlapActive(signal);
  const text = opened.prepared.text,
    expected = opened.prepared.collection.digest;
  const snapshot = await openWritingCollection(text, signal);
  if (snapshot.prepared.collection.digest !== expected)
    throw new Error("来源快照与摘要已经变化，未接纳部分段落。");
  const entries = snapshot.prepared.collection.entries;
  const units: OverlapUnit[] = [];
  const coverage: OverlapCoverage = {
    documents: entries.length,
    units: 0,
    eligible: 0,
    excluded: 0,
    families: 0,
    indexed: 0,
    long: 0,
    grams: 0,
    candidates: 0,
    compared: 0,
    probes: 0,
    common: 0,
    qualified: 0,
  };
  let characters = 0,
    normalizedCharacters = 0;
  for (const entry of entries) {
    overlapActive(signal);
    await pause();
    overlapActive(signal);
    const inspection = inspectWriting(entry.backup.draft);
    if (inspection.limited)
      throw new Error("来源检查达到既有限额，未将不完整文字交给段落分析。");
    const root = entry.backup.draft.editorState!.root as WritingNode;
    for (const block of inspection.blocks) {
      if (++coverage.units > budgets.units)
        throw new Error("文字单元超过本轮固定上限，未截断分析。");
      characters += block.text.length;
      if (characters > budgets.characters)
        throw new Error("所选文字超过本轮计算预算，未截短来源。");
      if (coverage.units % 32 === 0) {
        await pause();
        overlapActive(signal);
      }
      if (
        !["paragraph", "heading", "quote", "listitem"].includes(block.kind) ||
        !block.text.trim()
      ) {
        coverage.excluded++;
        continue;
      }
      const normalized = normalizeOverlapText(block.text, policy.mode);
      normalizedCharacters += normalized.length;
      if (normalizedCharacters > budgets.characters)
        throw new Error("规范化后的文字超过计算预算，未截短或部分分析来源。");
      let length = 0;
      for (const _point of normalized) if (++length === policy.minimum) break;
      if (length < policy.minimum) {
        coverage.excluded++;
        continue;
      }
      const node = writingNodeAt(root, block.path);
      if (!node) throw new Error("原始段落路径缺失，没有猜测邻近位置。");
      units.push({
        id: `${entry.key}:${block.path.join(".")}`,
        document: entry.key,
        group: entry.group,
        path: [...block.path],
        kind: block.kind,
        text: block.text,
        normalized,
        structure: collectionCanonicalJson(node),
      });
      coverage.eligible++;
    }
    progress({
      stage: "source",
      done: entries.indexOf(entry) + 1,
      total: entries.length,
    });
    overlapActive(signal);
  }
  return { sourceKey: expected, units, coverage };
}
