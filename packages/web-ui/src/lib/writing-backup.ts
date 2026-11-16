import { sanitizeEditorHref } from "./editor-href.ts";
import { parseWorkType } from "./work-types.ts";
import { writingChildren, writingRecord, WRITING_NODE_LIMIT, WRITING_TEXT_LIMIT, type WritingNode } from "./writing-document.ts";
import { writingSnapshotKey, type WritingDraft } from "./writing-session.ts";

export const MAX_WRITING_BACKUP_BYTES = 2 * 1024 * 1024;
export const WRITING_FIELDS = ["title", "summary", "locale", "workType", "editorState"] as const;
export type WritingField = typeof WRITING_FIELDS[number];
export type WritingBackup = { format: "no-wave-writing-backup"; version: 1; createdAt: string; draft: WritingDraft };
export type WritingRestore = { source: string; backup: WritingBackup; changedFields: WritingField[]; remoteImages: number };
const ELEMENT_FIELDS = ["type", "version", "children", "direction", "format", "indent", "textFormat", "textStyle"];
const TEXT_FIELDS = ["type", "version", "text", "format", "detail", "mode", "style"];
const INVALID_TEXT = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\p{Cs}]/u;
const MEDIA_PATH = /^\/api\/media\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function fail(message: string): never { throw new Error(`无法读取文稿备份：${message}`); }
function object(value: unknown, keys: readonly string[]): WritingNode {
  const record = writingRecord(value);
  if (!record || Object.keys(record).some(key => !keys.includes(key))) fail("包含未知字段或无效结构。");
  return record;
}
function string(value: unknown, max: number): string {
  if (typeof value !== "string" || value.length > max || INVALID_TEXT.test(value)) fail("文字字段无效或超出长度限制。");
  return value;
}
function safeUrl(value: unknown, image = false): string {
  const raw = string(value, 2048);
  if (sanitizeEditorHref(raw) !== raw || (image && raw.startsWith("/") && !MEDIA_PATH.test(raw))) fail("含不安全或不支持的链接地址。");
  return raw;
}
function envelope(node: WritingNode): unknown[] {
  if (node.version !== 1 || !Array.isArray(node.children) ||
      (node.direction !== undefined && node.direction !== null && node.direction !== "ltr") ||
      (node.format !== undefined && node.format !== "" && node.format !== 0) ||
      (node.indent !== undefined && node.indent !== 0) ||
      (node.textStyle !== undefined && node.textStyle !== "") ||
      (node.textFormat !== undefined && (!Number.isInteger(node.textFormat) || Number(node.textFormat) < 0 || Number(node.textFormat) > 31))) {
    fail("含无法安全保留的元素格式。");
  }
  return node.children;
}

