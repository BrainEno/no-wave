/**
 * Which media assets a piece of stored content points at (issue #156).
 *
 * The reference scan answers two different questions with one rule:
 *
 * 1. "Is this image an orphan?" — asked by the media library, over every work
 *    body and every avatar.
 * 2. "Is it safe to delete this row now?" — asked *inside* a write transaction
 *    by both providers, over the rows that transaction is about to change.
 *
 * The second question cannot be answered by re-reading the table the way the
 * first one is. Under PostgreSQL's READ COMMITTED a save that commits while the
 * guarded delete is scanning leaves the scan blind: the delete then removes a row
 * a live work points at, and the object after it. The fix is to make the *writer*
 * name its references, so the delete can lock exactly those rows — which means
 * the writer needs the same "what is a media URL" rule, in a place persistence can
 * import without importing the application layer.
 *
 * Deliberately `/media/<uuid>` and not `/api/media/<uuid>`: the Web app serves
 * `/api/media/<id>` and relays it, the API's own route is `/api/v1/media/<id>`,
 * and a client that talks to the API directly (the Flutter app) stores an
 * absolute `https://…/api/v1/media/<id>`. Matching the path suffix covers all
 * three — and a stray `/media/<uuid>` in a code block counts too, which is the
 * direction a mistake should go: it refuses a delete rather than allowing one.
 */
export const MEDIA_SRC_PATTERN =
  /\/media\/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})/gi;

const MAX_DEPTH = 64;

/**
 * Every media asset id a body of content mentions, lower-cased and deduplicated.
 *
 * Walks the parsed value rather than its serialized text: a body reaches the
 * stores as JSON (SQLite keeps it as text, PostgreSQL as `jsonb`), and the writer
 * holding the object form should not have to stringify it first just to be
 * scanned again.
 *
 * An unreadable value answers an empty list rather than throwing: this runs
 * inside somebody's save, and a save that fails because its content could not be
 * scanned would be a worse bug than a reference the delete scan still catches.
 */
export function collectMediaAssetIds(content: unknown): string[] {
  const ids = new Set<string>();
  const seen = new Set<object>();
  const visit = (value: unknown, depth: number): void => {
    if (depth > MAX_DEPTH || value === null || value === undefined) return;
    if (typeof value === "string") {
      for (const match of value.matchAll(MEDIA_SRC_PATTERN)) {
        const id = match[1]?.toLowerCase();
        if (id) ids.add(id);
      }
      return;
    }
    if (typeof value !== "object") return;
    // A cyclic value is a programming mistake, and recursing into it would turn
    // a save into a stack overflow; the reference it hides is lost either way.
    if (seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry, depth + 1);
      return;
    }
    for (const entry of Object.values(value as Record<string, unknown>)) visit(entry, depth + 1);
  };
  visit(content, 0);
  return [...ids];
}
