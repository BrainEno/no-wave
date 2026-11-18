import type { ArticleView, Locale } from "./content.ts";
import { textLength } from "./reading.ts";
import { firstLines } from "./work-types.ts";

type Preview = NonNullable<ArticleView["listPreview"]>;

export function parseArticlePreview(value: unknown, locale: Locale): Preview {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Invalid article list preview.");
  const preview = value as Record<string, unknown>;
  if (preview.locale !== locale || !Number.isSafeInteger(preview.length) || Number(preview.length) < 0 ||
      !Array.isArray(preview.poemLines) || preview.poemLines.length > 2 ||
      !preview.poemLines.every((line): line is string => typeof line === "string" && line.length <= 20_000 && line.trim() === line && line.length > 0 && !/[\r\n]/.test(line))) {
    throw new Error("Invalid article list preview.");
  }
  return { locale, length: Number(preview.length), poemLines: preview.poemLines };
}

/** Only explicit list consumers request this; default API clients keep full bodies. */
export function projectArticleForList(article: ArticleView): ArticleView {
  if (article.listPreview) return article;
  const paragraph = article.contentBlocks.find(block => block.type === "paragraph");
  const preview: Preview = { locale: article.locale, length: textLength(article.contentBlocks, article.locale),
    poemLines: paragraph?.type === "paragraph" ? firstLines(paragraph.text, 2) : [] };
  return { ...article, contentBlocks: [], listPreview: preview };
}

export function articleReadingLength(article: ArticleView, locale: Locale): number {
  if (!article.listPreview) return textLength(article.contentBlocks, locale);
  if (article.listPreview.locale !== locale) throw new Error("Article preview locale does not match its page.");
  return article.listPreview.length;
}

export function articlePoemLines(article: ArticleView): string[] {
  if (article.listPreview) return article.listPreview.poemLines;
  const paragraph = article.contentBlocks.find(block => block.type === "paragraph");
  return paragraph?.type === "paragraph" ? firstLines(paragraph.text, 2) : [];
}
