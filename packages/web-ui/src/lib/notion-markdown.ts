import { marked, type Token, type Tokens } from "marked";
import { Unzip, UnzipInflate } from "fflate";
import { NOTION_BUNDLE_MAX_BYTES, NOTION_BUNDLE_MAX_PAGES } from "./notion-import.ts";

type Entry = { name: string; text: string };
type Page = { id: string; properties: Record<string, unknown>; blocks: Record<string, unknown>[] };
export type MarkdownBundleResult = { bundle: Record<string, unknown>; pages: number; warnings: string[] };
const rich = (plain_text: string) => ({ plain_text });
const titleProp = (s: string) => ({ type: "title", title: [rich(s)] });
const textProp = (s: string) => ({ type: "rich_text", rich_text: [rich(s)] });
const pageId = (name: string) => /(?:^|\s)([a-f0-9]{32})(?:\.md)$/i.exec(name.split(/[\\/]/).pop() ?? "")?.[1]?.toLowerCase();
const canonical = (id: string) => `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`;

/** Parse only a leading run of known Notion properties: normal prose is never swallowed. */
function parseEntry(entry: Entry, warnings: string[]): Page | null {
  const lines = entry.text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").split("\n");
  const heading = /^#\s+(.+?)\s*#*\s*$/.exec(lines[0] ?? "");
  const id = pageId(entry.name);
  if (!heading) { warnings.push(`${entry.name}：缺少首行标题，已跳过。`); return null; }
  const basename = entry.name.split(/[\\/]/).pop() ?? "";
  if (!id && (!basename || basename.length > 120)) { warnings.push(`${entry.name}：文件名过长或无效，已跳过。`); return null; }
  if (!id) warnings.push(`${entry.name}：没有 Notion 页面 ID，使用文件名识别；重命名会视为新文章。`);
  const properties: Record<string, unknown> = { Name: titleProp(heading[1]!.trim()) };
  let i = 1;
  while (i < lines.length && !lines[i]!.trim()) i++;
  const known = new Set(["Date", "Excerpt", "FeaturedImage", "Published", "Rank", "Slug", "Tags", "English", "Parent item"]);
  let inProperties = false;
  for (; i < lines.length; i++) {
    const m = /^([^:]+):\s*(.*)$/.exec(lines[i]!);
    if (!m || (!inProperties && !known.has(m[1]!))) break;
    inProperties = true;
    if (!known.has(m[1]!)) { warnings.push(`${entry.name}：属性 ${m[1]} 未导入。`); continue; }
    const key = m[1]!; const raw = m[2]!;
    const value = raw.trim();
    if (key === "Slug" || key === "Excerpt") properties[key] = textProp(value);
    else if (key === "Published") {
      if (/^(yes|true)$/i.test(value)) properties[key] = { type: "checkbox", checkbox: true };
      else if (/^(no|false)$/i.test(value)) properties[key] = { type: "checkbox", checkbox: false };
      else warnings.push(`${entry.name}：无法识别 Published，按草稿处理。`);
    } else if (key === "Tags") properties[key] = { type: "multi_select", multi_select: value.split(",").map((name) => ({ name: name.trim() })).filter(({ name }) => name) };
    else if (key === "Date") {
      // Notion exports English month names without a timezone. Interpret a
      // calendar day as UTC, independent of the browser's local timezone.
      const dateOnly = /^[A-Za-z]+\s+\d{1,2},?\s+\d{4}$/.test(value);
      const date = Date.parse(dateOnly ? `${value} UTC` : value);
      if (Number.isFinite(date)) properties[key] = { type: "date", date: { start: new Date(date).toISOString() } };
      else warnings.push(`${entry.name}：日期无法识别，使用默认日期。`);
    } else if (key === "FeaturedImage" && value) properties[key] = { type: "files", files: [{ type: "external", external: { url: value } }] };
    else if ((key === "English" || key === "Parent item") && value) {
      let decoded = value; try { decoded = decodeURIComponent(value); } catch { /* keep original */ }
      const ids = [...decoded.matchAll(/\b([a-f0-9]{32})\.md\b/gi)].map((m) => ({ id: canonical(m[1]!.toLowerCase()) }));
      if (ids.length) properties[key] = { type: "relation", relation: ids };
      else warnings.push(`${entry.name}：未识别 ${key} 的页面链接。`);
    }
    // Rank is not used by the article model; it is optional and ignored.
  }
  const blocks: Record<string, unknown>[] = [];
  const block = (type: string, data: Record<string, unknown>) => blocks.push({ type, [type]: data });
  const plain = (tokens: readonly Token[]): string => tokens.map((t) => {
    if (t.type === "image") return t.text;
    if ("tokens" in t && Array.isArray(t.tokens)) return plain(t.tokens);
    return "text" in t && typeof t.text === "string" ? t.text : "";
  }).join("");
  const inline = (tokens: readonly Token[], marks: Record<string, boolean> = {}): Record<string, unknown>[] => tokens.flatMap((t): Record<string, unknown>[] => {
    if (t.type === "image") { warnings.push(`${entry.name}：段落内的图片未导入。`); return []; }
    if (t.type === "br") return [{ plain_text: "\n", annotations: marks }];
    if (t.type === "link") {
      const safe = /^https?:\/\//i.test(t.href) ? t.href : undefined;
      if (!safe) warnings.push(`${entry.name}：相对链接未保留地址。`);
      return inline(t.tokens ?? [], marks).map((r) => safe ? { ...r, href: safe } : r);
    }
    const next = t.type === "strong" ? { ...marks, bold: true } : t.type === "em" ? { ...marks, italic: true } : t.type === "del" ? { ...marks, strikethrough: true } : marks;
    if ("tokens" in t && Array.isArray(t.tokens)) return inline(t.tokens, next);
    const text = t.type === "codespan" ? t.text : ("text" in t && typeof t.text === "string" ? t.text : "");
    return text ? [{ plain_text: text, annotations: t.type === "codespan" ? { ...next, code: true } : next }] : [];
  });
  const emit = (tokens: readonly Token[]) => {
    for (const token of tokens) {
      if (token.type === "space") continue;
      if (token.type === "paragraph" && token.tokens?.length === 1 && token.tokens[0]?.type === "image") {
        const image = token.tokens![0]! as Tokens.Image;
        if (/^https?:\/\//i.test(image.href)) {
          const url = new URL(image.href);
          const isNotion = /^prod-files-secure\.s3(?:\.us-west-2)?\.amazonaws\.com$/i.test(url.hostname);
          if (isNotion) block("image", { type: "file", file: { url: image.href }, caption: [rich(image.text)] });
          else if ([...url.searchParams.keys()].some((key) => /^x-amz-/i.test(key))) warnings.push(`${entry.name}：无法安全复制的签名图片已移除。`);
          else block("image", { type: "external", external: { url: image.href }, caption: [rich(image.text)] });
        } else warnings.push(`${entry.name}：本地图片 ${image.text || "（无说明）"} 未导入。`);
      } else if (token.type === "paragraph" || token.type === "heading" || token.type === "text") {
        const runs = "tokens" in token && Array.isArray(token.tokens) ? inline(token.tokens) : [rich(token.text)];
        if (token.type === "heading" && token.depth > 3) warnings.push(`${entry.name}：四级及以下标题已调整为三级。`);
        const type = token.type === "heading" ? `heading_${Math.min(token.depth, 3)}` : "paragraph";
        block(type, { rich_text: runs });
      } else if (token.type === "code") {
        if (token.text.length > 50000) warnings.push(`${entry.name}：代码块超过 50000 字符，将被截断。`);
        block("code", { rich_text: [rich(token.text)], language: token.lang ?? "text" });
      }
      else if (token.type === "blockquote") block("quote", { rich_text: [rich(plain(token.tokens ?? []))] });
      else if (token.type === "list") {
        for (const item of token.items) {
          const text = plain(item.tokens);
          if (text.trim()) block(token.ordered ? "numbered_list_item" : "bulleted_list_item", { rich_text: [rich(text)] });
        }
        warnings.push(`${entry.name}：列表的嵌套和格式可能被简化。`);
      } else if (token.type === "hr") block("divider", {});
      else { warnings.push(`${entry.name}：${token.type} 内容已按文本处理，请核对。`); if (token.raw?.trim()) block("paragraph", { rich_text: [rich(token.raw)] }); }
    }
  };
  emit(marked.lexer(lines.slice(i).join("\n")));
  return { id: id ? canonical(id) : `markdown-file:${encodeURIComponent(basename)}`, properties, blocks };
}

