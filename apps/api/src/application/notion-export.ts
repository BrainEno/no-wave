import type { NotionBundle, NotionBundlePage } from "./notion-bundle.ts";
import { MAX_IMPORT_PAGES } from "./notion-import.ts";
import {
  DEFAULT_WORK_TYPE_BY_TAG,
  notionPageFromArticleDraft,
  type InterchangeIssue,
  type NotionPropertyNames,
  type NotionPropertyValue,
} from "./notion-interchange.ts";
import { SUPPORTED_ARTICLE_LOCALES } from "../domain/article.ts";
import type {
  PersistenceResult,
  StoredArticle,
  StoredExternalContentLink,
  StoredTaxonomy,
} from "./persistence-ports.ts";

/**
 * Export the caller's own works as a Notion bundle (ADR 0036, phase 3).
 *
 * This is the inverse of `notion-import.ts`, and deliberately shares its parts
 * rather than its code: the same mapping (`notion-interchange.ts`) decides how a
 * block and a property are written, the same bundle shape is produced, and the
 * same provenance table is consulted — from the other side. An export therefore
 * cannot drift from an import, because a bundle this module produces is a bundle
 * the import endpoint already accepts; `notion-export.test.ts` proves it by
 * feeding one back through `parseNotionBundle` and the mapping.
 *
 * Three questions are decided here and nowhere else:
 *
 *  - **Which edition describes the work.** A work has one address and up to three
 *    locales; Notion has pages. The primary page is the edition in this site's
 *    own order of preference (`zh-CN`, then `zh-TW`, then `en`), so the same work
 *    exports the same way twice.
 *  - **Which page id a page carries.** If the edition came from Notion, the
 *    bundle names *that* page, so pushing it back is an update of the page the
 *    author already has. A work that was written here has no such page, and
 *    inventing a Notion id would make a client create a page it cannot later find
 *    again; it gets a stable `site:` id instead, marked as such in the report.
 *  - **What cannot be said in Notion.** A second translation language and a work
 *    type that its own tags do not imply are both reported rather than dropped
 *    silently: they are the two places a round trip would otherwise change the
 *    author's work without saying so.
 *
 * Nothing here writes. An export is a read of the caller's own rows, scoped by
 * `actorId` at every step: `listMyArticleEditions` and
 * `listExternalContentLinks` both take the account as a predicate, so another
 * author's slug is indistinguishable from a nonexistent one.
 */

export const NOTION_EXPORT_PROVIDER = "notion";

/**
 * How many works one request may export.
 *
 * Bounded by the *import* rather than by taste: an exported bundle has to be a
 * bundle the import endpoint accepts, and that endpoint takes at most
 * {@link MAX_IMPORT_PAGES} pages. Two pages per work is what the mapping can
 * carry today (a work and its `en` edition), so 50 works is 100 pages — well
 * inside the ceiling, with room for the mapping to grow a language without this
 * number turning into a silent failure.
 */
export const MAX_EXPORT_WORKS = 50;

/**
 * The page id a work that was never imported carries.
 *
 * Not a Notion id on purpose: a real one would be a lie (Notion never issued it)
 * and could collide with the author's own database. The prefix, the article id
 * and the locale make it stable across exports and unique per edition, so two
 * exports of the same work are byte-identical and a client can diff them.
 */
export const SITE_PAGE_ID_PREFIX = "site:";

/** The bundle's own label; the author's target database is theirs to name. */
export const EXPORT_DATABASE_TITLE = "no-wave export";

/**
 * The one translation locale the mapping can carry.
 *
 * `groupNotionWorks` reads a linked page as `en` — the site's other locale is the
 * *primary* edition's, not a translation. A `zh-TW` edition of a `zh-CN` work
 * therefore has no page to travel in, and is reported instead of being written
 * into the wrong language.
 */
const CARRIED_TRANSLATION_LOCALES: ReadonlySet<string> = new Set(["en"]);

/** Export order of editions: the site's own preference, primary first. */
const PRIMARY_LOCALE_ORDER: readonly string[] = [...SUPPORTED_ARTICLE_LOCALES];

export type NotionExportProvenance =
  /** The page this edition was imported from (ADR 0037). */
  | "notion"
  /** A page id this API made up, because the work was written here. */
  | "site";

/** One page of the bundle, and where its id came from. */
export type NotionExportPageReport = {
  locale: string;
  pageId: string;
  provenance: NotionExportProvenance;
  articleId: string;
  issues: InterchangeIssue[];
};

/** One work: the address, the editions that travelled, and what did not. */
export type NotionExportWorkReport = {
  slug: string;
  articleId: string;
  title: string;
  /** The edition whose properties and body describe the work. */
  primaryLocale: string;
  pages: NotionExportPageReport[];
  issues: InterchangeIssue[];
};

