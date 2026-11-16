export type ReadingBlock = { id: string; text: string; top: number; height: number };
export type ReadingPosition = {
  blockId: string; quote: string; fingerprint: string; length: number;
  offset: number; percent: number; sourceRevision: string;
};

const MAX_BLOCK_TEXT = 1_000_000;
const MAX_QUOTE = 96;
const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

export function readingText(text: string): string {
  return text.replace(/\s+/gu, " ").trim();
}

/** A change detector, never an identity, authorization token or cryptographic assertion. */
function fingerprint(text: string): string {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index++) hash = Math.imul(hash ^ text.charCodeAt(index), 16777619);
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function parseReadingPosition(value: unknown): ReadingPosition | null {
  if (!object(value)) return null;
  const { blockId, quote, fingerprint: hash, length, offset, percent, sourceRevision } = value;
  if (typeof blockId !== "string" || blockId.length < 1 || blockId.length > 200 || /[\u0000-\u001f\u007f]/u.test(blockId)) return null;
  if (typeof quote !== "string" || quote.length < 1 || quote.length > MAX_QUOTE || readingText(quote) !== quote) return null;
  if (typeof hash !== "string" || !/^[a-f0-9]{8}$/.test(hash)) return null;
  if (!Number.isSafeInteger(length) || (length as number) < quote.length || (length as number) > MAX_BLOCK_TEXT) return null;
  if (!finite(offset) || offset < 0 || offset > 1 || !finite(percent) || percent < 0 || percent > 100) return null;
  if (typeof sourceRevision !== "string" || sourceRevision.length > 100 || /[\u0000-\u001f]/u.test(sourceRevision)) return null;
  return { blockId, quote, fingerprint: hash, length: length as number, offset, percent, sourceRevision };
}

function usableBlock(block: ReadingBlock): boolean {
  return block.id.length > 0 && block.id.length <= 200 && finite(block.top) && finite(block.height) && block.height > 0 && readingText(block.text).length > 0 && readingText(block.text).length <= MAX_BLOCK_TEXT;
}

/** Do not turn a header, comments, or an out-of-article scroll into a new bookmark. */
export function captureReadingPosition(blocks: readonly ReadingBlock[], line: number, sourceRevision: string): ReadingPosition | null {
  if (!finite(line) || blocks.length === 0) return null;
  const candidates = blocks.filter(usableBlock);
  if (!candidates.length || line < candidates[0]!.top || line > candidates.at(-1)!.top + candidates.at(-1)!.height) return null;
  const index = candidates.findIndex(block => block.top + block.height > line);
  if (index < 0) return null;
  const block = candidates[index]!;
  const text = readingText(block.text);
  const offset = Math.max(0, Math.min(1, (line - block.top) / block.height));
  const weights = candidates.map(item => readingText(item.text).length);
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  const completed = weights.slice(0, index).reduce((sum, weight) => sum + weight, 0) + weights[index]! * offset;
  return parseReadingPosition({ blockId: block.id, quote: text.slice(0, MAX_QUOTE), fingerprint: fingerprint(text), length: text.length,
    offset: Math.round(offset * 1000) / 1000, percent: Math.round(completed / total * 1000) / 10, sourceRevision });
}

/** Stable ids are hints; both the text witness and its fingerprint must still agree. */
export function findReadingPosition(position: ReadingPosition, blocks: readonly ReadingBlock[]): { kind: "found"; index: number } | { kind: "missing" | "ambiguous" } {
  const matches = (block: ReadingBlock) => {
    const text = readingText(block.text);
    return text.length === position.length && text.startsWith(position.quote) && fingerprint(text) === position.fingerprint;
  };
  const identities = blocks.map((block, index) => ({ block, index })).filter(({ block }) => block.id === position.blockId && matches(block));
  if (identities.length === 1) return { kind: "found", index: identities[0]!.index };
  const words = blocks.map((block, index) => ({ block, index })).filter(({ block }) => matches(block));
  if (words.length === 1) return { kind: "found", index: words[0]!.index };
  return { kind: words.length ? "ambiguous" : "missing" };
}

/** Direct content blocks only; notes, comments and page furniture never enter a saved position. */
export function readingBlocksIn(article: HTMLElement): { blocks: ReadingBlock[]; elements: HTMLElement[] } {
  const elements = [...article.querySelectorAll<HTMLElement>(":scope > [data-block]")]
    .filter(element => element.tagName !== "FIGURE" && readingText(element.textContent ?? "").length > 0);
  const blocks = elements.map(element => {
    const rect = element.getBoundingClientRect();
    return { id: element.dataset.block ?? "", text: element.textContent ?? "", top: rect.top, height: rect.height };
  });
  return { blocks, elements };
}
