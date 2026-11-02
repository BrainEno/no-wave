import { createHash } from "node:crypto";

/**
 * Article-create idempotency digests, shared by the SQLite and PostgreSQL
 * adapters.
 *
 * The route passes `requestedSlug`: the slug the client actually supplied, or
 * `null` when the server derives one from the title. The fingerprint must use
 * that value rather than the candidate slug the uniquifier is currently trying,
 * otherwise a first write that landed on `title-2` cannot be replayed: the retry
 * starts again at `title` and the two digests disagree (issues #137 / #157).
 */
export type ArticleIdempotencyFingerprintInput = {
  authorId: string;
  /** Explicit client slug, or null when the server generated the address. */
  slug: string | null;
  title: string;
  summary: string;
  locale: string;
  contentBlocks: unknown;
  contentBlocksVersion: number;
  publish: boolean;
  workType: string;
  categoryIds: readonly string[];
  tagIds: readonly string[];
};

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function articleIdempotencyKeyHash(authorId: string, key: string): string {
  return digest({ method: "POST", route: "/api/v1/articles", actorId: authorId, key });
}

export function articleIdempotencyFingerprint(input: ArticleIdempotencyFingerprintInput): string {
  return digest({
    authorId: input.authorId,
    slug: input.slug,
    title: input.title,
    summary: input.summary,
    locale: input.locale,
    contentBlocks: input.contentBlocks,
    contentBlocksVersion: input.contentBlocksVersion,
    publish: input.publish,
    workType: input.workType,
    categoryIds: [...input.categoryIds].sort(),
    tagIds: [...input.tagIds].sort(),
  });
}

/**
 * Accept the stable fingerprint plus any pre-change fingerprints still stored
 * in rows written before `requestedSlug` existed. Explicit-slug requests never
 * get the legacy fallback: a changed explicit slug must remain a conflict.
 */
export function articleIdempotencyReplayMatches(
  storedHash: string | null,
  currentFingerprint: string,
  legacyFingerprints: readonly (string | null)[],
): boolean {
  if (storedHash === currentFingerprint) return true;
  return legacyFingerprints.some((candidate) => candidate !== null && storedHash === candidate);
}
