import { unzipSync } from "fflate";
import type { WorkType } from "@/lib/content.ts";

export interface ParsedImportItem {
  id: string;
  title: string;
  content: string;
  author: string;
  summary: string;
  workType: WorkType;
  locale: string;
  publish: boolean;
  sourceName?: string;
  validationErrors: string[];
}

export const SUPPORTED_WORK_TYPES: { value: WorkType; label: string }[] = [
  { value: "novel", label: "小说" },
  { value: "poetry", label: "诗歌" },
  { value: "other", label: "其他文体" },
];

/**
 * A genre cell from an import sheet, folded into 小说 / 诗歌 / 其他文体 the same
 * way the stored works were (ADR 0054): every kind of fiction is 小说, every
 * kind of verse is 诗歌, and everything else — essays, criticism, nonfiction,
 * an unknown word or an empty cell — is 其他文体.
 */
export function normalizeWorkType(val: unknown): WorkType {
  if (typeof val !== "string") return "other";
  const str = val.trim().toLowerCase();
  if (["novel", "fiction", "short_story", "shortstory", "short story", "serial", "小说", "长篇", "长篇小说", "短篇", "短篇小说", "中篇", "中篇小说", "连载", "小說"].includes(str)) return "novel";
  if (["poetry", "poem", "诗", "诗歌", "现代诗", "詩", "詩歌"].includes(str)) return "poetry";
  return "other";
}

export function normalizeLocale(val: unknown): string {
  if (typeof val !== "string") return "zh-CN";
  const str = val.trim().toLowerCase();
  if (str.startsWith("en") || str === "英文" || str === "english") return "en";
  if (str === "zh-tw" || str === "繁体" || str === "繁體中文") return "zh-TW";
  return "zh-CN";
}

export function validateImportItem(item: ParsedImportItem): string[] {
  const errors: string[] = [];
  if (!item.title.trim()) errors.push("缺少标题");
  if (!item.content.trim()) errors.push("缺少正文内容");
  if (!item.author.trim()) errors.push("缺少作者");
  if (!item.workType) errors.push("缺少体裁");
  if (!item.locale) errors.push("缺少语言");
  return errors;
}

export function extractParagraphs(content: string): string[] {
  return content
    .split(/\r?\n\s*\r?\n/)
    .map(p => p.trim())
    .filter(p => p.length > 0);
}

/**
 * 从 .docx 二进制数据中读取段落与文字
 */
export function parseDocxBytes(bytes: Uint8Array, fallbackTitle = "未命名文档"): { title: string; content: string } {
  const files = unzipSync(bytes);
  const docFile = files["word/document.xml"];
  if (!docFile) {
    throw new Error("无效的 .docx 文件：缺少 word/document.xml");
  }
  const xml = new TextDecoder("utf-8").decode(docFile);
  
  // 匹配所有 <w:p> 段落
  const paragraphMatches = xml.match(/<w:p[\s>].*?<\/w:p>/gs) || [];
  const paragraphs: string[] = [];

  for (const pXml of paragraphMatches) {
    // 匹配段落内的所有 <w:t> 文字
    const textMatches = pXml.match(/<w:t[\s>][^<]*<\/w:t>/g) || [];
    const pText = textMatches
      .map(t => t.replace(/^<w:t[^>]*>/, "").replace(/<\/w:t>$/, ""))
      .join("")
      .trim();
    if (pText) {
      paragraphs.push(pText);
    }
  }

  if (paragraphs.length === 0) {
    return { title: fallbackTitle, content: "" };
  }

  // 第一段如较短（<= 60 字符），优先视作标题
  let title = fallbackTitle;
  let bodyParagraphs = paragraphs;
  if (paragraphs[0] && paragraphs[0].length <= 60) {
    title = paragraphs[0];
    bodyParagraphs = paragraphs.slice(1);
  }

  return {
    title,
    content: bodyParagraphs.join("\n\n"),
  };
}

/**
 * 解析纯文本 / Markdown
 */
export function parseTextOrMarkdown(text: string, fallbackTitle = "未命名文档"): { title: string; content: string } {
  const lines = text.split(/\r?\n/);
  let title = fallbackTitle;
  let contentStartIndex = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]?.trim();
    if (line) {
      if (line.startsWith("# ")) {
        title = line.replace(/^#\s+/, "").trim();
        contentStartIndex = i + 1;
      } else if (line.length <= 60 && i === 0) {
        title = line;
        contentStartIndex = i + 1;
      }
      break;
    }
  }

  const content = lines.slice(contentStartIndex).join("\n").trim();
  return { title, content };
}

/**
 * 解析 HTML 文本中的标题与段落（纯字符串与正则解析，不调用 DOMParser，保证 SSR 与安全性）
 */
export function parseHtmlContent(raw: string, fallbackTitle = "未命名文档"): { title: string; content: string } {
  const titleMatch = raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || raw.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  const title = titleMatch ? titleMatch[1]!.replace(/<[^>]+>/g, "").trim() : fallbackTitle;

  const pMatches = Array.from(raw.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi));
  let content = pMatches.map(m => m[1]!.replace(/<[^>]+>/g, "").trim()).filter(Boolean).join("\n\n");

  if (!content) {
    const cleaned = raw
      .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "")
      .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, "");
    content = cleaned
      .replace(/<[^>]+>/g, "\n")
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean)
      .join("\n\n");
  }

  return { title: title || fallbackTitle, content };
}

/**
 * 通用已有用户数据（JSON / CSV / 结构化文本）解析器

 */
