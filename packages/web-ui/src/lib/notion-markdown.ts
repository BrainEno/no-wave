import { marked, type Token, type Tokens } from "marked";
import { Unzip, UnzipInflate } from "fflate";
import { NOTION_BUNDLE_MAX_BYTES, NOTION_BUNDLE_MAX_PAGES } from "./notion-import.ts";

type Entry = { name: string; text: string };
/** One CSV export of a Notion database view: the first column is the title property. */
export type NotionTable = { name: string; header: string[]; rows: string[][] };
type Page = { id: string; properties: Record<string, unknown>; blocks: Record<string, unknown>[] };
export type MarkdownBundleResult = {
  bundle: Record<string, unknown>; pages: number; warnings: string[];
  /**
   * Page id → the raw "Created time" cell of its database row, when the CSV has
   * one. Not a property and never in the bundle: the desk may offer it as the
   * date of a published page without one (see notion-created-date.ts).
   */
  created: Record<string, string>;
};
const rich = (plain_text: string) => ({ plain_text });
const titleProp = (s: string) => ({ type: "title", title: [rich(s)] });
const textProp = (s: string) => ({ type: "rich_text", rich_text: [rich(s)] });
const pageId = (name: string) => /(?:^|\s)([a-f0-9]{32})(?:\.md)$/i.exec(name.split(/[\\/]/).pop() ?? "")?.[1]?.toLowerCase();
const canonical = (id: string) => `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`;
const basenameOf = (name: string) => name.split(/[\\/]/).pop() ?? "";
/** "墙壁 0123…cdef.md" → "墙壁": what a person would call the file. */
const fileTitle = (name: string) => basenameOf(name).replace(/\.(md|csv)$/i, "").replace(/(?:_all)$/i, "").replace(/\s+[a-f0-9]{32}$/i, "").trim();

/**
 * Notion writes a checkbox as Yes/No; other tools and hand-edited exports use
 * true/false, Y/N, 是/否, and Notion's own API dump uses __YES__/__NO__. Anything
 * else is not a checkbox value, so the caller can tell a real checkbox column
 * from a Status select that happens to be called "Published".
 */
