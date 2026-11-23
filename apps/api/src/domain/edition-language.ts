/**
 * Which language an imported edition is written in, when its source does not
 * say.
 *
 * The public site lists a locale's editions and nothing else (`t.locale = ?` in
 * every published listing), so the 简 home shows Chinese editions and /en shows
 * English ones — as long as each edition is labelled with the language it is
 * actually in. A Notion page did not say: the importer labelled every page that
 * is not the target of another page's `English` relation as `zh-CN`, and an
 * author's standalone English poem landed on the Chinese home and was missing
 * from the English one.
 *
 * The rule is deliberately narrow, because a wrong `en` hides a Chinese work
 * from Chinese readers:
 *
 *   an edition is English when nothing in it — title, summary, or any string in
 *   its blocks — contains a Han, kana or hangul character, and its readable text
 *   (title, summary, and each block's `text`, `attribution`, `caption`, `alt` and
 *   list `items`) contains at least one Latin letter.
 *
 * Everything else stays `zh-CN`. One Chinese character anywhere — a dedication,
 * an image's alt text, a code comment — keeps the edition Chinese. Digits-only
 * and image-only pages stay Chinese too: there is no language to read there.
 *
 * Migrations `0027_edition_language` (SQLite) and `0040_edition_language`
 * (PostgreSQL) relabel already-imported editions with exactly this rule — CJK
 * over the whole stored block JSON, Latin over the same top-level fields — so
 * that a re-import after the backfill finds each page's link in the locale it
 * now plans for. Change one and the other must change with it.
 */

/** Han (incl. Extension A and compatibility), hiragana, katakana and hangul syllables. */
export const CJK_TEXT = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/u;
const LATIN_LETTER = /[A-Za-z]/;

/** The block fields a reader reads. Inline runs repeat `text`, so they add nothing here. */
const PROSE_FIELDS = ["text", "attribution", "caption", "alt"] as const;

export type EditionText = {
  title: string;
  summary?: string | null;
  contentBlocks: readonly unknown[];
};

function proseOf(block: unknown): string[] {
  if (block === null || typeof block !== "object") return [];
  const record = block as Record<string, unknown>;
  const prose: string[] = [];
  for (const field of PROSE_FIELDS) {
    const value = record[field];
    if (typeof value === "string") prose.push(value);
  }
  if (Array.isArray(record.items)) {
    for (const item of record.items) if (typeof item === "string") prose.push(item);
  }
  return prose;
}

/** `en` when the edition reads as English by the rule above, otherwise `zh-CN`. */
export function inferEditionLocale(edition: EditionText): "en" | "zh-CN" {
  const summary = edition.summary ?? "";
  if (CJK_TEXT.test(edition.title) || CJK_TEXT.test(summary) || CJK_TEXT.test(JSON.stringify(edition.contentBlocks))) return "zh-CN";
  if (LATIN_LETTER.test(edition.title) || LATIN_LETTER.test(summary)) return "en";
  return edition.contentBlocks.some((block) => proseOf(block).some((text) => LATIN_LETTER.test(text))) ? "en" : "zh-CN";
}
