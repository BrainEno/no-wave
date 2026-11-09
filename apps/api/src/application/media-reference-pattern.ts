/**
 * The one place the reference scan's idea of "a media URL" is written down.
 *
 * Deliberately `/media/<uuid>` and not `/api/media/<uuid>`: the Web app serves
 * `/api/media/<id>` and relays it, and the API's own route is
 * `/api/v1/media/<id>` — which is the address a client that talks to the API
 * directly (the Flutter app) stores in a body. A pattern that matched only one
 * of them marked live cover images and avatars as orphans.
 *
 * Matching the path rather than a full URL also covers an absolute address, and
 * a stray `/media/<uuid>` in a code block would count as a reference, which is
 * the direction a mistake should go: it refuses a delete instead of allowing
 * one.
 */
export const MEDIA_SRC_PATTERN =
  /\/media\/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})/gi;

/**
 * Does this body (or avatar URL) actually *reference* the asset — or merely
 * mention its id?
 *
 * The delete-time backstop used to answer that question with `instr(text, id)`
 * and then hand the caller a fabricated `content` (`/media/<id>`) so the
 * extraction step would agree with it (#243). That made prose the same as
 * evidence: a technical article quoting a UUID, a debug log, a changelog entry —
 * any of them permanently blocked the delete of an asset the library page
 * correctly showed as orphaned.
 *
 * So the two halves of the question are now separated. SQL still narrows the
 * candidates by substring, because that is cheap and can only over-select; this
 * function is the proof, and it is the same pattern the scan, the badge and the
 * extraction use. A row that only mentions the id contributes nothing.
 */
export function contentReferencesMediaAsset(content: unknown, assetId: string): boolean {
  const wanted = assetId.toLowerCase();
  const text = typeof content === "string" ? content : safeJson(content);
  if (text.length === 0) return false;
  for (const match of text.matchAll(MEDIA_SRC_PATTERN)) {
    if (match[1]!.toLowerCase() === wanted) return true;
  }
  return false;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}