export function notionBoolean(value: string): boolean | null {
  const v = value.trim();
  if (/^(yes|true|y|__yes__|是)$/i.test(v)) return true;
  if (/^(no|false|n|__no__|否)$/i.test(v)) return false;
  return null;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const day = (y: number, m: number, d: number): string | null => {
  const t = Date.UTC(y, m - 1, d);
  const at = new Date(t);
  // Reject 2026-02-30 rather than letting Date roll it into March.
  return at.getUTCFullYear() === y && at.getUTCMonth() === m - 1 && at.getUTCDate() === d ? at.toISOString() : null;
};

/**
 * A calendar day in any of the spellings a Notion export or a Chinese
 * spreadsheet produces, read as **UTC midnight** — the same rule as the API's
 * `notionDateToInstant`, so the instant never depends on the browser's
 * timezone. `new Date("2026/10/08")` is deliberately never used: it is local
 * time. A full ISO timestamp is honoured exactly; one without a zone is UTC.
 * A Notion range ("A → B") keeps its start; the caller reports the rest.
 */
export function notionDateStart(raw: string): { start: string; range: boolean } | null {
  const [head, ...rest] = raw.split(/\s*→\s*/);
  const value = (head ?? "").trim();
  const range = rest.length > 0;
  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(value) ?? /^(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日?$/.exec(value);
  if (m) { const start = day(+m[1]!, +m[2]!, +m[3]!); return start ? { start, range } : null; }
  m = /^([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})$/.exec(value);
  if (m) {
    const month = MONTHS.indexOf(m[1]!.slice(0, 3).toLowerCase());
    const full = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"][month];
    if (month < 0 || !(m[1]!.length === 3 || full!.startsWith(m[1]!.toLowerCase()))) return null;
    const start = day(+m[3]!, month + 1, +m[2]!);
    return start ? { start, range } : null;
  }
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?([zZ]|[+-]\d{2}:?\d{2})?$/.test(value)) {
    const zoned = /[zZ]$|[+-]\d{2}:?\d{2}$/.test(value);
    const t = Date.parse(zoned ? value : `${value}Z`);
    return Number.isFinite(t) ? { start: new Date(t).toISOString(), range } : null;
  }
  return null;
}

/** Parse only a leading run of known Notion properties: normal prose is never swallowed. */
function parseEntry(entry: Entry, warnings: string[], unreadableDate?: (pageId: string) => void): Page | null {
  const lines = entry.text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").split("\n");
  const heading = /^#\s+(.+?)\s*#*\s*$/.exec(lines[0] ?? "");
  const id = pageId(entry.name);
  const basename = basenameOf(entry.name);
  // A page exported without its "# title" line still has a name: the file's.
  // It is used, and said so; only a page with neither is skipped.
  const fallback = fileTitle(entry.name);
  const title = heading?.[1]?.trim() || fallback;
  if (!title) { warnings.push(`${entry.name}：既没有首行 # 标题，也无法从文件名得到标题，已跳过。`); return null; }
  if (!id && (!basename || basename.length > 120)) { warnings.push(`${entry.name}：文件名过长或无效，已跳过。`); return null; }
  if (!heading) warnings.push(`${entry.name}：缺少首行 # 标题，已用文件名「${title}」作标题；请核对。`);
  if (!id) warnings.push(`${entry.name}：没有 Notion 页面 ID，使用文件名识别；重命名会视为新文章。`);
  const properties: Record<string, unknown> = { Name: titleProp(title) };
  let i = heading ? 1 : 0;
  while (i < lines.length && !lines[i]!.trim()) i++;
  const known = new Set(["Date", "Excerpt", "FeaturedImage", "Published", "Rank", "Slug", "Tags", "English", "Parent item"]);
  let inProperties = false;
  let dateUnreadable = false;
  for (; i < lines.length; i++) {
    const m = /^([^:]+):\s*(.*)$/.exec(lines[i]!);
    if (!m || (!inProperties && !known.has(m[1]!))) break;
    inProperties = true;
    if (!known.has(m[1]!)) { warnings.push(`${entry.name}：属性 ${m[1]} 未导入。`); continue; }
    const key = m[1]!; const raw = m[2]!;
    const value = raw.trim();
    if (key === "Slug" || key === "Excerpt") properties[key] = textProp(value);
    else if (key === "Published") {
      const checked = notionBoolean(value);
      if (checked !== null) properties[key] = { type: "checkbox", checkbox: checked };
      else warnings.push(`${entry.name}：无法识别 Published，按草稿处理。`);
    } else if (key === "Tags") properties[key] = { type: "multi_select", multi_select: value.split(",").map((name) => ({ name: name.trim() })).filter(({ name }) => name) };
    else if (key === "Date") {
      const date = notionDateStart(value);
      if (date) {
        properties[key] = { type: "date", date: { start: date.start } };
        if (date.range) warnings.push(`${entry.name}：Date 是时间段，只保留开始日期。`);
      } else { warnings.push(`${entry.name}：日期无法识别，使用默认日期。`); dateUnreadable = true; }
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
  const pageKey = id ? canonical(id) : `markdown-file:${encodeURIComponent(basename)}`;
  // A Date the author wrote but that cannot be read is not an empty Date: it is
  // not offered for the creation-date backfill (the warning above names it).
  if (dateUnreadable) unreadableDate?.(pageKey);
  return { id: pageKey, properties, blocks };
}

/**
 * RFC 4180 as Notion writes it: a UTF-8 BOM, CRLF line ends, quoted cells that
 * may contain commas, doubled quotes and line breaks. Blank lines are dropped.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []; let row: string[] = []; let cell = ""; let quoted = false;
  const src = text.replace(/^\uFEFF/, "");
  const endRow = () => { row.push(cell); cell = ""; if (row.some((c) => c !== "")) rows.push(row); row = []; };
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (quoted) {
      if (c === '"') { if (src[i + 1] === '"') { cell += '"'; i++; } else quoted = false; }
      else cell += c;
    } else if (c === '"' && cell === "") quoted = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\r") { if (src[i + 1] === "\n") i++; endRow(); }
    else if (c === "\n") endRow();
    else cell += c;
  }
  if (cell !== "" || row.length) endRow();
  return rows;
}

/**
 * The database CSVs in an export. Notion writes two per database: "X.csv" with
 * the view's visible columns and "X_all.csv" with every property; when both are
 * present only `_all` is read, so a hidden Date column is not mistaken for none.
 */
export function tablesOf(entries: readonly Entry[]): NotionTable[] {
  const csv = entries.filter((e) => /\.csv$/i.test(e.name));
  const keyOf = (name: string) => name.replace(/_all\.csv$/i, ".csv").toLowerCase();
  const hasAll = new Set(csv.filter((e) => /_all\.csv$/i.test(e.name)).map((e) => keyOf(e.name)));
  return csv.filter((e) => /_all\.csv$/i.test(e.name) || !hasAll.has(keyOf(e.name))).flatMap((e) => {
    const [header, ...rows] = parseCsv(e.text);
    return header ? [{ name: `${fileTitle(e.name)}.csv`, header: header.map((h) => h.trim()), rows }] : [];
  });
}

/** Property → the column names a Notion database or a Chinese spreadsheet uses for it. */
const COLUMN_NAMES: Record<string, readonly string[]> = {
  Date: ["date", "日期", "发布日期", "发表日期", "创作日期"],
  Excerpt: ["excerpt", "summary", "摘要", "摘录", "简介"],
  FeaturedImage: ["featuredimage", "featured image", "cover", "封面", "封面图", "题图"],
  Published: ["published", "已发布", "发布", "是否发布", "已发表"],
  Slug: ["slug", "别名", "网址别名", "短链"],
  Tags: ["tags", "tag", "标签"],
};
/**
 * Notion's "Created time" property, under the names Notion and Chinese
 * workspaces give it. It fills no property by itself; it is kept per page for
 * the optional date backfill.
 */
const CREATED_COLUMN_NAMES: readonly string[] = ["created", "created time", "created at", "创建时间", "创建日期", "创建于"];
/** Columns that are known and deliberately not carried, so they are not reported as unknown. */
const IGNORED_COLUMNS = new Set(["rank", "排序"]);
type TableIndex = { table: NotionTable; columns: Partial<Record<string, number>>; checkbox: boolean };

function isEmptyProperty(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  const v = value as { rich_text?: { plain_text: string }[]; multi_select?: unknown[]; files?: unknown[] };
  if (v.rich_text) return v.rich_text.every((r) => !r.plain_text.trim());
  if (v.multi_select) return v.multi_select.length === 0;
  if (v.files) return v.files.length === 0;
  return false;
}

/** Map each table's header once, and say once which of its columns are not imported. */
export function indexTables(tables: readonly NotionTable[], warnings: string[]): TableIndex[] {
  return tables.map((table) => {
    const columns: Partial<Record<string, number>> = {}; const unknown: string[] = [];
    table.header.forEach((name, index) => {
      if (index === 0) return; // the title property
      const key = Object.keys(COLUMN_NAMES).find((k) => COLUMN_NAMES[k]!.includes(name.trim().toLowerCase()));
      if (key && columns[key] === undefined) columns[key] = index;
      else if (CREATED_COLUMN_NAMES.includes(name.trim().toLowerCase())) { if (columns.Created === undefined) columns.Created = index; }
      else if (!IGNORED_COLUMNS.has(name.trim().toLowerCase())) unknown.push(name || `第 ${index + 1} 列`);
    });
    // Only a column whose every non-empty value is a checkbox value is a
    // checkbox: a Status select named "Published" holding "Draft" is not, and
    // reading its "Yes" rows as published would publish by accident.
    const published = columns.Published;
    const values = published === undefined ? [] : table.rows.map((r) => (r[published] ?? "").trim()).filter(Boolean);
    const checkbox = values.length > 0 && values.every((v) => notionBoolean(v) !== null);
    if (published !== undefined && !checkbox) warnings.push(`${table.name}：「${table.header[published]}」列不全是勾选值（是/否、Yes/No），未用于发布状态。`);
    if (unknown.length) warnings.push(`${table.name}：列 ${unknown.join("、")} 没有对应字段，未导入。`);
    return { table, columns, checkbox };
  });
}

/**
 * Fill a page's *empty* properties from its database row; a value already in
 * the Markdown is never overwritten. The row is found by the page's `#` title,
 * then by the file name without its Notion id — both trimmed. A name shared by
 * two rows is ambiguous and fills nothing. Every page says what happened.
 */
export function fillFromTables(page: Page, entry: Entry, tables: readonly TableIndex[], warnings: string[], created?: Record<string, string>): void {
  if (!tables.length) return;
  const title = ((page.properties.Name as { title: { plain_text: string }[] }).title[0]?.plain_text ?? "").trim();
  const label = title || entry.name;
  const find = (name: string) => tables.flatMap((t) => t.table.rows.filter((r) => (r[0] ?? "").trim() === name).map((row) => ({ t, row })));
  let hits = title ? find(title) : [];
  const base = fileTitle(entry.name);
  if (!hits.length && base && base !== title) hits = find(base);
  if (!hits.length) { warnings.push(`《${label}》：CSV 中没有匹配的行，属性未补齐。`); return; }
  if (hits.length > 1) { warnings.push(`《${label}》：CSV 中有 ${hits.length} 行同名，无法确定是哪一行，属性未补齐。`); return; }
  const { t, row } = hits[0]!;
  const filled: string[] = []; const problems: string[] = [];
  const cell = (key: string) => { const i = t.columns[key]; return i === undefined ? "" : (row[i] ?? "").trim(); };
  if (created && cell("Created")) created[page.id] = cell("Created");
  for (const key of Object.keys(COLUMN_NAMES)) {
    const value = cell(key);
    if (!value || !isEmptyProperty(page.properties[key])) continue;
    if (key === "Slug" || key === "Excerpt") page.properties[key] = textProp(value);
    else if (key === "Tags") {
      const tags = value.split(/[,，、]/).map((name) => ({ name: name.trim() })).filter(({ name }) => name);
      if (tags.length) page.properties[key] = { type: "multi_select", multi_select: tags };
    } else if (key === "Published") {
      if (!t.checkbox) continue;
      page.properties[key] = { type: "checkbox", checkbox: notionBoolean(value)! };
    } else if (key === "Date") {
      const date = notionDateStart(value);
      if (!date) { problems.push(`日期「${value}」无法识别`); continue; }
      page.properties[key] = { type: "date", date: { start: date.start } };
      if (date.range) problems.push("Date 是时间段，只保留开始日期");
    } else if (key === "FeaturedImage") {
      if (!/^https?:\/\//i.test(value)) { problems.push("封面是导出包内的本地文件，未导入"); continue; }
      page.properties[key] = { type: "files", files: [{ type: "external", external: { url: value.split(/\s*,\s*/)[0]! } }] };
    }
    if (page.properties[key] !== undefined) filled.push(key);
  }
  const extra = problems.length ? `；${problems.join("；")}` : "";
  warnings.push(filled.length
    ? `《${label}》：已从 ${t.table.name} 补 ${filled.length} 列属性（${filled.join("、")}）；请核对${extra}。`
    : `《${label}》：已与 ${t.table.name} 对照，没有需要补的空属性${extra}。`);
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
  const entries: Entry[] = []; let total = 0; let count = 0; let pages = 0;
  // fflate may catch a callback exception and call ondata again with an error.
  // Keep our actionable validation failure rather than replacing it with a
  // generic decompression message on that second call.
  let validationError: Error | null = null;
  const unzip = new Unzip((file) => {
    if (++count > 2000) throw new Error("ZIP 文件数量过多。");
    // Markdown pages, plus the database CSVs that carry their properties. The
    // entry, page and decompressed-byte ceilings below are unchanged; a CSV is
    // not a page, so it does not count toward the 200.
    if (!/\.(md|csv)$/i.test(file.name) || /(^|\/)__MACOSX\//.test(file.name)) return;
    if (/\.md$/i.test(file.name) && ++pages > NOTION_BUNDLE_MAX_PAGES) throw new Error("一次最多导入 200 个 Markdown 文件。");
    const chunks: Uint8Array[] = []; let size = 0;
    file.ondata = (err, chunk, final) => {
      if (err) throw validationError ?? new Error("ZIP 解压失败或格式不受支持。");
      size += chunk.length; total += chunk.length;
      if (total > NOTION_BUNDLE_MAX_BYTES) {
        validationError = new Error("ZIP 解压后的 Markdown 超过 8 MB，请分批导入。");
        throw validationError;
      }
      chunks.push(chunk);
      if (final) {
        const bytes = new Uint8Array(size); let offset = 0;
        for (const part of chunks) { bytes.set(part, offset); offset += part.length; }
        let text: string;
        try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
        catch {
          validationError = new Error(`ZIP 中的 ${/\.csv$/i.test(file.name) ? "CSV" : "Markdown"} 不是有效的 UTF-8 文本。`);
          throw validationError;
        }
        entries.push({ name: file.name, text });
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
  const markdown = entries.filter((e) => !/\.csv$/i.test(e.name));
  if (markdown.length > NOTION_BUNDLE_MAX_PAGES) throw new Error("一次最多导入 200 个 Markdown 文件。");
  const warnings: string[] = []; const pages: Page[] = []; const ids = new Set<string>();
  const tables = indexTables(tablesOf(entries), warnings);
  const created: Record<string, string> = {};
  for (const entry of markdown) {
    let unreadable = false;
    const page = parseEntry(entry, warnings, () => { unreadable = true; }); if (!page) continue;
    fillFromTables(page, entry, tables, warnings, created);
    if (unreadable) delete created[page.id];
    if (ids.has(page.id)) throw new Error(`重复的 Notion 页面 ID：${page.id}；请选择一个副本。`);
    ids.add(page.id); pages.push(page);
  }
  for (const page of pages) {
    for (const key of ["English", "Parent item"]) {
      const prop = page.properties[key] as { relation?: { id: string }[] } | undefined;
      if (prop?.relation?.some((link) => !ids.has(link.id))) warnings.push(`${page.id}：${key} 所指页面不在本次选择中，无法关联。`);
    }
  }
  if (!pages.length) throw new Error(markdown.length ? "未找到可导入的文章：Markdown 文件既没有首行 # 标题，也没有可用的文件名。" : "未找到 Markdown 文章：CSV 只提供属性，请连同导出的 .md 文件一起选择。");
  const bundle = { version: 1, database: { id: "", title: "Notion Markdown 导出" }, pages };
  // The converted bundle may exceed one request's 8 MiB; the desk splits it
  // into requests the API accepts (planImportBatches), so it is not refused here.
  return { bundle, pages: pages.length, warnings, created };
}