export type NotionExportReport = {
  works: NotionExportWorkReport[];
  /**
   * Slugs that are not an edition of one of the caller's live works.
   *
   * A work in the recycle bin is one of these: it is deleted, not exportable, and
   * deleting it released its address. The request still succeeds, exactly like a
   * list read of an empty result, because a page of slugs is a selection rather
   * than a single resource.
   */
  missing: string[];
  summary: { works: number; pages: number; missing: number };
};

/**
 * The service methods this module is allowed to use.
 *
 * Narrowed like the import's dependency bag: an export that could also write, or
 * read another author's works, would be one careless edit away from doing so.
 */
export type NotionExportDeps = {
  listMyArticleEditions(input: { slug: string; actorId: string }): PersistenceResult<StoredArticle[]>;
  listExternalContentLinks(input: { provider: string; articleId: string; ownerId: string }): PersistenceResult<StoredExternalContentLink[]>;
  listArticlesTaxonomies(input: { articleIds: readonly string[]; kind: string; locale?: string }): PersistenceResult<Record<string, StoredTaxonomy[]>>;
};

/**
 * A request that cannot be answered at all — no slugs, or too many.
 *
 * Per-work trouble never throws: a slug that is not the caller's is a line in
 * `missing`, and a work that cannot say everything about itself is a line in its
 * own `issues`.
 */
export class NotionExportRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotionExportRequestError";
  }
}

/**
 * The one edition whose properties describe the work.
 *
 * Deterministic and stated: the first locale in the site's own order that the
 * work actually has. Not "the newest" and not "the first row", because an export
 * has to answer the same way on SQLite and PostgreSQL and twice in a row.
 */
function primaryEdition(editions: readonly StoredArticle[]): StoredArticle {
  for (const locale of PRIMARY_LOCALE_ORDER) {
    const found = editions.find((edition) => edition.locale === locale);
    if (found) return found;
  }
  // The store only returns supported locales; this is a guard, not a case.
  return editions[0]!;
}

/** The stored blocks of one edition, as the mapping takes them. */
function contentBlocksOf(article: StoredArticle): Record<string, unknown>[] {
  if (!Array.isArray(article.contentBlocks)) {
    throw new Error(`article ${article.id} has no block array to export`);
  }
  return article.contentBlocks as Record<string, unknown>[];
}

/**
 * What work type the import would derive from these tag names.
 *
 * The same rule as `articleDraftFromNotionPage`, applied in the other direction
 * to answer one question: would a round trip change this work's type? It reads
 * the default table rather than the caller's, because the report is about the
 * mapping's defaults — the options an author passes to an import are theirs to
 * vary, and this endpoint cannot know them.
 */
function workTypeFromTags(tags: readonly string[]): string {
  return tags.map((tag) => DEFAULT_WORK_TYPE_BY_TAG[tag]).find((type): type is string => typeof type === "string") ?? "other";
}

/** The page id for one edition: the page it came from, or a stable one of ours. */
function pageIdFor(edition: StoredArticle, links: Map<string, StoredExternalContentLink>): { pageId: string; provenance: NotionExportProvenance } {
  const link = links.get(edition.locale);
  return link
    ? { pageId: link.externalId, provenance: "notion" }
    : { pageId: `${SITE_PAGE_ID_PREFIX}${edition.id}:${edition.locale}`, provenance: "site" };
}

/**
 * Export the caller's works: one bundle, plus what the bundle could not say.
 *
 * The bundle is the answer; the report is what a reader of the response needs in
 * order to trust it — which pages are updates of Notion pages and which are new,
 * which requested works were not found, and where a round trip would differ from
 * the original.
 */
