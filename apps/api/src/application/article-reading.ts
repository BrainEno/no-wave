import type { StoredArticle } from "./persistence-ports.ts";

export type ArticleReadingPreview = { locale: string; length: number; poemLines: string[] };
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function requiredString(value: unknown): string {
  if (typeof value !== "string") throw new Error("Stored article has invalid reading text.");
  return value;
}
function readableTexts(block: unknown): string[] {
  if (!record(block)) throw new Error("Stored article has invalid reading blocks.");
  switch (block.type) {
    case "paragraph":
    case "heading":
    case "quote": return [requiredString(block.text)];
    case "list":
      if (!Array.isArray(block.items)) throw new Error("Stored article has invalid list items.");
      return block.items.map(requiredString);
    case "image":
    case "code": return [];
    default: throw new Error("Stored article has an unsupported reading block.");
  }
}

/** Exactly the public labels, excluding code, image captions and attribution. */
export function articleReadingPreview(contentBlocks: unknown, locale: unknown): ArticleReadingPreview {
  const blocks: unknown = typeof contentBlocks === "string" ? JSON.parse(contentBlocks) : contentBlocks;
  if (!Array.isArray(blocks)) throw new Error("Stored article has no readable body.");
  if (locale !== "en" && locale !== "zh-CN" && locale !== "zh-TW") throw new Error("Stored article has an invalid reading locale.");
  let length = 0;
  let firstParagraph: string | undefined;
  for (const block of blocks) {
    for (const text of readableTexts(block)) length += locale === "en" ? (text.match(/\S+/g)?.length ?? 0) : text.replace(/\s/g, "").length;
    if (firstParagraph === undefined && record(block) && block.type === "paragraph") firstParagraph = requiredString(block.text);
  }
  const poemLines = firstParagraph?.split(/\r?\n/).map(line => line.trim()).filter(Boolean).slice(0, 2) ?? [];
  return { locale, length, poemLines };
}

/** Applied before retaining a driver row, never to detail/authoring writes. */
export function projectStoredArticleCard(article: StoredArticle): StoredArticle {
  const readingPreview = articleReadingPreview(article.contentBlocks, article.locale);
  return { ...article, contentBlocks: [], readingPreview };
}
