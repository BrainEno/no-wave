import { isUuid } from "./validation.ts";

/**
 * A cursor is where a reader of a list got to — the sort key of the last row
 * they saw.
 *
 * It is deliberately **not** opaque. A client that has just read a page can
 * build the next cursor from the last row it received, which is what lets a
 * paginated list stay a plain array in the response body: no envelope, no
 * `nextCursor` field, and therefore no change to the shape every existing
 * reader already parses. A page that comes back empty is the end.
 *
 * The cost of being readable is that it has to be validated, because a stranger
 * can hand us anything. Decoding therefore answers `null` for anything it does
 * not recognise rather than throwing: the caller turns that into a `400`.
 *
 * The key is always a millisecond ISO timestamp paired with a UUID, which is the
 * shape of every newest-first list in this API — a creation or publication time
 * and an id to break ties. It was first written for works (ADR 0022 reuses it
 * for the media library) and it is deliberately *not* a work-specific type: the
 * two halves of "where the reader is" are the same problem in both places.
 */
const CURSOR_SEPARATOR = "|";
const CURSOR_MAX_LENGTH = 512;
const ISO_MILLISECOND_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** The cursor pointing *past* `at`/`id` in the newest-first order. */
export function encodeCursor(at: string, id: string): string {
  return Buffer.from(`${at}${CURSOR_SEPARATOR}${id}`, "utf8").toString("base64url");
}

/**
 * The place a cursor names, or `null` if it names nothing we recognise.
 *
 * The timestamp is checked for shape rather than merely parsed, because
 * `Date.parse` accepts a great deal that no ISO timestamp ever looks like.
 *
 * The id is checked as a UUID, which is stricter than this API's usual rule that
 * identifiers are opaque strings — and deliberately so. Elsewhere an identifier
 * is *resolved*: the store answers "not found" for anything it does not hold,
 * and a shape check would only be a second, disagreeing definition. Here the id
 * is *compared*, as half of a sort key against a `uuid`/`text` column, so a
 * value that is not one cannot be ordered — it can only fail, in the database,
 * as a `500`. Refusing it here turns that into a `400`.
 */
export function decodeCursor(cursor: unknown): { at: string; id: string } | null {
  if (typeof cursor !== "string" || cursor.length === 0 || cursor.length > CURSOR_MAX_LENGTH) return null;
  let decoded: string;
  try {
    decoded = Buffer.from(cursor, "base64url").toString("utf8");
  } catch {
    return null;
  }
  const at = decoded.indexOf(CURSOR_SEPARATOR);
  if (at <= 0) return null;
  const timestamp = decoded.slice(0, at);
  const id = decoded.slice(1 + at);
  if (!ISO_MILLISECOND_PATTERN.test(timestamp)) return null;
  return isUuid(id) ? { at: timestamp, id } : null;
}
