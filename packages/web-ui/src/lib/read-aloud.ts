import type { ArticleContentBlock, Locale } from "./content.ts";

/**
 * What reading an article aloud is made of.
 *
 * The module is pure on purpose: the component that drives `speechSynthesis`
 * is the part that cannot be tested without a browser, and it is also the part
 * with the least logic in it. Everything that decides *what is said, in what
 * order, and in how many pieces* lives here, where a test can see it.
 *
 * The chunks come from the article's content blocks rather than from scraping
 * the rendered DOM: the blocks are the same data the page renders, they carry
 * stable ids the component can highlight, and they exist on the server too —
 * so the list of chunks is identical before and after hydration.
 */

/** One mouthful. `blockId` is the element the component highlights while it is spoken. */
export type SpeakChunk = { blockId: string; text: string };

/**
 * The longest chunk handed to the speech engine.
 *
 * Short enough that a pause lands between ideas rather than in the middle of
 * one, and that stopping feels immediate: `speechSynthesis.cancel()` cannot
 * interrupt an utterance it has already been given, so the wait after 停止 is
 * at most one chunk.
 */
export const CHUNK_LIMIT = 180;

/** CJK, or not: the two scripts break sentences on different punctuation. */
function isCjk(text: string): boolean {
  return /[\u3000-\u9fff\uff00-\uffef]/.test(text);
}

/** The separator that reads as a pause between list items in either script. */
function listSeparator(items: readonly string[]): string {
  return isCjk(items.join("")) ? "；" : ", ";
}

/**
 * What a block contributes to the reading, or nothing at all.
 *
 * Code is skipped deliberately: spoken aloud it is noise, and a reader who
 * wants it will read it. An image contributes its caption and not its alt text,
 * which is a description of the picture rather than part of the work.
 */
export function blockSpeech(block: ArticleContentBlock): string {
  switch (block.type) {
    case "paragraph":
    case "heading": return block.text.trim();
    case "quote": {
      const text = block.text.trim();
      const attribution = block.attribution?.trim() ?? "";
      return attribution ? `${text}——${attribution}` : text;
    }
    case "list": return block.items.map((item) => item.trim()).filter((item) => item.length > 0).join(listSeparator(block.items));
    case "image": return block.caption?.trim() ?? "";
    case "code": return "";
  }
}

/**
 * Split text into sentences, keeping the punctuation that ended them.
 *
 * Both scripts: `。！？；…` for Chinese and `.!?;` for Latin, each followed by
 * any closing quote or bracket the sentence carried, because a sentence that
 * ends inside a quotation still ends there.
 */
export function splitSentences(text: string): string[] {
  const trimmed = text.trim();
  if (trimmed.length === 0) return [];
  const parts = trimmed.match(/[^。！？；….!?;]+[。！？；….!?;]*["'”’）)】》]*\s*/g);
  if (!parts) return [trimmed];
  return parts.map((part) => part.trim()).filter((part) => part.length > 0);
}

/**
 * Break one long sentence: at punctuation if there is any left, otherwise at
 * the last space or CJK boundary before the limit, so a chunk never cuts a word.
 */
function hardSplit(text: string): string[] {
  const pieces: string[] = [];
  let rest = text;
  while (rest.length > CHUNK_LIMIT) {
    let cut = -1;
    for (let index = Math.min(rest.length - 1, CHUNK_LIMIT); index > CHUNK_LIMIT / 2; index -= 1) {
      const character = rest[index];
      if (/[，、,;；:：)）】》"”]/.test(character)) { cut = index + 1; break; }
      if (character === " ") { cut = index + 1; break; }
    }
    if (cut <= 0) cut = isCjk(rest) ? CHUNK_LIMIT : (rest.lastIndexOf(" ", CHUNK_LIMIT) > 0 ? rest.lastIndexOf(" ", CHUNK_LIMIT) + 1 : CHUNK_LIMIT);
    pieces.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest.length > 0) pieces.push(rest);
  return pieces.filter((piece) => piece.length > 0);
}

/**
 * The pieces, in order, with the block each one belongs to.
 *
 * Sentences are grouped up to the limit rather than split across chunks, so a
 * pause lands where the author put one. A sentence longer than the limit is cut
 * at a punctuation mark or a word boundary instead of mid-word.
 */
export function speakChunks(blocks: readonly ArticleContentBlock[]): SpeakChunk[] {
  const chunks: SpeakChunk[] = [];
  for (const block of blocks) {
    const text = blockSpeech(block);
    if (text.length === 0) continue;
    for (const sentence of splitSentences(text)) {
      if (sentence.length <= CHUNK_LIMIT) {
        const last = chunks[chunks.length - 1];
        // Join inside a block only: two blocks never share a chunk, because the
        // highlight follows the block and one chunk can only point at one.
        if (last && last.blockId === block.id && `${last.text} ${sentence}`.length <= CHUNK_LIMIT) {
          chunks[chunks.length - 1] = { blockId: block.id, text: `${last.text} ${sentence}` };
        } else {
          chunks.push({ blockId: block.id, text: sentence });
        }
        continue;
      }
      for (const piece of hardSplit(sentence)) chunks.push({ blockId: block.id, text: piece });
    }
  }
  return chunks;
}

/**
 * The BCP-47 tag handed to the speech engine.
 *
 * The article's locale is already one, so this is a pass-through rather than a
 * mapping — but it is here so the component never has to invent a tag, and so
 * the choice is visible in one place: the engine is asked for the language the
 * work was written in and picks its own voice for it.
 */
export function speechLang(locale: Locale): string {
  return locale === "en" ? "en-US" : locale;
}

/**
 * Where a chunk sits among the *blocks*: the 1-based position of the block it
 * belongs to, and how many blocks are spoken at all.
 *
 * Not the chunk number: a reader counts paragraphs, and a paragraph split into
 * three chunks is still 第 3 段.
 */
export function blockPosition(chunks: readonly SpeakChunk[], index: number): { position: number; total: number } | null {
  const chunk = chunks[index];
  if (!chunk) return null;
  const order: string[] = [];
  for (const candidate of chunks) if (!order.includes(candidate.blockId)) order.push(candidate.blockId);
  return { position: order.indexOf(chunk.blockId) + 1, total: order.length };
}
