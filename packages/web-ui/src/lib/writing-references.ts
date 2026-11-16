import { sanitizeEditorHref } from "./editor-href.ts";
import { writingRecord, WRITING_NODE_LIMIT, WRITING_TEXT_LIMIT, type WritingNode, type WritingPath } from "./writing-document.ts";
import type { WritingDraft } from "./writing-session.ts";

export type WritingReferenceIssue = "unsafe-url" | "empty-label" | "insecure-http" | "ambiguous-label" | "label-truncated";
export type WritingReferenceGroup = {
  kind: "link" | "image";
  url: string | null;
  external: boolean;
  labels: string[];
  issues: WritingReferenceIssue[];
  occurrences: { path: WritingPath; label: string; caption: string }[];
};
export type WritingReferenceAudit = { groups: WritingReferenceGroup[]; total: number; limited: boolean };

/** Inventory only: never performs a HEAD/GET request or claims an asset belongs to the author. */
export function auditWritingReferences(draft: WritingDraft): WritingReferenceAudit {
  const audit: WritingReferenceAudit = { groups: [], total: 0, limited: false };
  const byAddress = new Map<string, WritingReferenceGroup>();
  const labels = new Map<string, Set<WritingReferenceGroup>>();
  let visited = 0;
  let characters = 0;
  const enter = (depth: number) => {
    if (++visited > WRITING_NODE_LIMIT || depth > 8 || characters > WRITING_TEXT_LIMIT || audit.total >= 1000) {
      audit.limited = true;
      return false;
    }
    return true;
  };
  const text = (node: WritingNode, depth: number): string => {
    if (!enter(depth)) return "";
    if (typeof node.text === "string") {
      characters += node.text.length;
      return node.text.slice(0, 4000);
    }
    if (node.type === "linebreak") return "\n";
    if (!Array.isArray(node.children)) return "";
    const pieces: string[] = [];
    let size = 0;
    for (let index = 0; index < node.children.length && !audit.limited; index++) {
      const record = writingRecord(node.children[index]);
      const piece = record ? text(record, depth + 1) : "";
      pieces.push(piece);
      size += piece.length;
      if (size >= 4000) break;
    }
    return pieces.join("").slice(0, 4000);
  };
  const add = (node: WritingNode, path: WritingPath, kind: WritingReferenceGroup["kind"]) => {
    const raw = kind === "image" ? node.src : node.url;
    let url: string | null = null;
    let external = false;
    let insecure = false;
    if (typeof raw === "string" && raw.length <= 2048 && sanitizeEditorHref(raw) === raw) {
      external = !raw.startsWith("/");
      if (external) {
        const parsed = new URL(raw);
        insecure = parsed.protocol === "http:";
        url = parsed.href;
      } else url = raw;
    }
    const label = kind === "image" ? typeof node.alt === "string" ? node.alt : "" : text(node, path.length);
    const shown = Array.from(label.trim()).slice(0, 180).join("");
    const caption = kind === "image" && typeof node.caption === "string" ? Array.from(node.caption).slice(0, 180).join("") : "";
    const key = `${kind}:${url ?? `invalid-${audit.total}`}`;
    let group = byAddress.get(key);
    if (!group) {
      if (audit.groups.length >= 200) { audit.limited = true; return; }
      group = { kind, url, external, labels: [], issues: [], occurrences: [] };
      byAddress.set(key, group);
      audit.groups.push(group);
    }
    const warn = (issue: WritingReferenceIssue) => { if (!group.issues.includes(issue)) group.issues.push(issue); };
    if (url === null) warn("unsafe-url");
    if (!shown) warn("empty-label");
    if (insecure) warn("insecure-http");
    if (shown.length < label.trim().length) warn("label-truncated");
    if (shown && !group.labels.includes(shown)) group.labels.push(shown);
    group.occurrences.push({ path, label: shown, caption });
    audit.total++;
    if (kind === "link" && shown && url !== null) {
      const normalized = label.trim().normalize("NFKC").replace(/\s+/gu, " ").toLocaleLowerCase();
      const uses = labels.get(normalized) ?? new Set<WritingReferenceGroup>();
      uses.add(group);
      labels.set(normalized, uses);
    }
  };
  const visit = (input: unknown, path: WritingPath): void => {
    if (!enter(path.length)) return;
    const node = writingRecord(input);
    if (!node || node.type === "code") return;
    if (node.type === "image") { add(node, path, "image"); return; }
    if (node.type === "link" || node.type === "autolink") { add(node, path, "link"); return; }
    if (Array.isArray(node.children)) {
      for (let index = 0; index < node.children.length && !audit.limited; index++) visit(node.children[index], [...path, index]);
    }
  };
  const roots = draft.editorState?.root.children ?? [];
  for (let index = 0; index < roots.length && !audit.limited; index++) visit(roots[index], [index]);
  for (const uses of labels.values()) {
    if (uses.size < 2) continue;
    for (const group of uses) {
      if (!group.issues.includes("ambiguous-label")) group.issues.push("ambiguous-label");
    }
  }
  if (characters > WRITING_TEXT_LIMIT) audit.limited = true;
  return audit;
}
