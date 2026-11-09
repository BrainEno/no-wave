import { createHmac } from "node:crypto";

/**
 * View counting: what makes one reader opening one work count once (ADR 0035).
 *
 * The hard part of a view counter is not incrementing it, it is deciding what a
 * view *is*. Three answers were available and only one of them is honest for a
 * platform whose works are read, skimmed, quoted in chat, and opened by their
 * own authors to check a typo:
 *
 * - count every request: a refresh loop is reach, and the numbers mean nothing;
 * - count sessions: a session is a browser tab, and one reader in two tabs is
 *   two readers in the only statistic the author has;
 * - count a reader once per work per day: the number is "people who read this
 *   today, summed over days". It is defensible, it cannot be inflated by holding
 *   F5, and it is the number the author actually wants.
 *
 * The unit of "a reader" is a keyed digest, never a stored address: a signed-in
 * reader is keyed by their account id, an anonymous one by their address, and
 * both go through HMAC-SHA-256 with a namespace the repository already owns. The
 * database therefore never holds an IP address or a user id for a view — only a
 * digest that cannot be reversed into either, and that expires with the counter
 * row that holds it (`auth_rate_limits`, the same keyed-counter store the write
 * rate limits use, whose expiry sweep already runs).
 */

/** How long one reader's view of one work is remembered. */
export const ARTICLE_VIEW_WINDOW_SECONDS = 86_400;

/** What one reader may contribute to one work inside that window. */
export const ARTICLE_VIEW_LIMIT = 1;

/**
 * The bucket a view is charged to: `(work, reader, UTC day)`.
 *
 * The day is part of the *key* rather than of the window on purpose. A sliding
 * window ("24 hours since this reader last looked") would need the stored
 * timestamp to be read before the decision, and would make the boundary drift
 * with each view; a UTC day boundary is a fixed, explainable line — the counter
 * rolls over at 00:00 UTC for everyone. A reader who arrives at 23:59 and again
 * at 00:01 counts twice, which is the price of a rule anyone can state in one
 * sentence.
 *
 * `now` is a parameter so the boundary can be tested without waiting for
 * midnight.
 */
export function articleViewDay(now: Date): string {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new TypeError("A valid Date is required to name a view day.");
  }
  return now.toISOString().slice(0, 10);
}

/**
 * Who is reading: the account for a signed-in reader, the address otherwise.
 *
 * Neither value reaches the database in this form — `articleViewKey` hashes it.
 * The prefixes keep the two populations from ever colliding: an account id and
 * an address are different kinds of identifier, and a digest of one must not be
 * able to stand in for the other.
 */
export function articleViewReader(actorId: string | null, address: string): string {
  if (actorId !== null && actorId.length > 0) return `user:${actorId}`;
  return `address:${address.length > 0 ? address : "unknown"}`;
}

/**
 * The dedupe key for one view.
 *
 * Keyed rather than plain so the stored value is not a directory of "who read
 * what" that anyone with database access can enumerate by hashing guesses: the
 * namespace below is derived from the secret first, exactly as the write
 * rate-limit buckets are, so two deployments never produce the same digests for
 * the same reader.
 */
export function articleViewKey(input: {
  secret: string;
  articleId: string;
  viewer: string;
  day: string;
}): string {
  if (typeof input.secret !== "string" || input.secret.length === 0) {
    throw new TypeError("A secret is required to key a view.");
  }
  const namespace = createHmac("sha256", input.secret).update("bot-thk:article-view:v1").digest();
  return createHmac("sha256", namespace)
    .update(JSON.stringify([input.articleId, input.viewer, input.day]))
    .digest("hex");
}

/**
 * Whether this deployment can tell two readers apart at all.
 *
 * A secret shorter than the one the rest of the service requires means the
 * dedupe key would be guessable, and a guessable dedupe key is a counter anyone
 * can inflate by pretending to be new readers. The caller records nothing in
 * that case rather than recording something meaningless — a counter that only
 * ever goes up is worse than a counter that stays still, because the second one
 * looks broken instead of looking successful.
 */
export function articleViewsAvailable(secret: string | undefined): secret is string {
  return typeof secret === "string" && Buffer.byteLength(secret, "utf8") >= 32;
}