/** Reject ZIP bombs while streaming, without extracting paths or saving files. */
export function readMarkdownZip(bytes: Uint8Array): Entry[] {
  if (bytes.byteLength > NOTION_BUNDLE_MAX_BYTES) throw new Error("ZIP 超过 8 MB，请分批导入。");
  // Require a complete end-of-central-directory record rather than accepting a
  // truncated stream as a partial set of articles. ZIP64 is intentionally refused.
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (let p = bytes.length - 22; p >= Math.max(0, bytes.length - 65557); p--) {
    if (view.getUint32(p, true) === 0x06054b50 && p + 22 + view.getUint16(p + 20, true) === bytes.length) { end = p; break; }
  }
  if (end < 0 || view.getUint16(end + 4, true) !== 0 || view.getUint16(end + 6, true) !== 0 ||
      view.getUint16(end + 8, true) !== view.getUint16(end + 10, true) || view.getUint16(end + 10, true) === 0xffff ||
      view.getUint32(end + 12, true) === 0xffffffff || view.getUint32(end + 16, true) === 0xffffffff ||
      view.getUint32(end + 12, true) + view.getUint32(end + 16, true) !== end) throw new Error("ZIP 不完整或格式不受支持。");
  const entries: Entry[] = []; let total = 0; let count = 0;
  const unzip = new Unzip((file) => {
    if (++count > 2000) throw new Error("ZIP 文件数量过多。");
    if (!/\.md$/i.test(file.name) || /(^|\/)__MACOSX\//.test(file.name)) return;
    if (entries.length >= NOTION_BUNDLE_MAX_PAGES) throw new Error("一次最多导入 200 个 Markdown 文件。");
    const chunks: Uint8Array[] = []; let size = 0;
    file.ondata = (err, chunk, final) => {
      if (err) throw new Error("ZIP 解压失败或格式不受支持。");
      size += chunk.length; total += chunk.length;
      if (total > NOTION_BUNDLE_MAX_BYTES) throw new Error("ZIP 解压后的 Markdown 超过 8 MB，请分批导入。");
      chunks.push(chunk);
      if (final) {
        const bytes = new Uint8Array(size); let offset = 0;
        for (const part of chunks) { bytes.set(part, offset); offset += part.length; }
        entries.push({ name: file.name, text: new TextDecoder("utf-8", { fatal: true }).decode(bytes) });
      }
    };
    file.start();
  });
  unzip.register(UnzipInflate);
  for (let offset = 0; offset < bytes.length; offset += 1024) unzip.push(bytes.subarray(offset, Math.min(offset + 1024, bytes.length)), offset + 1024 >= bytes.length);
  if (count !== view.getUint16(end + 10, true)) throw new Error("ZIP 文件目录不完整。");
  return entries;
}

export function markdownEntriesToBundle(entries: Entry[]): MarkdownBundleResult {
  if (entries.length > NOTION_BUNDLE_MAX_PAGES) throw new Error("一次最多导入 200 个 Markdown 文件。");
  const warnings: string[] = []; const pages: Page[] = []; const ids = new Set<string>();
  for (const entry of entries) {
    const page = parseEntry(entry, warnings); if (!page) continue;
    if (ids.has(page.id)) throw new Error(`重复的 Notion 页面 ID：${page.id}；请选择一个副本。`);
    ids.add(page.id); pages.push(page);
  }
  for (const page of pages) {
    for (const key of ["English", "Parent item"]) {
      const prop = page.properties[key] as { relation?: { id: string }[] } | undefined;
      if (prop?.relation?.some((link) => !ids.has(link.id))) warnings.push(`${page.id}：${key} 所指页面不在本次选择中，无法关联。`);
    }
  }
  if (!pages.length) throw new Error("未找到符合格式的文章：需要首行 # 标题。");
  const bundle = { version: 1, database: { id: "", title: "Notion Markdown 导出" }, pages };
  if (new TextEncoder().encode(JSON.stringify({ bundle, apply: true })).length > NOTION_BUNDLE_MAX_BYTES) throw new Error("转换后超过 8 MB，请分批导入。");
  return { bundle, pages: pages.length, warnings };
}