export async function exportNotionBundle(input: {
  actorId: string;
  slugs: readonly string[];
  deps: NotionExportDeps;
  propertyNames?: Partial<NotionPropertyNames>;
}): Promise<{ bundle: NotionBundle; report: NotionExportReport }> {
  const slugs = [...new Set(input.slugs.map((slug) => slug.trim()).filter((slug) => slug.length > 0))];
  if (slugs.length === 0) throw new NotionExportRequestError("At least one work slug is required.");
  if (slugs.length > MAX_EXPORT_WORKS) {
    throw new NotionExportRequestError(
      `A single export may carry at most ${MAX_EXPORT_WORKS} works; this request asks for ${slugs.length}.`,
    );
  }

  // Resolve every slug before reading anything else: what is missing is part of
  // the answer, and a request that names only unknown works is still a request.
  const resolved: StoredArticle[][] = [];
  const missing: string[] = [];
  for (const slug of slugs) {
    const editions = await input.deps.listMyArticleEditions({ slug, actorId: input.actorId });
    if (editions.length === 0) {
      missing.push(slug);
      continue;
    }
    resolved.push([...editions]);
  }

  const plans = resolved.map((editions) => {
    const primary = primaryEdition(editions);
    return {
      primary,
      translations: editions.filter((edition) => edition.locale !== primary.locale),
    };
  });

  // Tags are a property of the work, not of an edition, so they are read once in
  // the primary edition's language — and for every work at once, one statement
  // per locale used rather than one per work.
  const idsByLocale = new Map<string, string[]>();
  for (const plan of plans) {
    const ids = idsByLocale.get(plan.primary.locale) ?? [];
    ids.push(plan.primary.id);
    idsByLocale.set(plan.primary.locale, ids);
  }
  const tagNames = new Map<string, string[]>();
  for (const [locale, articleIds] of idsByLocale) {
    const rows = await input.deps.listArticlesTaxonomies({ articleIds, kind: "tag", locale });
    for (const [articleId, tags] of Object.entries(rows)) {
      tagNames.set(articleId, tags.filter((tag) => tag.kind === "tag").map((tag) => tag.name));
    }
  }

  const pages: NotionBundlePage[] = [];
  const works: NotionExportWorkReport[] = [];

  for (const plan of plans) {
    const { primary, translations } = plan;
    const links = new Map(
      (await input.deps.listExternalContentLinks({
        provider: NOTION_EXPORT_PROVIDER,
        articleId: primary.id,
        ownerId: input.actorId,
      })).map((link) => [link.locale, link]),
    );
    const tags = tagNames.get(primary.id) ?? [];
    // One work, one status, one instant — the same rule the import applies in
    // reverse, so a bundle describes a work rather than three unrelated pages.
    const publish = primary.status === "published";
    const publishedAt = primary.publishedAt;

    const workIssues: InterchangeIssue[] = [];
    const editions: StoredArticle[] = [primary];
    for (const edition of translations) {
      if (CARRIED_TRANSLATION_LOCALES.has(edition.locale)) {
        editions.push(edition);
        continue;
      }
      workIssues.push({
        code: "translation-locale-not-carried",
        detail: `${edition.locale}: a translated edition travels only as \`en\` in a Notion database; this one is not in the bundle`,
      });
    }

    const derivedType = workTypeFromTags(tags);
    if (derivedType !== primary.workType) {
      workIssues.push({
        code: "work-type-not-carried",
        detail: `${primary.workType} (tags: ${tags.length > 0 ? tags.join(", ") : "none"}) would import back as ${derivedType}`,
      });
    }

    const pageReports: NotionExportPageReport[] = [];
    const ids = editions.map((edition) => pageIdFor(edition, links));
    for (const [index, edition] of editions.entries()) {
      const { pageId, provenance } = ids[index]!;
      const related = ids.filter((_, other) => other !== index).map((entry) => entry.pageId);
      const built = notionPageFromArticleDraft(
        {
          title: edition.title,
          summary: edition.summary,
          // The address is the work's, in every edition: Notion keeps a `Slug`
          // property per page, and the site has one address per work.
          slug: primary.slug,
          tags,
          publish,
          publishedAt,
          contentBlocks: contentBlocksOf(edition),
        },
        { propertyNames: input.propertyNames },
      );
      const properties: Record<string, NotionPropertyValue> = { ...built.properties };
      if (related.length > 0) {
        // The relation the author's own database carries, on both sides: a client
        // that creates these pages gets the pairing without a second pass.
        properties.English = { type: "relation", relation: related.map((id) => ({ id })) };
      }
      pages.push({ id: pageId, properties, blocks: built.children });
      pageReports.push({ locale: edition.locale, pageId, provenance, articleId: edition.id, issues: built.issues });
    }

    works.push({
      slug: primary.slug,
      articleId: primary.id,
      title: primary.title,
      primaryLocale: primary.locale,
      pages: pageReports,
      issues: workIssues,
    });
  }

  // An exported bundle must be one the import endpoint will accept; the work cap
  // makes this unreachable today, and the guard is what keeps it true if the
  // mapping grows a third language.
  if (pages.length > MAX_IMPORT_PAGES) {
    throw new NotionExportRequestError(
      `This selection produces ${pages.length} pages; an import may carry at most ${MAX_IMPORT_PAGES}. Export fewer works.`,
    );
  }

  return {
    bundle: { version: 1, database: { id: "", title: EXPORT_DATABASE_TITLE }, pages },
    report: {
      works,
      missing,
      summary: { works: works.length, pages: pages.length, missing: missing.length },
    },
  };
}
