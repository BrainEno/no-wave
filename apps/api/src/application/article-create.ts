import { slugifyArticleTitle, uniquifyArticleSlug } from "../domain/article-slug.ts";
import { ArticleSlugConflictError } from "../domain/errors.ts";
import type { StoredArticle } from "./persistence-ports.ts";
import type { ArticleCreateServiceInput } from "./services.ts";

/**
 * Create an article, resolving its slug.
 *
 * A slug is never authored by hand: it is derived from the title when the client
 * did not supply one, and the database's unique index owns uniqueness. A derived
 * slug that is already taken is therefore re-suffixed rather than surfaced as a
 * conflict the author cannot resolve — while an *explicit* slug that collides is
 * a real `409`, because someone asked for that exact address.
 *
 * This lived inside the REST handler until the Notion import needed it too
 * (ADR 0037). Two copies of "which slug will this become" would drift, and the
 * drift would be invisible: a work imported through the API would get a
 * different address than the same work created in the desk.
 */
export const MAX_AUTO_SLUG_ATTEMPTS = 25;

/**
 * A create request before the store sees it: exactly what the caller knows.
 *
 * `slug` stays optional and means "the address I want": an absent one is derived
 * from the title and may be re-suffixed, a present one is honoured and a collision
 * is a real conflict.
 */
export type ArticleCreateRequest =
  Omit<ArticleCreateServiceInput, "authorId" | "slug" | "idempotencyKey" | "requestedSlug">
  & { slug?: string };

export async function createArticleWithSlug(
  createArticle: (input: ArticleCreateServiceInput) => Promise<StoredArticle> | StoredArticle,
  input: ArticleCreateRequest,
  authorId: string,
  idempotencyKey: string | null,
): Promise<StoredArticle> {
  const requestedSlug = typeof input.slug === "string" && input.slug.length > 0 ? input.slug : null;
  const baseSlug = requestedSlug ?? slugifyArticleTitle(input.title);
  for (let attempt = 1; ; attempt += 1) {
    const slug = attempt === 1 ? baseSlug : uniquifyArticleSlug(baseSlug, attempt);
    try {
      return await createArticle({ ...input, slug, authorId, idempotencyKey, requestedSlug });
    } catch (error: unknown) {
      const retryable = requestedSlug === null && error instanceof ArticleSlugConflictError && attempt < MAX_AUTO_SLUG_ATTEMPTS;
      if (!retryable) throw error;
    }
  }
}
