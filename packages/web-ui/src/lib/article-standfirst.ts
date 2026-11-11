import type { ArticleContentBlock } from "./content.ts";

/**
 * Public summaries may be generated from the beginning of the body. Showing
 * that same text twice makes readers cross the introduction before reading it.
 * Compare normalized prose only; never alter the summary used by SEO or feeds.
 * Images and code are ignored just as they are by the API summary generator.
 */
export function repeatsArticleOpening(summary: string, blocks: readonly ArticleContentBlock[]): boolean {
  const pieces: string[] = [];
  for (const block of blocks) {
    if (block.type === "paragraph" || block.type === "heading" || block.type === "quote") pieces.push(block.text);
    if (block.type === "list") pieces.push(block.items.filter((item) => item.trim()).join("，"));
  }
  const flatten = (value: string) => value.replace(/\s+/g, " ").trim();
  const opening = pieces.map(flatten).filter(Boolean).reduce((result, next) => {
    if (!result) return next;
    return result + (/[A-Za-z0-9]$/.test(result) && /^[A-Za-z0-9]/.test(next) ? " " : "") + next;
  }, "");
  const excerpt = flatten(summary).replace(/(?:…|\.\.\.)$/, "").trimEnd();
  return excerpt.length > 0 && opening.startsWith(excerpt);
}
