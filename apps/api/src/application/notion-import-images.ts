import type { PlannedEdition } from "./notion-bundle.ts";
import type { InterchangeIssue } from "./notion-interchange.ts";

/** Copy an expiring image into media storage; never include signed URLs in errors. */
export type NotionImageCopier = (url: string, previousSrc?: string) => Promise<
  { ok: true; src: string } | { ok: false; reason: string }
>;

/**
 * Replace Notion-hosted images only. External links are deliberately unchanged.
 * The original digest stays intact: it describes the incoming bundle, not the
 * randomly assigned media IDs. On failure the image is dropped and the caller
 * records an incomplete digest, so a later import can try again.
 */
export async function prepareNotionImages(
  edition: PlannedEdition,
  copy: NotionImageCopier,
  previous: ReadonlyMap<string, string> = new Map(),
  reuseWithoutFetch = false,
): Promise<{ edition: PlannedEdition; incomplete: boolean }> {
  const expiring = new Set(edition.issues.filter((issue) => issue.code === "expiring-image-url").map((issue) => issue.detail));
  if (expiring.size === 0) return { edition, incomplete: false };
  const issues: InterchangeIssue[] = edition.issues.filter((issue) => issue.code !== "expiring-image-url");
  const blocks: Record<string, unknown>[] = [];
  let incomplete = false;
  for (const block of edition.draft.contentBlocks) {
    if (block.type !== "image" || typeof block.src !== "string" || !expiring.has(block.src)) {
      blocks.push(block);
      continue;
    }
    const existing = typeof block.id === "string" ? previous.get(block.id) : undefined;
    const result = existing && reuseWithoutFetch
      ? { ok: true as const, src: existing }
      : await copy(block.src, existing);
    if (result.ok) {
      blocks.push({ ...block, src: result.src });
    } else {
      incomplete = true;
      issues.push({ code: "image-copy-failed", detail: `Image ${String(block.id ?? "")}: ${result.reason}; image omitted.` });
    }
  }
  return { edition: { ...edition, draft: { ...edition.draft, contentBlocks: blocks }, issues }, incomplete };
}
