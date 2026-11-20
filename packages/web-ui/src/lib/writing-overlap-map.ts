import { COLLECTION_DOCUMENT_LIMIT } from "./writing-collection.ts";
import {
  OVERLAP_LIMITS,
  overlapFamily,
  overlapFindings,
  type OverlapAnalysis,
  type OverlapFinding,
  type OverlapUnit,
} from "./writing-overlap-model.ts";
import {
  overlapOccurrences,
  validateOverlapMarks,
  type OverlapMark,
  type OverlapReviewRow,
} from "./writing-overlap-review.ts";

export type OverlapDocumentCell = {
  id: string;
  left: string;
  right: string;
  exactPairs: number;
  nearPairs: number;
  findings: string[];
  unreviewed: number;
  intentional: number;
  followUp: number;
};
export type OverlapDocumentMap = {
  witness: OverlapAnalysis;
  documents: {
    id: string;
    eligible: number;
    listed: number;
    findings: number;
    unreviewed: number;
    peers: string[];
  }[];
  cells: OverlapDocumentCell[];
  pairs: number;
};
type DocumentTally = {
  eligible: number;
  units: Set<string>;
  findings: Set<string>;
  peers: Set<string>;
};
type Inventory = Map<string, OverlapUnit[]>;

function sealDocumentMap(map: OverlapDocumentMap): OverlapDocumentMap {
  for (const document of map.documents) {
    Object.freeze(document.peers);
    Object.freeze(document);
  }
  for (const cell of map.cells) {
    Object.freeze(cell.findings);
    Object.freeze(cell);
  }
  Object.freeze(map.documents);
  Object.freeze(map.cells);
  return Object.freeze(map);
}

