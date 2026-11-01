/**
 * Reading marks — the passages a reader underlined, and what they wrote beside
 * them.
 *
 * Two decisions shape the whole module, and both are about *where the marks
 * live*: they are kept in the reader's own browser (localStorage, one entry per
 * work) and they are re-found from the text rather than from a position. The
 * first is why nothing here needs an account, an endpoint or a port method; the
 * second is why a passage survives the work being edited, which a bare offset
 * would not.
 *
 * Everything in this file is pure. The DOM — collecting the text, turning a
 * selection into offsets, painting the marks — is the component's half, and it
 * is deliberately the only half that needs a browser.
 */

/** How much of a passage may be marked at all. */
export const PASSAGE_LIMIT = 240;
/** How long a note beside a passage may be. */
export const NOTE_LIMIT = 280;
/** How many passages one work can hold: a shelf, not a database. */
export const PASSAGES_PER_WORK = 50;
/** How much text on each side of a passage is remembered, to find it again. */
const CONTEXT = 48;

export const PASSAGE_STORAGE_PREFIX = "nw-passages-v1:";

/** One marked passage. `start`/`end` are offsets into the work's text. */
export type Passage = {
  id: string;
  start: number;
  end: number;
  text: string;
  /** The text just before the passage, for finding it again after an edit. */
  prefix: string;
  /** The text just after it. */
  suffix: string;
  note: string;
  createdAt: number;
  updatedAt: number;
};

/** What identifies a passage before it is saved. */
export type PassageAnchor = Pick<Passage, "start" | "end" | "text" | "prefix" | "suffix">;

/** Characters, not UTF-16 units: an emoji is one character to a reader. */
export const characterCount = (value: string): number => Array.from(value).length;

/** One key per work, so a mark on one page can never appear on another. */
export const passageStorageKey = (slug: string): string => `${PASSAGE_STORAGE_PREFIX}${slug}`;

/** The anchor for a span of the work's text, with the context around it. */
export function anchorIn(sourceText: string, start: number, end: number): PassageAnchor {
  const text = sourceText.slice(start, end);
  return {
    start,
    end,
    text,
    prefix: sourceText.slice(Math.max(0, start - CONTEXT), start),
    suffix: sourceText.slice(end, end + CONTEXT),
  };
}

/**
 * Read the saved passages back.
 *
 * Anything unrecognised is dropped rather than repaired: this is data the
 * reader's own browser wrote, and a malformed entry is a bug or a hand-edited
 * value, not something to guess at. An empty shelf is a perfectly good answer.
 */
export function parsePassages(raw: string | null): Passage[] {
  if (!raw) return [];
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return []; }
  if (!Array.isArray(value)) return [];
  const passages: Passage[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const item = entry as Record<string, unknown>;
    const { id, start, end, text } = item;
    if (typeof id !== "string" || id.length === 0) continue;
    if (typeof text !== "string" || text.length === 0 || characterCount(text) > PASSAGE_LIMIT) continue;
    // A missing note is not a broken entry: it is a mark without words beside
    // it, which is the ordinary case. Only a note too long to be one is refused.
    const note = typeof item.note === "string" ? item.note : "";
    if (characterCount(note) > NOTE_LIMIT) continue;
    if (typeof start !== "number" || typeof end !== "number" || !Number.isInteger(start) || !Number.isInteger(end)) continue;
    if (start < 0 || end <= start) continue;
    passages.push({
      id: id.slice(0, 80),
      start,
      end,
      text,
      prefix: typeof item.prefix === "string" ? item.prefix.slice(-CONTEXT) : "",
      suffix: typeof item.suffix === "string" ? item.suffix.slice(0, CONTEXT) : "",
      note,
      createdAt: typeof item.createdAt === "number" && Number.isFinite(item.createdAt) ? item.createdAt : 0,
      updatedAt: typeof item.updatedAt === "number" && Number.isFinite(item.updatedAt) ? item.updatedAt : 0,
    });
    if (passages.length >= PASSAGES_PER_WORK) break;
  }
  return passages;
}

/**
 * Is this the same passage?
 *
 * Same offsets, or the same words in the same surroundings: after the work is
 * edited the offsets move, so the context is what still recognises it.
 */
export function findPassage(passages: readonly Passage[], anchor: PassageAnchor): Passage | undefined {
  return passages.find((passage) =>
    (passage.start === anchor.start && passage.end === anchor.end)
    || (passage.text === anchor.text && passage.prefix === anchor.prefix && passage.suffix === anchor.suffix));
}

export type UpsertResult = { passages: Passage[]; passage?: Passage };

/**
 * Add a passage, or rewrite the note on one that is already there.
 *
 * Returns the same list when the shelf is full: a reader who has marked fifty
 * passages is told so by the caller, and the existing marks are left alone
 * rather than silently dropped to make room.
 */
export function upsertPassage(
  passages: readonly Passage[],
  anchor: PassageAnchor,
  note: string,
  now = Date.now(),
): UpsertResult {
  const trimmed = note.trim().slice(0, NOTE_LIMIT);
  const existing = findPassage(passages, anchor);
  if (existing) {
    const updated: Passage = { ...existing, note: trimmed, updatedAt: now };
    return { passages: passages.map((passage) => (passage.id === existing.id ? updated : passage)), passage: updated };
  }
  if (passages.length >= PASSAGES_PER_WORK) return { passages: [...passages] };
  const passage: Passage = {
    id: `p-${now.toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
    start: anchor.start,
    end: anchor.end,
    text: anchor.text,
    prefix: anchor.prefix,
    suffix: anchor.suffix,
    note: trimmed,
    createdAt: now,
    updatedAt: now,
  };
  return { passages: [...passages, passage], passage };
}

export function removePassage(passages: readonly Passage[], id: string): Passage[] {
  return passages.filter((passage) => passage.id !== id);
}

/**
 * Where a passage sits in the work *now*.
 *
 * The remembered offsets are tried first — the common case, where nothing has
 * changed. When they no longer hold the same words, every occurrence of the
 * passage is scored: two points for the remembered text before it, two for the
 * text after, and the nearest one wins a tie. A passage whose words are gone
 * from the work cannot be marked any more, and `null` is the honest answer —
 * the mark itself is kept, so it comes back if the words do.
 */
export function relocate(passage: PassageAnchor, sourceText: string): { start: number; end: number } | null {
  if (sourceText.slice(passage.start, passage.end) === passage.text) return { start: passage.start, end: passage.end };
  const candidates: number[] = [];
  for (let cursor = 0; cursor <= sourceText.length - passage.text.length; cursor += 1) {
    const index = sourceText.indexOf(passage.text, cursor);
    if (index < 0) break;
    candidates.push(index);
    cursor = index + Math.max(1, passage.text.length) - 1;
  }
  let best: { index: number; score: number; distance: number } | null = null;
  for (const index of candidates) {
    const score = (passage.prefix.length > 0 && sourceText.slice(Math.max(0, index - passage.prefix.length), index) === passage.prefix ? 2 : 0)
      + (passage.suffix.length > 0 && sourceText.slice(index + passage.text.length, index + passage.text.length + passage.suffix.length) === passage.suffix ? 2 : 0);
    const distance = Math.abs(index - passage.start);
    if (!best || score > best.score || (score === best.score && distance < best.distance)) best = { index, score, distance };
  }
  if (!best) return null;
  return { start: best.index, end: best.index + passage.text.length };
}

/** The passage as it appears on the shelf: the whole thing if it fits. */
export function passageExcerpt(text: string, limit = 80): string {
  if (characterCount(text) <= limit) return text;
  return `${Array.from(text).slice(0, limit).join("")}…`;
}
