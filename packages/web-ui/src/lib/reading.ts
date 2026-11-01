import type { ArticleContentBlock, Locale } from "./content.ts";

function blockText(block: ArticleContentBlock): string {
  switch (block.type) {
    case "paragraph":
    case "heading":
    case "quote": return block.text;
    case "list": return block.items.join("\n");
    default: return "";
  }
}

/** 中文按字数、英文按词数。纯派生数据，不依赖后端字段。 */
export function textLength(blocks: readonly ArticleContentBlock[], locale: Locale): number {
  const text = blocks.map(blockText).join("\n");
  if (locale === "en") return text.split(/\s+/).filter(Boolean).length;
  return text.replace(/\s/g, "").length;
}

export function readingMinutes(length: number, locale: Locale): number {
  const perMinute = locale === "en" ? 220 : 400;
  return Math.max(1, Math.round(length / perMinute));
}

export function lengthLabel(length: number, locale: Locale): string {
  const formatted = length.toLocaleString(locale === "en" ? "en-US" : "zh-CN");
  return locale === "en" ? `${formatted} words` : `约 ${formatted} 字`;
}

export function minutesLabel(minutes: number, locale: Locale): string {
  return locale === "en" ? `${minutes} min read` : `约 ${minutes} 分钟阅读`;
}