/** At most 20 documents and 200 listed findings. Never enumerate occurrence pairs, even for a repeated boilerplate family. */
export function mapWritingOverlap(
  analysis: OverlapAnalysis,
  marks: readonly OverlapMark[],
  documents: readonly string[],
): OverlapDocumentMap {
  if (
    !Array.isArray(documents) ||
    documents.length !== analysis.coverage.documents ||
    !documents.length ||
    documents.length > COLLECTION_DOCUMENT_LIMIT ||
    new Set(documents).size !== documents.length ||
    documents.some(
      (id) => typeof id !== "string" || !/^d(?:[1-9]|1\d|20)$/u.test(id),
    )
  ) {
    throw new Error(
      "文稿概览需要当前文件的完整、唯一编号，不接纳来源名称或未知编号。",
    );
  }
  const findings = overlapFindings(analysis);
  if (
    analysis.units.length > OVERLAP_LIMITS.units ||
    findings.length > OVERLAP_LIMITS.results
  )
    throw new Error("文稿概览超过已有分析上限，未展开部分来源。");
  const verdicts = new Map(
    validateOverlapMarks(analysis, marks).map((mark) => [
      mark.finding,
      mark.verdict,
    ]),
  );
  const order = new Map(documents.map((id, index) => [id, index]));
  const tally = new Map<string, DocumentTally>();
  for (const id of documents)
    tally.set(id, {
      eligible: 0,
      units: new Set(),
      findings: new Set(),
      peers: new Set(),
    });
  const units = new Map<string, OverlapUnit>();
  for (const unit of analysis.units) {
    const document = tally.get(unit.document);
    if (!document || units.has(unit.id))
      throw new Error("分析的位置编号不属于概览文稿，未遗漏该位置继续计数。");
    document.eligible++;
    units.set(unit.id, unit);
  }
  const inventories = new Map<string, Inventory>();
  function inventory(id: string): Inventory {
    const cached = inventories.get(id);
    if (cached) return cached;
    const family = overlapFamily(analysis, id),
      result: Inventory = new Map();
    const seen = new Set<string>();
    for (const key of family.units) {
      const unit = units.get(key);
      if (!unit || seen.has(key) || unit.normalized !== family.normalized)
        throw new Error("文字组位置清单与分析不一致，未输出部分文稿对。");
      seen.add(key);
      const list = result.get(unit.document) ?? [];
      list.push(unit);
      result.set(unit.document, list);
    }
    inventories.set(id, result);
    return result;
  }
  const cells = new Map<string, OverlapDocumentCell>(),
    cellFindings = new Map<string, Set<string>>();
  function register(
    finding: OverlapFinding,
    from: string,
    to: string,
    a: readonly OverlapUnit[],
    b: readonly OverlapUnit[],
    pairs: number,
  ) {
    if (
      !pairs ||
      (analysis.policy.scope === "cross-document" && from === to) ||
      (analysis.policy.scope === "within-document" && from !== to)
    )
      return;
    const [left, right] =
        order.get(from)! <= order.get(to)! ? [from, to] : [to, from],
      id = `p:${left}:${right}`;
    let cell = cells.get(id);
    if (!cell) {
      cell = {
        id,
        left,
        right,
        exactPairs: 0,
        nearPairs: 0,
        findings: [],
        unreviewed: 0,
        intentional: 0,
        followUp: 0,
      };
      cells.set(id, cell);
      cellFindings.set(id, new Set());
    }
    if (finding.kind === "exact") cell.exactPairs += pairs;
    else cell.nearPairs += pairs;
    const included = cellFindings.get(id)!;
    if (!included.has(finding.id)) {
      included.add(finding.id);
      cell.findings.push(finding.id);
      const verdict = verdicts.get(finding.id);
      if (verdict === "intentional") cell.intentional++;
      else if (verdict === "follow-up") cell.followUp++;
      else cell.unreviewed++;
    }
    for (const list of [a, b])
      for (const unit of list) tally.get(unit.document)!.units.add(unit.id);
    const first = tally.get(from)!,
      second = tally.get(to)!;
    first.findings.add(finding.id);
    second.findings.add(finding.id);
    if (from !== to) {
      first.peers.add(to);
      second.peers.add(from);
    }
  }
  for (const finding of findings) {
    if (!Number.isSafeInteger(finding.pairs) || finding.pairs < 1)
      throw new Error("候选配对计数无效，未补猜文稿关系。");
    if (finding.kind === "exact") {
      const byDocument = [...inventory(finding.family)];
      for (let first = 0; first < byDocument.length; first++)
        for (let second = first; second < byDocument.length; second++) {
          const [from, a] = byDocument[first]!,
            [to, b] = byDocument[second]!;
          const pairs =
            first === second
              ? (a.length * (a.length - 1)) / 2
              : a.length * b.length;
          register(finding, from, to, a, b, pairs);
        }
    } else {
      for (const [from, a] of inventory(finding.left))
        for (const [to, b] of inventory(finding.right))
          register(finding, from, to, a, b, a.length * b.length);
    }
  }
  const result = [...cells.values()].sort(
    (a, b) =>
      order.get(a.left)! - order.get(b.left)! ||
      order.get(a.right)! - order.get(b.right)!,
  );
  const pairs = result.reduce(
    (total, cell) => total + cell.exactPairs + cell.nearPairs,
    0,
  );
  if (pairs !== findings.reduce((total, finding) => total + finding.pairs, 0))
    throw new Error("文稿对总配对数与原分析不一致，未展示不完整关系。");
  const summaries = documents.map((id) => {
    const document = tally.get(id)!;
    if (document.units.size > document.eligible)
      throw new Error("概览位置数量超过合格单元，未输出误导的覆盖比例。");
    return {
      id,
      eligible: document.eligible,
      listed: document.units.size,
      findings: document.findings.size,
      unreviewed: [...document.findings].filter(
        (finding) => !verdicts.has(finding),
      ).length,
      peers: [...document.peers].sort((a, b) => order.get(a)! - order.get(b)!),
    };
  });
  return sealDocumentMap({
    witness: analysis,
    documents: summaries,
    cells: result,
    pairs,
  });
}

