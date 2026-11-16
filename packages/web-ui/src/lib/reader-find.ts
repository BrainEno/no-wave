export type ReadingFindOptions = { caseSensitive: boolean; foldWidth: boolean };
export type ReadingFindBlock = { id: string; text: string };
export type ReadingMatch = {
  blockId: string; blockIndex: number; start: number; end: number;
  text: string; before: string; after: string;
};
export type ReadingFindResult = { matches: ReadingMatch[]; moreMatches: boolean; limitedText: boolean; invalidQuery: boolean; unavailable: boolean };
const FIND_TEXT_LIMIT = 200_000;
const FIND_MATCH_LIMIT = 200;
const FIND_QUERY_LIMIT = 100;
const graphemes = typeof Intl.Segmenter === "function" ? new Intl.Segmenter(undefined, { granularity: "grapheme" }) : null;

type FoldedText = { value: string; starts: number[]; ends: number[] };

/** Keep source offsets for every folded code unit, including expanded ligatures and combining marks. */
function foldedText(source: string, options: ReadingFindOptions): FoldedText {
  const starts: number[] = [];
  const ends: number[] = [];
  const output: string[] = [];
  for (const { segment, index } of graphemes?.segment(source) ?? []) {
    let folded = segment.normalize(options.foldWidth ? "NFKC" : "NFC");
    if (!options.caseSensitive) folded = folded.toLowerCase();
    for (const unit of folded.split("")) {
      const character = /\s/u.test(unit) ? " " : unit;
      if (character === " " && output.at(-1) === " ") {
        ends[ends.length - 1] = index + segment.length;
        continue;
      }
      output.push(character);
      starts.push(index);
      ends.push(index + segment.length);
    }
  }
  return { value: output.join(""), starts, ends };
}

export function findInReadingBlocks(blocks: readonly ReadingFindBlock[], query: string, options: ReadingFindOptions): ReadingFindResult {
  const total = blocks.reduce((sum, block) => sum + block.text.length, 0);
  const result: ReadingFindResult = { matches: [], moreMatches: false, limitedText: total > FIND_TEXT_LIMIT, invalidQuery: false, unavailable: graphemes === null };
  if (!graphemes) return result;
  if (query.length > FIND_QUERY_LIMIT || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\p{Cs}]/u.test(query)) {
    result.invalidQuery = true;
    return result;
  }
  const needle = foldedText(query.trim(), options).value;
  if (!needle) return result;
  let remaining = FIND_TEXT_LIMIT;
  for (let blockIndex = 0; blockIndex < blocks.length && remaining > 0; blockIndex++) {
    const block = blocks[blockIndex]!;
    let original = block.text.slice(0, remaining);
    if (/[\uD800-\uDBFF]$/.test(original)) original = original.slice(0, -1);
    remaining -= block.text.length;
    if (!original) continue;
    const folded = foldedText(original, options);
    let cursor = 0;
    let lastStart = -1, lastEnd = -1;
    while (cursor <= folded.value.length - needle.length) {
      const at = folded.value.indexOf(needle, cursor);
      if (at < 0) break;
      const start = folded.starts[at]!;
      const end = folded.ends[at + needle.length - 1]!;
      cursor = at + needle.length;
      if (start === lastStart && end === lastEnd) continue;
      if (result.matches.length === FIND_MATCH_LIMIT) { result.moreMatches = true; return result; }
      result.matches.push({ blockId: block.id, blockIndex, start, end, text: original.slice(start, end),
        before: original.slice(Math.max(0, start - 40), start), after: original.slice(end, end + 40) });
      lastStart = start;
      lastEnd = end;
    }
  }
  return result;
}

export function nextReadingMatch(current: number, direction: -1 | 1, count: number): number {
  if (!Number.isSafeInteger(count) || count <= 0) return -1;
  if (!Number.isSafeInteger(current) || current < 0 || current >= count) return direction === 1 ? 0 : count - 1;
  return (current + direction + count) % count;
}

const NON_READING = "script, style, [hidden], [aria-hidden='true']";
const TEXT_BOUNDARY = /^(?:P|DIV|LI|UL|OL|BLOCKQUOTE|H[1-6]|PRE|BR)$/;
type ReadingTextSpan = { node: Text; start: number; end: number };

/** Virtual line breaks preserve rendered word boundaries without changing the author's DOM. */
function readingTextIndex(element: HTMLElement): { text: string; spans: ReadingTextSpan[] } {
  const parts: string[] = [];
  const spans: ReadingTextSpan[] = [];
  let offset = 0;
  if (element.closest(NON_READING)) return { text: "", spans };
  const boundary = () => {
    if (offset && !/\s$/u.test(parts.at(-1)!)) { parts.push("\n"); offset++; }
  };
  const stack = [...element.childNodes].reverse().map(node => ({ node, exit: false }));
  while (stack.length) {
    const { node, exit } = stack.pop()!;
    if (exit) { boundary(); continue; }
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node as Text;
      if (text.data.length) {
        spans.push({ node: text, start: offset, end: offset + text.data.length });
        parts.push(text.data);
        offset += text.data.length;
      }
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      const child = node as Element;
      if (child.matches(NON_READING)) continue;
      if (TEXT_BOUNDARY.test(child.tagName)) {
        boundary();
        stack.push({ node, exit: true });
      }
      for (const nested of [...child.childNodes].reverse()) stack.push({ node: nested, exit: false });
    }
  }
  return { text: parts.join(""), spans };
}

export function readingFindText(element: HTMLElement): string {
  return readingTextIndex(element).text;
}

/** Rebuild offsets and verify the witness; DOM Range.toString omits virtual list/BR separators. */
export function readingMatchRange(element: HTMLElement, match: ReadingMatch): Range | null {
  if (element.dataset.block !== match.blockId) return null;
  const { text, spans } = readingTextIndex(element);
  if (text.slice(match.start, match.end) !== match.text) return null;
  const start = spans.find(span => match.start >= span.start && match.start < span.end);
  const end = spans.find(span => match.end > span.start && match.end <= span.end);
  if (!start || !end) return null;
  const range = element.ownerDocument.createRange();
  range.setStart(start.node, match.start - start.start);
  range.setEnd(end.node, match.end - end.start);
  return range;
}

export function readingFindElements(article: HTMLElement): HTMLElement[] {
  return [...article.querySelectorAll<HTMLElement>(":scope > [data-block]")].filter(element => element.tagName !== "FIGURE");
}
