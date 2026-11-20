import type { OpenedCollection } from "./writing-collection.ts";
import type { WritingNode } from "./writing-document.ts";
import type {
  ParallelBlockKind,
  ParallelBudgets,
  ParallelPolicy,
  ParallelUnit,
} from "./writing-parallel-model.ts";
import { extractAnchorTokens } from "./writing-parallel-symbols.ts";

export type ParallelPreparedSource = {
  units: ParallelUnit[];
  byDocument: Map<string, ParallelUnit[]>;
  documentLocales: Map<string, string>;
  documentTitles: Map<string, string>;
  pairsToAnalyze: { left: string; right: string }[];
};

export async function prepareParallelSource(
  opened: OpenedCollection,
  policy: ParallelPolicy,
  budgets: ParallelBudgets,
): Promise<ParallelPreparedSource> {
  const units: ParallelUnit[] = [];
  const byDocument = new Map<string, ParallelUnit[]>();
  const documentLocales = new Map<string, string>();
  const documentTitles = new Map<string, string>();

  let totalCharacters = 0;
  let unitCounter = 0;

  const entries = opened.prepared.collection.entries;

  for (const entry of entries) {
    const docUnits: ParallelUnit[] = [];
    const docId = entry.key;
    const draft = entry.backup.draft;

    documentLocales.set(docId, draft.locale || "und");
    documentTitles.set(docId, draft.title || docId);

    const root = draft.editorState?.root;
    if (!root || !Array.isArray(root.children)) {
      continue;
    }

    let currentOffset = 0;
    let currentPoint = 0;

    for (const child of root.children as WritingNode[]) {
      if (!child || typeof child !== "object") continue;

      const kind: ParallelBlockKind =
        child.type === "paragraph"
          ? "paragraph"
          : child.type === "heading"
            ? "heading"
            : child.type === "quote"
              ? "quote"
              : child.type === "listitem"
                ? "listitem"
                : child.type === "image"
                  ? "image"
                  : "other";

      if (policy.scope === "paragraphs" && kind !== "paragraph") continue;
      if (policy.scope === "headings" && kind !== "heading") continue;
      if (
        policy.scope === "structural" &&
        !["paragraph", "heading", "quote", "listitem"].includes(kind)
      ) {
        continue;
      }

      let text = "";
      const links: string[] = [];
      const images: string[] = [];

      function extractTextAndAssets(node: WritingNode): void {
        if (!node) return;
        if (node.type === "text" && typeof node.text === "string") {
          text += node.text;
        } else if (node.type === "image" && typeof node.src === "string") {
          images.push(node.src);
        } else if (node.type === "link" && typeof (node as any).url === "string") {
          links.push((node as any).url);
        }
        if (Array.isArray(node.children)) {
          for (const sub of node.children) extractTextAndAssets(sub);
        }
      }

      extractTextAndAssets(child);

      const trimmed = text.trim();
      if (kind !== "image" && trimmed.length < policy.minBlockLength) {
        continue;
      }

      const characterCount = [...text].length;
      totalCharacters += text.length;
      if (totalCharacters > budgets.characters) {
        throw new Error(
          `正文文本长度超出预算上限（${budgets.characters} UTF-16 单元），已整轮拒绝。`,
        );
      }

      unitCounter++;
      if (unitCounter > budgets.units) {
        throw new Error(
          `文字单元数量超出预算上限（${budgets.units} 单元），已整轮拒绝。`,
        );
      }

      const headingLevel =
        kind === "heading" && typeof (child as any).tag === "string"
          ? Number.parseInt((child as any).tag.replace(/\D/g, ""), 10) || 2
          : null;

      const unit: ParallelUnit = {
        id: `${docId}:u${docUnits.length}`,
        document: docId,
        ordinal: docUnits.length,
        kind,
        headingLevel,
        text,
        snippet: text.slice(0, 160),
        characterCount,
        wordCount: (text.match(/\S+/gu) ?? []).length,
        links,
        images,
        imageCount: images.length,
        anchors: extractAnchorTokens(text),
        start: currentOffset,
        end: currentOffset + text.length,
        pointStart: currentPoint,
        pointEnd: currentPoint + characterCount,
      };

      currentOffset += text.length + 1;
      currentPoint += characterCount + 1;

      docUnits.push(unit);
      units.push(unit);
    }

    byDocument.set(docId, docUnits);
  }

  const docIds = [...byDocument.keys()];
  const pairsToAnalyze: { left: string; right: string }[] = [];

  if (docIds.length >= 2) {
    if (docIds.length === 2) {
      pairsToAnalyze.push({ left: docIds[0]!, right: docIds[1]! });
    } else {
      // Pairwise combinations up to limit
      for (let i = 0; i < docIds.length; i++) {
        for (let j = i + 1; j < docIds.length; j++) {
          if (pairsToAnalyze.length < budgets.pairs) {
            pairsToAnalyze.push({ left: docIds[i]!, right: docIds[j]! });
          }
        }
      }
    }
  }

  return {
    units,
    byDocument,
    documentLocales,
    documentTitles,
    pairsToAnalyze,
  };
}