export function overlapMapCells(
  map: OverlapDocumentMap,
  filter: { document: string; order: "source" | "pairs" | "unreviewed" },
): OverlapDocumentCell[] {
  if (
    !filter ||
    Object.keys(filter).sort().join(",") !== "document,order" ||
    !["source", "pairs", "unreviewed"].includes(filter.order) ||
    (filter.document !== "all" &&
      !map.documents.some((document) => document.id === filter.document))
  )
    throw new Error("概览筛选无效，没有转为显示其他文稿对。");
  const result = map.cells.filter(
    (cell) =>
      filter.document === "all" ||
      cell.left === filter.document ||
      cell.right === filter.document,
  );
  const sourceOrder = new Map(map.cells.map((cell, index) => [cell.id, index]));
  if (filter.order !== "source")
    result.sort((a, b) => {
      const difference =
        filter.order === "pairs"
          ? b.exactPairs + b.nearPairs - a.exactPairs - a.nearPairs
          : b.unreviewed - a.unreviewed;
      return difference || sourceOrder.get(a.id)! - sourceOrder.get(b.id)!;
    });
  return result;
}

function currentCell(
  analysis: OverlapAnalysis,
  map: OverlapDocumentMap,
  pair: string,
): OverlapDocumentCell {
  if (map.witness !== analysis)
    throw new Error("文稿对概览的分析已经变化，旧概览失效。");
  const cell = map.cells.find((cell) => cell.id === pair);
  if (!cell) throw new Error("该文稿对不在当前已列候选中，不猜测其他文稿对。");
  return cell;
}

/** Main-list filters affect only the view; global findings, marks and the report stay untouched. */
export function overlapMapRows(
  analysis: OverlapAnalysis,
  map: OverlapDocumentMap,
  pair: string,
  rows: readonly OverlapReviewRow[],
): OverlapReviewRow[] {
  const cell = currentCell(analysis, map, pair),
    owned = new Set(overlapFindings(analysis)),
    seen = new Set<string>();
  for (const row of rows) {
    if (!owned.has(row.finding) || seen.has(row.finding.id))
      throw new Error(
        "候选列表不属于当前分析或含重复项，未应用部分文稿对筛选。",
      );
    seen.add(row.finding.id);
  }
  const allowed = new Set(cell.findings);
  return rows.filter((row) => allowed.has(row.finding.id));
}

/** Both near-family orientations remain selectable; same-source repeated occurrences stay independent. */
export function overlapMapOccurrences(
  analysis: OverlapAnalysis,
  map: OverlapDocumentMap,
  pair: string,
  finding: string,
  side: "left" | "right",
  left: string | null = null,
): OverlapUnit[] {
  const cell = currentCell(analysis, map, pair);
  if (!cell.findings.includes(finding))
    throw new Error("该候选不属于所选文稿对，未打开其他位置。");
  const item = overlapFindings(analysis).find((item) => item.id === finding)!;
  const rightFamily = overlapFamily(
    analysis,
    item.kind === "exact" ? item.family : item.right,
  );
  const counts = new Map(rightFamily.documents);
  const partner = (document: string) =>
    document === cell.left
      ? cell.right
      : document === cell.right
        ? cell.left
        : null;
  const from = overlapOccurrences(analysis, finding, "left").filter((unit) => {
    const target = partner(unit.document);
    return (
      target !== null &&
      (counts.get(target) ?? 0) >
        (item.kind === "exact" && target === unit.document ? 1 : 0)
    );
  });
  if (side === "left") return from;
  const selected = from.find((unit) => unit.id === left);
  if (side !== "right" || !selected)
    throw new Error("左侧位置不属于当前文稿对，没有退回其他文稿。");
  const target = partner(selected.document);
  const result = overlapOccurrences(
    analysis,
    finding,
    "right",
    selected.id,
  ).filter((unit) => unit.document === target);
  if (!result.length)
    throw new Error("所选文稿对没有可核对的右侧位置，未回退到其他文稿。");
  return result;
}