/** Local snapshot validation, before any registered Lexical importJSON gets to see a file. */
export function validateWritingState(value: unknown): NonNullable<WritingDraft["editorState"]> {
  const state = object(value, ["root"]);
  let nodes = 0, textSize = 0;
  type Context = "root" | "block" | "item" | "inline" | "link" | "code";
  const allowed: Record<Context, readonly string[]> = {
    root: ["root"], block: ["paragraph", "heading", "quote", "list", "code", "image"],
    item: ["listitem"], inline: ["text", "link", "linebreak", "tab"], link: ["text"],
    code: ["text", "code-highlight", "linebreak", "tab"],
  };
  const visit = (input: unknown, context: Context, depth: number): void => {
    if (++nodes > WRITING_NODE_LIMIT || depth > 5) fail("节点过多或嵌套过深。");
    const node = writingRecord(input);
    if (!node || typeof node.type !== "string" || !allowed[context].includes(node.type) || node.version !== 1) fail("含未知版本或未注册的内容节点。");
    const type = node.type;
    if (["text", "code-highlight", "tab"].includes(type)) {
      object(node, type === "code-highlight" ? [...TEXT_FIELDS, "highlightType"] : TEXT_FIELDS);
      const text = string(node.text, WRITING_TEXT_LIMIT);
      textSize += text.length;
      if (textSize > WRITING_TEXT_LIMIT || (type === "tab" && text !== "\t")) fail("正文过长或制表节点无效。");
      if ((node.format !== undefined && (!Number.isInteger(node.format) || Number(node.format) < 0 || Number(node.format) > 31)) ||
          (node.detail !== undefined && node.detail !== 0) || (node.mode !== undefined && node.mode !== "normal") ||
          (node.style !== undefined && node.style !== "")) fail("含不能安全保留的文字格式。");
      if (context === "code" && node.format !== undefined && node.format !== 0) fail("代码不能含富文本格式。");
      if (node.highlightType !== undefined && node.highlightType !== null && !/^[\w-]{1,64}$/.test(string(node.highlightType, 64))) fail("代码高亮类型无效。");
      return;
    }
    if (type === "linebreak") { object(node, ["type", "version"]); return; }
    if (type === "image") {
      object(node, ["type", "version", "src", "alt", "caption"]);
      safeUrl(node.src, true);
      string(node.alt, 500);
      if (node.caption !== undefined) string(node.caption, 1000);
      return;
    }
    const extra: Record<string, string[]> = { heading: ["tag"], list: ["listType", "start", "tag"], listitem: ["checked", "value"],
      link: ["url", "rel", "target", "title"], code: ["language", "theme"] };
    object(node, [...ELEMENT_FIELDS, ...(extra[type] ?? [])]);
    const children = envelope(node);
    if (type === "root") {
      if (children.length < 1 || children.length > 200) fail("正文需有 1–200 个内容块。");
    } else if (type === "heading" && !/^h[2-4]$/.test(String(node.tag))) fail("标题级别无效。");
    else if (type === "list") {
      if ((node.listType !== "bullet" && node.listType !== "number") || node.tag !== (node.listType === "number" ? "ol" : "ul") ||
          (node.start !== undefined && node.start !== 1) || children.length < 1 || children.length > 100) fail("仅支持从 1 开始的标准列表，最多 100 项。");
    } else if (type === "listitem") {
      if ((node.checked !== undefined && node.checked !== null) ||
          (node.value !== undefined && (!Number.isSafeInteger(node.value) || Number(node.value) < 1))) fail("列表项元数据无效。");
    } else if (type === "link") {
      safeUrl(node.url);
      if (!children.length || ["rel", "target", "title"].some(key => node[key] !== undefined && node[key] !== null && node[key] !== "")) fail("链接元数据无法保留。");
    } else if (type === "code") {
      if (node.language !== undefined && node.language !== null && !/^[\w+#.\-]{0,40}$/.test(string(node.language, 40))) fail("代码语言无效。");
      if (node.theme !== undefined && node.theme !== null && node.theme !== "") fail("不支持自定义代码样式。");
    }
    const childContext: Context = type === "root" ? "block" : type === "list" ? "item" : type === "code" ? "code" : type === "link" ? "link" : "inline";
    children.forEach(child => visit(child, childContext, depth + 1));
  };
  visit(state.root, "root", 0);
  if (JSON.stringify(state).length > 1_000_000) fail("编辑快照超过序列化大小限制。");
  // All reachable fields have been checked; clone to detach the file from the preview.
  return structuredClone(state) as NonNullable<WritingDraft["editorState"]>;
}

function pickDraft(draft: WritingDraft): WritingDraft {
  return { title: draft.title, summary: draft.summary, locale: draft.locale, workType: draft.workType, editorState: draft.editorState };
}

export function parseWritingBackup(text: string): WritingBackup {
  if (!text.length || text.length > MAX_WRITING_BACKUP_BYTES || new TextEncoder().encode(text).byteLength > MAX_WRITING_BACKUP_BYTES) fail("文件必须大于 0 且不超过 2 MiB。");
  let value: unknown;
  try {
    value = JSON.parse(text.replace(/^\ufeff/, ""), (key: string, item: unknown) => {
      if (["__proto__", "constructor", "prototype"].includes(key)) fail("包含不允许的字段。");
      return item;
    });
  } catch { fail("不是可识别的 JSON 文件。"); }
  const data = object(value, ["format", "version", "createdAt", "draft"]);
  if (data.format !== "no-wave-writing-backup" || data.version !== 1) fail("不是受支持的文稿备份版本。");
  const createdAt = string(data.createdAt, 40);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(createdAt) || !Number.isFinite(Date.parse(createdAt)) || new Date(createdAt).toISOString() !== createdAt) fail("备份时间无效。");
  const raw = object(data.draft, WRITING_FIELDS);
  const title = string(raw.title, 200), summary = string(raw.summary, 2000);
  if (raw.locale !== "zh-CN" && raw.locale !== "en" && raw.locale !== "zh-TW") fail("作品语言无效。");
  const workType = typeof raw.workType === "string" ? parseWorkType(raw.workType) : null;
  if (!workType) fail("作品类型无效。");
  return { format: "no-wave-writing-backup", version: 1, createdAt, draft: { title, summary, locale: raw.locale, workType, editorState: validateWritingState(raw.editorState) } };
}

export function createWritingBackup(draft: WritingDraft, now = new Date()): string {
  if (!draft.editorState) throw new Error("编辑器尚未初始化，暂不能备份。");
  const text = JSON.stringify({ format: "no-wave-writing-backup", version: 1, createdAt: now.toISOString(), draft: pickDraft(draft) }, null, 2) + "\n";
  parseWritingBackup(text);
  return text;
}

export function previewWritingRestore(current: WritingDraft, backup: WritingBackup): WritingRestore {
  return { source: writingSnapshotKey(current), backup: structuredClone(backup),
    changedFields: WRITING_FIELDS.filter(field => JSON.stringify(current[field]) !== JSON.stringify(backup.draft[field])),
    remoteImages: (backup.draft.editorState?.root.children ?? []).filter(node => node.type === "image" && typeof node.src === "string" && !node.src.startsWith("/")).length };
}

export function restoreWritingFields(current: WritingDraft, preview: WritingRestore, fields: readonly WritingField[]): WritingDraft {
  if (writingSnapshotKey(current) !== preview.source) throw new Error("恢复预览已过期，请重新选择备份文件。");
  if (!fields.length || new Set(fields).size !== fields.length || fields.some(field => !WRITING_FIELDS.includes(field))) throw new Error("请选择有效且不重复的恢复字段。");
  const source = preview.backup.draft;
  if (fields.includes("locale") && source.locale === "zh-TW" && current.locale !== "zh-TW") throw new Error("历史繁体版本只能在原语言版本中保留；请取消选择语言字段。");
  if (fields.includes("workType") && source.workType === "serial" && current.workType !== "serial") throw new Error("连载是已停用类型；请取消选择作品类型字段。");
  const next = pickDraft(current);
  for (const field of fields) Object.assign(next, { [field]: structuredClone(source[field]) });
  return next;
}

function markdownText(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/[\\`*_{}\[\]()#+.!|~\-]/g, "\\$&");
}
function markdownUrl(value: unknown): string | null {
  if (typeof value !== "string" || sanitizeEditorHref(value) !== value) return null;
  return value.replace(/[()<>]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}
function backtickFence(text: string, minimum: number): string {
  let length = minimum;
  for (const run of text.matchAll(/`+/g)) length = Math.max(length, run[0].length + 1);
  return "`".repeat(length);
}
function inlineText(node: WritingNode, markdown: boolean): string {
  if (node.type === "linebreak") return markdown ? "  \n" : "\n";
  if (node.type === "tab") return "\t";
  if (node.type === "text" || node.type === "code-highlight") {
    const raw = typeof node.text === "string" ? node.text : "";
    if (!markdown || !raw) return raw;
    const format = typeof node.format === "number" ? node.format : 0;
    if (format & 16) {
      const fence = backtickFence(raw, 1);
      return `${fence} ${raw} ${fence}`;
    }
    let text = markdownText(raw);
    if (format & 1) text = `**${text}**`;
    if (format & 2) text = `*${text}*`;
    if (format & 4) text = `~~${text}~~`;
    return text;
  }
  const text = writingChildren(node).map(child => inlineText(child, markdown)).join("");
  const url = markdown && (node.type === "link" || node.type === "autolink") ? markdownUrl(node.url) : null;
  return url ? `[${text}](${url})` : text;
}

