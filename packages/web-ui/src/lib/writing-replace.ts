import { inspectWriting, writingNodeAt, WRITING_TEXT_LIMIT, type WritingPath } from "./writing-document.ts";
import { writingSnapshotKey, type WritingDraft } from "./writing-session.ts";

export type WritingMatch = { id: number; path: WritingPath; start: number; end: number; text: string; before: string; after: string };
export type WritingSearchScope = "all" | "paragraphs" | "headings" | "quotes" | "lists";
export type WritingReplacement = {
  source: string;
  query: string;
  replacement: string;
  caseSensitive: boolean;
  scope: WritingSearchScope;
  matches: WritingMatch[];
  more: boolean;
  error: string | null;
};
const INVALID_TEXT = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\p{Cs}]/u;
const UNSAFE_ISSUES = new Set(["unsupported-node", "unsupported-layout", "unsupported-format", "heading-level"]);

/** Escaped literal Unicode regexp: no user-provided regular expression or offset-losing fold. */
export function previewWritingReplacement(draft: WritingDraft, query: string, replacement: string, caseSensitive = true, scope: WritingSearchScope = "all"): WritingReplacement {
  const plan: WritingReplacement = { source: writingSnapshotKey(draft), query, replacement, caseSensitive, scope, matches: [], more: false, error: null };
  if (!query || query.length > 200 || replacement.length > 1000 || INVALID_TEXT.test(query + replacement)) {
    plan.error = "查找需为 1–200 字符，替换最多 1000 字符，且不能含无效字符。";
    return plan;
  }
  const inspection = inspectWriting(draft);
  if (inspection.limited || inspection.issues.some(issue => UNSAFE_ISSUES.has(issue.code))) {
    plan.error = "正文超出检查范围或含不支持的结构，请先处理文稿检查中的问题。";
    return plan;
  }
  const expression = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), caseSensitive ? "gu" : "giu");
  for (const block of inspection.blocks) {
    const scopes: Record<WritingSearchScope, readonly string[]> = { all: ["paragraph", "heading", "quote", "listitem"], paragraphs: ["paragraph"], headings: ["heading"], quotes: ["quote"], lists: ["listitem"] };
    if (!block.searchable || !scopes[scope]?.includes(block.kind)) continue;
    expression.lastIndex = 0;
    for (let hit = expression.exec(block.text); hit; hit = expression.exec(block.text)) {
      const start = hit.index;
      const end = start + hit[0].length;
      if (block.runs.some(run => run.boundary && run.start < end && run.end > start)) continue;
      if (plan.matches.length === 200) { plan.more = true; return plan; }
      plan.matches.push({ id: plan.matches.length, path: block.path, start, end, text: hit[0],
        before: block.text.slice(Math.max(0, start - 32), start), after: block.text.slice(end, end + 32) });
    }
  }
  return plan;
}

/** Build a new state, retaining all unselected text/format/link/image metadata. */
export function applyWritingReplacement(current: WritingDraft, preview: WritingReplacement, selected: readonly number[]): WritingDraft {
  if (writingSnapshotKey(current) !== preview.source) throw new Error("预览已过期，请重新预览后再替换。");
  if (!selected.length || selected.length > 200 || new Set(selected).size !== selected.length ||
      selected.some(id => !Number.isSafeInteger(id) || id < 0 || id >= preview.matches.length)) throw new Error("请选择有效且不重复的匹配项。");
  // Recompute the witnesses rather than trusting locations held by a UI object.
  const plan = previewWritingReplacement(current, preview.query, preview.replacement, preview.caseSensitive, preview.scope);
  if (plan.error) throw new Error(plan.error);
  const matches = selected.map(id => plan.matches[id]).filter((match): match is WritingMatch => match !== undefined).sort((a, b) => a.id - b.id);
  if (matches.length !== selected.length) throw new Error("匹配选择已失效，请重新预览。");
  const inspection = inspectWriting(current);
  const originalSize = inspection.blocks.reduce((sum, block) => sum + block.text.length, 0);
  if (originalSize + matches.reduce((sum, match) => sum + preview.replacement.length - match.text.length, 0) > WRITING_TEXT_LIMIT) {
    throw new Error("替换后的正文超过 500000 字符，请缩小选择范围。");
  }
  const next = structuredClone(current);
  if (!next.editorState) throw new Error("编辑器尚未初始化。");
  for (const match of matches.reverse()) {
    const block = inspection.blocks.find(item => item.path.join(".") === match.path.join("."));
    if (!block || block.text.slice(match.start, match.end) !== match.text) throw new Error("匹配选择已失效，请重新预览。");
    let first = true;
    for (const run of block.runs) {
      if (run.end <= match.start || run.start >= match.end) continue;
      const node = writingNodeAt(next.editorState.root, run.path);
      if (!node || node.type !== "text" || typeof node.text !== "string" || run.boundary) throw new Error("此处不支持安全替换，请调整正文后重试。");
      const start = Math.max(0, match.start - run.start);
      const end = Math.min(run.text.length, match.end - run.start);
      node.text = node.text.slice(0, start) + (first ? preview.replacement : "") + node.text.slice(end);
      first = false;
    }
  }
  return next;
}


export type WritingMatchAnchors = { anchor: { path: WritingPath; offset: number }; focus: { path: WritingPath; offset: number } };

/** Resolve a search witness into text-node offsets; navigation never guesses across changed nodes. */
export function writingMatchAnchors(draft: WritingDraft, match: WritingMatch): WritingMatchAnchors | null {
  const block = inspectWriting(draft).blocks.find(item => item.path.join(".") === match.path.join("."));
  if (!block || !block.searchable || !Number.isSafeInteger(match.start) || !Number.isSafeInteger(match.end) ||
      match.start < 0 || match.end <= match.start || block.text.slice(match.start, match.end) !== match.text) return null;
  const crossed = block.runs.filter(run => run.start < match.end && run.end > match.start);
  if (!crossed.length || crossed.some(run => run.boundary)) return null;
  const first = crossed[0]!, last = crossed[crossed.length - 1]!;
  return { anchor: { path: first.path, offset: match.start - first.start }, focus: { path: last.path, offset: match.end - last.start } };
}
