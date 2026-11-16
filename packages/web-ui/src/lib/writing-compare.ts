import { inspectWriting, type WritingNode } from "./writing-document.ts";
import { writingDraftKey, type WritingDraft } from "./writing-session.ts";

export type WritingTextDifference = { prefix: string; removed: string; inserted: string; suffix: string; truncated: boolean; textEqual: boolean };
export type WritingBlockDifference = {
  kind: "same" | "added" | "removed" | "changed" | "moved";
  currentIndex: number | null;
  backupIndex: number | null;
  currentText: string;
  backupText: string;
  blockType: string;
  formatChanged: boolean;
  difference: WritingTextDifference;
};
export type WritingComparison = {
  rows: WritingBlockDifference[];
  fields: { field: "title" | "summary" | "locale" | "workType"; difference: WritingTextDifference }[];
  counts: Record<WritingBlockDifference["kind"], number>;
  limited: boolean;
};
const segmenter = typeof Intl.Segmenter === "function" ? new Intl.Segmenter(undefined, { granularity: "grapheme" }) : null;

function excerptUnits(text: string, limit: number): { units: string[]; truncated: boolean } {
  const units: string[] = [];
  let size = 0;
  const input = segmenter ? segmenter.segment(text) : Array.from(text, segment => ({ segment }));
  for (const { segment } of input) {
    if (size + segment.length > limit) return { units, truncated: true };
    units.push(segment);
    size += segment.length;
  }
  return { units, truncated: false };
}

/** Bounded, grapheme-safe minimal changed span; never interpreted as HTML or used as an edit instruction. */
export function writingTextDifference(before: string, after: string): WritingTextDifference {
  const a = excerptUnits(before, 1200);
  const b = excerptUnits(after, 1200);
  let head = 0;
  while (head < a.units.length && head < b.units.length && a.units[head] === b.units[head]) head++;
  let tail = 0;
  // A truncated suffix is not the real end of a document, so do not imply it is.
  if (!a.truncated && !b.truncated) {
    while (tail < a.units.length - head && tail < b.units.length - head && a.units[a.units.length - 1 - tail] === b.units[b.units.length - 1 - tail]) tail++;
  }
  return {
    prefix: a.units.slice(0, head).join(""),
    removed: a.units.slice(head, a.units.length - tail).join(""),
    inserted: b.units.slice(head, b.units.length - tail).join(""),
    suffix: tail ? a.units.slice(-tail).join("") : "",
    truncated: a.truncated || b.truncated,
    textEqual: before === after,
  };
}

function blockDraft(draft: WritingDraft, node: WritingNode): WritingDraft {
  return { ...draft, title: "", summary: "", locale: "zh-CN", workType: "other", editorState: {
    root: { type: "root", version: 1, children: [node], direction: null, indent: 0, format: "" },
  } };
}
function blockText(draft: WritingDraft, node: WritingNode): string {
  if (node.type === "image") {
    const alt = typeof node.alt === "string" ? node.alt : "";
    const caption = typeof node.caption === "string" ? node.caption : "";
    return `[图片] ${alt}${caption ? `\n${caption}` : ""}`;
  }
  return inspectWriting(blockDraft(draft, node)).blocks.map(block => block.text).join("\n");
}

/** Ordered LCS over at most 200 top-level blocks; exact keys retain marks and links. */
export function compareWritingDrafts(current: WritingDraft, backup: WritingDraft): WritingComparison {
  const result: WritingComparison = { rows: [], fields: [], counts: { same: 0, added: 0, removed: 0, changed: 0, moved: 0 }, limited: false };
  for (const field of ["title", "summary", "locale", "workType"] as const) {
    if (current[field] !== backup[field]) result.fields.push({ field, difference: writingTextDifference(current[field], backup[field]) });
  }
  const before = current.editorState?.root.children ?? [];
  const after = backup.editorState?.root.children ?? [];
  if (before.length > 200 || after.length > 200 || inspectWriting(current).limited || inspectWriting(backup).limited) {
    result.limited = true;
    return result;
  }
  const beforeKeys = before.map(node => writingDraftKey(blockDraft(current, node)));
  const afterKeys = after.map(node => writingDraftKey(blockDraft(backup, node)));
  const width = after.length + 1;
  const table = new Uint16Array((before.length + 1) * width);
  for (let i = before.length - 1; i >= 0; i--) {
    for (let j = after.length - 1; j >= 0; j--) {
      table[i * width + j] = beforeKeys[i] === afterKeys[j]
        ? 1 + table[(i + 1) * width + j + 1]!
        : Math.max(table[(i + 1) * width + j]!, table[i * width + j + 1]!);
    }
  }
  const row = (kind: WritingBlockDifference["kind"], i: number | null, j: number | null): WritingBlockDifference => {
    const currentText = i === null ? "" : blockText(current, before[i]!);
    const backupText = j === null ? "" : blockText(backup, after[j]!);
    return { kind, currentIndex: i, backupIndex: j, currentText, backupText,
      blockType: String(j !== null ? after[j]!.type : before[i!]!.type),
      formatChanged: i !== null && j !== null && currentText === backupText && beforeKeys[i] !== afterKeys[j],
      difference: writingTextDifference(currentText, backupText) };
  };
  const ordered: WritingBlockDifference[] = [];
  let i = 0, j = 0;
  while (i < before.length || j < after.length) {
    if (i < before.length && j < after.length && beforeKeys[i] === afterKeys[j]) {
      ordered.push(row("same", i++, j++));
    } else if (i < before.length && (j === after.length || table[(i + 1) * width + j]! > table[i * width + j + 1]!)) {
      ordered.push(row("removed", i++, null));
    } else ordered.push(row("added", null, j++));
  }
  // Match moves once, in original order. Duplicate paragraphs remain one-to-one.
  const removals = new Map<string, WritingBlockDifference[]>();
  for (const item of ordered) {
    if (item.kind !== "removed") continue;
    const key = beforeKeys[item.currentIndex!]!;
    const candidates = removals.get(key) ?? [];
    candidates.push(item);
    removals.set(key, candidates);
  }
  const movedRemovals = new Set<WritingBlockDifference>();
  const moved = new Map<WritingBlockDifference, WritingBlockDifference>();
  for (const item of ordered) {
    if (item.kind !== "added") continue;
    const previous = removals.get(afterKeys[item.backupIndex!]!)?.shift();
    if (previous) {
      movedRemovals.add(previous);
      moved.set(item, row("moved", previous.currentIndex, item.backupIndex));
    }
  }
  const changes = ordered.filter(item => !movedRemovals.has(item)).map(item => moved.get(item) ?? item);
  const appendGroup = (group: WritingBlockDifference[]) => {
    const removed = group.filter(item => item.kind === "removed");
    const added = group.filter(item => item.kind === "added");
    let left = 0, right = 0;
    while (left < removed.length || right < added.length) {
      const a = removed[left], b = added[right];
      if (a && b && a.blockType === b.blockType) {
        result.rows.push(row("changed", a.currentIndex, b.backupIndex));
        left++; right++;
      } else if (a) { result.rows.push(a); left++; }
      else { result.rows.push(b!); right++; }
    }
  };
  let group: WritingBlockDifference[] = [];
  for (const item of changes) {
    if (item.kind === "added" || item.kind === "removed") group.push(item);
    else {
      appendGroup(group);
      group = [];
      result.rows.push(item);
    }
  }
  appendGroup(group);
  for (const item of result.rows) result.counts[item.kind]++;
  return result;
}