export function parseUserDataInput(raw: string, defaultAuthor = ""): ParsedImportItem[] {
  const trimmed = raw.trim();
  if (!trimmed) return [];

  // 1. 尝试 JSON 格式
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed);
      const list = Array.isArray(parsed)
        ? parsed
        : Array.isArray((parsed as Record<string, unknown>).data)
          ? ((parsed as Record<string, unknown>).data as unknown[])
          : Array.isArray((parsed as Record<string, unknown>).articles)
            ? ((parsed as Record<string, unknown>).articles as unknown[])
            : Array.isArray((parsed as Record<string, unknown>).posts)
              ? ((parsed as Record<string, unknown>).posts as unknown[])
              : [parsed];

      return list
        .filter((obj): obj is Record<string, unknown> => typeof obj === "object" && obj !== null)
        .map((obj, index) => {
          const title = String(obj.title || obj.name || obj.headline || obj.post_title || obj.subject || obj["标题"] || `作品 #${index + 1}`).trim();
          const content = String(obj.content || obj.body || obj.text || obj.markdown || obj.html || obj.post_content || obj["正文"] || obj["内容"] || "").trim();
          const author = String(obj.author || obj.authorName || obj.creator || obj.writer || obj["作者"] || defaultAuthor).trim();
          const summary = String(obj.summary || obj.description || obj.excerpt || obj.intro || obj["摘要"] || obj["简介"] || (content ? content.slice(0, 100) : "")).trim();
          const workType = normalizeWorkType(obj.workType || obj.type || obj.category || obj.genre || obj["体裁"] || obj["分类"]);
          const locale = normalizeLocale(obj.locale || obj.lang || obj.language || obj["语言"]);
          const publish = Boolean(obj.publish || obj.published || obj.status === "published" || obj["发布"]);

          const item: ParsedImportItem = {
            id: `json-${Date.now()}-${index}`,
            title,
            content,
            author,
            summary,
            workType,
            locale,
            publish,
            validationErrors: [],
          };
          item.validationErrors = validateImportItem(item);
          return item;
        });
    } catch {
      // 不是合法的 JSON，继续尝试 CSV
    }
  }

  // 2. 尝试 CSV / TSV 格式
  const lines = trimmed.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (lines.length > 1) {
    const separator = lines[0].includes("\t") ? "\t" : ",";
    const header = lines[0].split(separator).map(h => h.trim().toLowerCase().replace(/^["']|["']$/g, ""));
    
    // 必须有 title / 标题
    const titleIdx = header.findIndex(h => ["title", "name", "headline", "标题"].includes(h));
    const contentIdx = header.findIndex(h => ["content", "body", "text", "markdown", "正文", "内容"].includes(h));
    const authorIdx = header.findIndex(h => ["author", "authorname", "creator", "作者"].includes(h));
    const summaryIdx = header.findIndex(h => ["summary", "description", "excerpt", "摘要"].includes(h));
    const typeIdx = header.findIndex(h => ["type", "worktype", "category", "体裁", "分类"].includes(h));
    const langIdx = header.findIndex(h => ["locale", "lang", "language", "语言"].includes(h));

    if (titleIdx !== -1 || contentIdx !== -1) {
      const items: ParsedImportItem[] = [];
      for (let i = 1; i < lines.length; i++) {
        const row = lines[i].split(separator).map(c => c.trim().replace(/^["']|["']$/g, ""));
        const title = (titleIdx !== -1 ? row[titleIdx] : `作品 #${i}`) || `作品 #${i}`;
        const content = contentIdx !== -1 ? row[contentIdx] : "";
        const author = (authorIdx !== -1 ? row[authorIdx] : defaultAuthor) || defaultAuthor;
        const summary = (summaryIdx !== -1 ? row[summaryIdx] : (content ? content.slice(0, 100) : "")) || "";
        const workType = normalizeWorkType(typeIdx !== -1 ? row[typeIdx] : "other");
        const locale = normalizeLocale(langIdx !== -1 ? row[langIdx] : "zh-CN");

        const item: ParsedImportItem = {
          id: `csv-${Date.now()}-${i}`,
          title: title.trim(),
          content: content.trim(),
          author: author.trim(),
          summary: summary.trim(),
          workType,
          locale,
          publish: false,
          validationErrors: [],
        };
        item.validationErrors = validateImportItem(item);
        items.push(item);
      }
      return items;
    }
  }

  // 3. 回退为单篇文本解析
  const { title, content } = parseTextOrMarkdown(trimmed, "用户导入文稿");
  const single: ParsedImportItem = {
    id: `text-${Date.now()}-0`,
    title,
    content,
    author: defaultAuthor,
    summary: content.slice(0, 100),
    workType: "other",
    locale: "zh-CN",
    publish: false,
    validationErrors: [],
  };
  single.validationErrors = validateImportItem(single);
  return [single];
}

/**
 * 批量应用补全设置到所选条目中
 */
export function applyBatchPatch(
  items: ParsedImportItem[],
  patch: {
    author?: string;
    workType?: WorkType;
    locale?: string;
    fillSummaryFromContent?: boolean;
  }
): ParsedImportItem[] {
  return items.map(item => {
    const updated = { ...item };
    if (patch.author && patch.author.trim()) {
      updated.author = patch.author.trim();
    }
    if (patch.workType) {
      updated.workType = patch.workType;
    }
    if (patch.locale) {
      updated.locale = patch.locale;
    }
    if (patch.fillSummaryFromContent && !updated.summary.trim() && updated.content.trim()) {
      updated.summary = updated.content.trim().slice(0, 120);
    }
    updated.validationErrors = validateImportItem(updated);
    return updated;
  });
}