/** Interchange exports are text downloads, never rendered HTML and never an import format. */
export function exportWritingText(draft: WritingDraft, format: "text" | "markdown"): string {
  if (!draft.editorState) throw new Error("编辑器尚未初始化。");
  const markdown = format === "markdown";
  const blocks = draft.editorState.root.children.map(node => {
    if (node.type === "image") {
      const alt = typeof node.alt === "string" ? node.alt : "";
      const caption = typeof node.caption === "string" ? node.caption : "";
      const url = markdown ? markdownUrl(node.src) : null;
      return (url ? `![${markdownText(alt)}](${url})` : `[图片：${alt}]`) + (caption ? `\n${markdown ? markdownText(caption) : caption}` : "");
    }
    if (node.type === "code") {
      const code = inlineText(node, false);
      if (!markdown) return code;
      const fence = backtickFence(code, 3);
      const language = typeof node.language === "string" && /^[\w+#.\-]{1,40}$/.test(node.language) ? node.language : "text";
      return `${fence}${language}\n${code}\n${fence}`;
    }
    if (node.type === "list") return writingChildren(node).map((item, index) => `${node.listType === "number" ? `${index + 1}.` : "-"} ${inlineText(item, markdown)}`).join("\n");
    const text = inlineText(node, markdown);
    if (markdown && node.type === "heading") return `${"#".repeat(/^h[2-4]$/.test(String(node.tag)) ? Number(String(node.tag).slice(1)) : 2)} ${text}`;
    if (node.type === "quote") return text.split("\n").map(line => `> ${line}`).join("\n");
    if (!["paragraph", "heading", "quote"].includes(String(node.type))) return `（不支持的内容块：${String(node.type)}）`;
    return text;
  });
  const title = markdown ? `# ${markdownText(draft.title)}` : draft.title;
  return [title, ...blocks].join("\n\n") + "\n";
}

export function writingDownloadName(title: string, extension: "json" | "txt" | "md", now = new Date()): string {
  // Portable ASCII avoids browsers/filesystems dropping non-ASCII download
  // names to a bare "download"; the full original title stays inside the file.
  const safe = title.normalize("NFKD").replace(/\p{M}/gu, "").replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "no-wave-manuscript";
  return `${safe}-${now.toISOString().slice(0, 10)}.${extension}`;
}
