import { ExternalContentConflictError } from "./external-content-conflict.ts";
import { createHash } from "node:crypto";
import { SUPPORTED_ARTICLE_LOCALES } from "../domain/article.ts";
import { prepareNotionImages, type NotionImageCopier } from "./notion-import-images.ts";
import { createArticleWithSlug } from "./article-create.ts";
import {
  emptyNotionSeedState,
  groupNotionWorks,
  idempotencyKeyFor,
  parseNotionBundle,
  planNotionSeed,
  type NotionSeedState,
  type PlannedEdition,
  type PlannedWork,
} from "./notion-bundle.ts";
import type { InterchangeIssue } from "./notion-interchange.ts";
import type {
  ArticleCreateServiceInput,
  ArticleUpdateServiceInput,
} from "./services.ts";
import type {
  CreateTagInput,
  ExternalContentLinkKey,
  PersistenceResult,
  StoredArticle,
  StoredExternalContentLink,
  StoredTaxonomy,
  TaxonomyListInput,
  UpsertExternalContentLinkInput,
} from "./persistence-ports.ts";

/**
 * Import a Notion database bundle into the caller's own works (ADR 0037).
 *
 * This follows the shape of the operator seed that came before it, because the
 * two must agree: the same mapping (`notion-interchange.ts`), the same planner
 * (`notion-bundle.ts`), the same slug rules. What changes is *who* runs it and
 * *where the memory lives*.
 *
 *  - The seed ran as an operator with a token and kept a digest file on the
 *    operator's disk. That cannot serve a signed-in author from a browser: the
 *    endpoint would have to trust a client's "I already imported this", which is
 *    a claim, not a fact.
 *  - Here the memory is `external_content_links` (migration 0033 / 0020), scoped
 *    by owner. A re-import compares the digest it computes against the digest the
 *    server stored, so "unchanged" is a server fact every client agrees on.
 *
 * Everything is scoped to `actorId`: links are looked up by owner, reads go
 * through `getMyArticle`, writes through the same service methods the desk uses.
 * There is no path here that can reach another account's work, and no path that
 * deletes or unpublishes anything — a Notion page that disappeared is reported,
 * never acted on.
 */

export const NOTION_IMPORT_PROVIDER = "notion";

/** Larger than this is a database export, not a set of pages to import. */
export const MAX_IMPORT_PAGES = 200;

export type NotionImportAction = "create" | "update" | "skip" | "refused" | "failed";

/** What happened to one page — one edition of one work. */
export type NotionImportPageReport = {
  externalId: string;
  title: string;
  locale: string;
  action: NotionImportAction;
  slug: string;
  articleId: string | null;
  /** One line a human can read: "created", "unchanged since the last import", … */
  detail: string;
  issues: InterchangeIssue[];
};

export type NotionImportReport = {
  /** `false` for a dry run: nothing was written, and nothing below pretends it was. */
  applied: boolean;
  database: { id: string; title: string | null };
  summary: Record<NotionImportAction, number>;
  pages: NotionImportPageReport[];
};

/**
 * The service methods this module is allowed to use.
 *
 * Narrowed on purpose: an import that could also delete, publish something it
 * did not import, or read another author's drafts would be one careless edit
 * away from doing so. The route passes the composed services; tests pass a stub.
 */
export type NotionImportDeps = {
  createArticle(input: ArticleCreateServiceInput): PersistenceResult<StoredArticle>;
  updateArticle(input: ArticleUpdateServiceInput): PersistenceResult<StoredArticle>;
  getMyArticle(input: { articleId: string; actorId: string; locale?: string }): PersistenceResult<StoredArticle | null>;
  findMyArticleByCreateKey(input: { actorId: string; key: string }): PersistenceResult<string | null>;
  listTaxonomies(input: TaxonomyListInput): PersistenceResult<StoredTaxonomy[]>;
  createTag(input: CreateTagInput): PersistenceResult<StoredTaxonomy>;
  getExternalContentLink(input: ExternalContentLinkKey): PersistenceResult<StoredExternalContentLink | null>;
  upsertExternalContentLink(input: UpsertExternalContentLinkInput): PersistenceResult<StoredExternalContentLink>;
};

/**
 * A bundle that cannot be imported at all.
 *
 * Per-page trouble never throws: it is a line in the report. This is reserved for
 * "this is not a bundle of a size we can accept", where a report would be a list
 * of nothing.
 */
export class NotionImportRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotionImportRequestError";
  }
}

/**
 * The fields of the write the desk would have sent.
 *
 * `slug` is deliberately absent: a create passes one only when the author wrote
 * it, and an update always passes the work's current address. Folding it in here
 * would make "no slug" unexpressible.
 */
function serviceFields(edition: PlannedEdition, tagIds: readonly string[]) {
  return {
    title: edition.draft.title,
    summary: edition.draft.summary,
    locale: edition.draft.locale,
    // The service boundary takes the serialized form the REST body carries.
    contentBlocks: JSON.stringify(edition.draft.contentBlocks),
    contentBlocksVersion: edition.draft.contentBlocksVersion,
    workType: edition.draft.workType,
    publish: edition.draft.publish,
    ...(tagIds.length > 0 ? { tagIds } : {}),
  };
}

/**
 * Existing tags by name, created on demand — and only while applying.
 *
 * A tag is a shared taxonomy with a slug and translations, so an import must not
 * invent a second 「诗歌」: a duplicate splits every tag page in two. During a dry
 * run a missing tag is therefore reported as "would create" rather than created,
 * which means the dry run stays a pure read.
 */
async function resolveTags(
  deps: NotionImportDeps,
  actorId: string,
  names: readonly string[],
  apply: boolean,
): Promise<{ ids: Map<string, string>; created: string[] }> {
  const wanted = [...new Set(names.filter((name) => name.trim().length > 0))];
  const ids = new Map<string, string>();
  const created: string[] = [];
  if (wanted.length === 0) return { ids, created };

  const existing = await deps.listTaxonomies({ kind: "tag", locale: "zh-CN", limit: 100 });
  for (const tag of existing) ids.set(tag.name, tag.id);
  for (const name of wanted) {
    if (ids.has(name)) continue;
    if (!apply) continue;
    const tag = await deps.createTag({ actorId, name });
    ids.set(tag.name, tag.id);
    created.push(tag.name);
  }
  return { ids, created };
}

/** The ids to send for one edition, absent when a tag exists only in the dry run. */
function tagIdsFor(edition: PlannedEdition, ids: Map<string, string>): string[] {
  return edition.draft.tags
    .map((name) => ids.get(name) ?? "")
    .filter((id) => id.length > 0);
}

function blank(): NotionImportReport["summary"] {
  return { create: 0, update: 0, skip: 0, refused: 0, failed: 0 };
}

/**
 * Read the links a previous import left behind, keyed by page.
 *
 * The lookup is by `(page, locale)` because a work's translations are separate
 * Notion pages: one work can have three links, one per edition, pointing at the
 * same article.
 */
async function readLinks(
  deps: NotionImportDeps,
  works: readonly PlannedWork[],
): Promise<{ links: Map<string, StoredExternalContentLink>; otherLocales: Set<string> }> {
  const links = new Map<string, StoredExternalContentLink>();
  const otherLocales = new Set<string>();
  for (const work of works) {
    for (const edition of [work.primary, ...work.translations]) {
      // The same source page may have been imported previously as a different
      // locale, e.g. a translation selected without its primary page. Looking
      // only at the planned locale would incorrectly offer a duplicate create.
      const found = await Promise.all([...SUPPORTED_ARTICLE_LOCALES].map(async (locale) => ({
        locale,
        link: await deps.getExternalContentLink({ provider: NOTION_IMPORT_PROVIDER, externalId: edition.pageId, locale }),
      })));
      for (const { locale, link } of found) {
        if (!link) continue;
        if (locale === edition.locale) links.set(edition.pageId, link);
        else otherLocales.add(edition.pageId);
      }
    }
  }
  return { links, otherLocales };
}

/** The planner's second pass: what a previous import already knows. */
function stateFromLinks(links: Map<string, StoredExternalContentLink>): NotionSeedState {
  const state = emptyNotionSeedState();
  for (const link of links.values()) {
    state.pages[link.externalId] = {
      articleId: link.articleId,
      // The address is not stored on the link: a work's slug is the article's,
      // and the update path reads the current one before writing, so a rename in
      // the desk is preserved rather than reverted by a re-import.
      slug: "",
      locale: link.locale,
      digest: link.digest,
      syncedAt: link.syncedAt,
    };
  }
  return state;
}

type WriteOutcome = {
  report: NotionImportPageReport;
  articleId: string | null;
  slug: string;
  digest: string | null;
};

/**
 * Write one edition.
 *
 * Three paths, and the third is the one a naive implementation gets wrong:
 *
 *  - **The work is new** (no link on its primary page): `POST`-equivalent create,
 *    with the slug rule the desk uses — an authored address is honoured, a derived
 *    one is left to the API, which owns uniqueness.
 *  - **The work exists** (its primary page is linked): update it by id and write
 *    back the address it already has, so a re-import never renames a work.
 *  - **A translation is new but its work exists**: the edition is *added to that
 *    work*, not created as a second article. A missing translation is a `PUT` on
 *    the work with the translation's locale — the same request the desk sends.
 *
 * Refusals are answered, not thrown: a page linked to another account, or to a
 * work that no longer exists, is reported with the reason. Creating a fresh copy
 * in either case is the one outcome an import must never produce on its own.
 */
async function writeEdition(args: {
  actorId: string;
  deps: NotionImportDeps;
  edition: PlannedEdition;
  link: StoredExternalContentLink | undefined;
  /** The work this edition belongs to, when an earlier edition of it just wrote. */
  workArticleId: string | null;
  workSlug: string | null;
  isPrimary: boolean;
  tagIds: readonly string[];
}): Promise<WriteOutcome> {
  const { actorId, deps, edition, link, isPrimary, tagIds } = args;
  const base: NotionImportPageReport = {
    externalId: edition.pageId,
    title: edition.draft.title,
    locale: edition.locale,
    action: "skip",
    slug: args.workSlug ?? edition.slug,
    articleId: null,
    detail: "",
    issues: edition.issues,
  };

  if (link !== undefined && link.ownerId !== actorId) {
    // A Notion page names one work in the world: the primary key is
    // `(provider, page, locale)`, not `(owner, provider, page, locale)`. So a page
    // another account already imported is refused rather than copied — a shared
    // database would otherwise double the site's content and answer to two URLs.
    return {
      report: { ...base, action: "refused", detail: "this page is already imported into another account" },
      articleId: null, slug: edition.slug, digest: null,
    };
  }

  // The article this write addresses, if any: its own link, or the work a
  // previous edition of the same work just created/found.
  const targetId = link?.articleId ?? (isPrimary ? null : args.workArticleId);

  if (targetId === null) {
    // An address the author actually wrote is theirs; a derived one is left to
    // the API, which owns uniqueness and can suffix a collision instead of
    // failing. Same rule as the desk and the seed.
    const derived = edition.issues.some((issue) => issue.code === "slug-derived");
    const created = await createArticleWithSlug(
      (input) => deps.createArticle(input),
      {
        ...serviceFields(edition, tagIds),
        contentBlocks: JSON.stringify(edition.draft.contentBlocks),
        ...(derived ? {} : { slug: edition.slug }),
      },
      actorId,
      idempotencyKeyFor(edition.pageId),
    );
    return {
      report: { ...base, action: "create", slug: created.slug, articleId: created.id, detail: "created" },
      articleId: created.id,
      slug: created.slug,
      digest: edition.digest,
    };
  }

  // The address to write back. Only the primary edition has to look it up: the
  // later editions of one work inherit whatever the primary just answered.
  let slug = args.workSlug ?? edition.slug;
  if (isPrimary) {
    const current = await deps.getMyArticle({ articleId: targetId, actorId, locale: edition.locale });
    if (!current) {
      return {
        report: {
          ...base,
          action: "refused",
          articleId: targetId,
          detail: "the linked work is gone; restore it in the desk, or import into a fresh account",
        },
        articleId: targetId,
        slug: edition.slug,
        digest: null,
      };
    }
    slug = current.slug;
  }

  const updated = await deps.updateArticle({
    ...serviceFields(edition, tagIds),
    articleId: targetId,
    actorId,
    slug,
  });
  return {
    report: { ...base, action: "update", slug: updated.slug, articleId: updated.id, detail: "updated" },
    articleId: updated.id,
    slug: updated.slug,
    digest: edition.digest,
  };
}

/**
 * Import a bundle: plan everything first, then (when applying) write.
 *
 * The plan is computed twice, and that is deliberate: the first pass over an
 * empty state tells us which `(page, locale)` pairs exist so their links can be
 * read, and the second pass over those links is the one that decides
 * create/update/skip. Both passes are the same pure function, so they cannot
 * disagree about a draft.
 */
export async function importNotionBundle(input: {
  actorId: string;
  bundle: unknown;
  apply: boolean;
  deps: NotionImportDeps;
  copyImage?: NotionImageCopier;
  now?: () => Date;
}): Promise<NotionImportReport> {
  const now = input.now ?? (() => new Date());
  const bundle = parseNotionBundle(input.bundle);
  // Standalone Markdown files have no global Notion page ID. Namespace their
  // filename identities by authenticated author, never by a client claim.
  for (const page of bundle.pages) {
    if (page.id.startsWith("markdown-file:")) {
      if (page.id.length > 1500) throw new NotionImportRequestError("Markdown filename is too long.");
      page.id = `markdown-file:${createHash("sha256").update(JSON.stringify([input.actorId, page.id])).digest("hex")}`;
    }
  }
  if (bundle.pages.length > MAX_IMPORT_PAGES) {
    throw new NotionImportRequestError(
      `A bundle may carry at most ${MAX_IMPORT_PAGES} pages; this one carries ${bundle.pages.length}.`,
    );
  }

  const { works } = groupNotionWorks(bundle.pages);
  const firstPass = planNotionSeed({ works, state: emptyNotionSeedState() });
  const { links, otherLocales } = await readLinks(input.deps, firstPass.works);
  const recovered = new Set<string>();
  const recoveryConflicts = new Set<string>();
  for (const work of firstPass.works) {
    const primary = work.primary;
    if (links.has(primary.pageId)) continue;
    // The create key is scoped by the verified author. It survives a failure
    // between creating the work and recording its Notion link, including deletes.
    const key = idempotencyKeyFor(primary.pageId);
    // Malformed keys were never valid create keys; do not turn a single bad
    // page into an exception for the whole bundle while trying to recover it.
    if (key.length > 300 || key.trim() !== key) continue;
    const articleId = await input.deps.findMyArticleByCreateKey({ actorId: input.actorId, key });
    if (!articleId) continue;
    if (work.translations.some((edition) => {
      const link = links.get(edition.pageId);
      return link !== undefined && (link.ownerId !== input.actorId || link.articleId !== articleId);
    })) {
      recoveryConflicts.add(primary.pageId);
      continue;
    }
    // In-memory only: a dry run must not repair the link or change the article.
    // Force an update, never infer that the current article matches the bundle.
    links.set(primary.pageId, { provider: NOTION_IMPORT_PROVIDER, externalId: primary.pageId,
      locale: primary.locale, articleId, ownerId: input.actorId, digest: "recovery-pending", syncedAt: "" });
    recovered.add(primary.pageId);
  }
  // Refuse the whole work before tags or media side effects when its stored
  // provenance cannot safely be reconciled with the newly selected grouping.
  // Never return another owner's article ID in a preview or conflict report.
  const provenanceConflicts = new Map<string, string>();
  for (const work of firstPass.works) {
    const editions = [work.primary, ...work.translations];
    const linked = editions.map((edition) => links.get(edition.pageId)).filter((link): link is StoredExternalContentLink => !!link);
    if (editions.some((edition) => otherLocales.has(edition.pageId))) {
      provenanceConflicts.set(work.primary.pageId, "this page already has import provenance in another locale; review the original work and select the matching pages");
    } else if (linked.some((link) => link.ownerId !== input.actorId)) {
      provenanceConflicts.set(work.primary.pageId, "this page is already imported into another account");
    } else if (new Set(linked.map((link) => link.articleId)).size > 1 ||
      (!links.has(work.primary.pageId) && linked.length > 0)) {
      provenanceConflicts.set(work.primary.pageId, "the selected pages have conflicting import provenance; review the original works before importing");
    }
  }
  const plan = planNotionSeed({ works, state: stateFromLinks(links) });

  // Imports made before image copying existed can have the same source digest
  // while still containing temporary URLs. Offer an update, not a false skip.
  for (const work of plan.works) {
    for (const edition of [work.primary, ...work.translations]) {
      const link = links.get(edition.pageId);
      if (!edition.unchanged || !link || link.ownerId !== input.actorId ||
          !edition.issues.some((issue) => issue.code === "expiring-image-url")) continue;
      const article = await input.deps.getMyArticle({ articleId: link.articleId, actorId: input.actorId, locale: edition.locale });
      let blocks: unknown = article?.contentBlocks;
      if (typeof blocks === "string") {
        try { blocks = JSON.parse(blocks); } catch { blocks = null; }
      }
      const urls = new Set(edition.issues.filter((issue) => issue.code === "expiring-image-url").map((issue) => issue.detail));
      // A refreshed Notion signature changes the query but not the object path.
      const objectKey = (value: string) => {
        try { const url = new URL(value); return `${url.origin}${url.pathname}`; } catch { return value; }
      };
      const objects = new Set([...urls].map(objectKey));
      if (Array.isArray(blocks)) {
        const existing = blocks.filter((block: unknown): block is Record<string, unknown> =>
          typeof block === "object" && block !== null && !Array.isArray(block));
        if (existing.some((block) => typeof block.src === "string" && objects.has(objectKey(block.src)))) {
          edition.unchanged = false;
        } else {
          // An unchanged edition whose image blocks are already local is not a
          // loss; don't re-report the source URL as if it had been retained.
          const imageIds = edition.draft.contentBlocks.filter((block) =>
            block.type === "image" && typeof block.src === "string" && urls.has(block.src));
          if (imageIds.length > 0 && imageIds.every((image) => existing.some((block) =>
            block.id === image.id && typeof block.src === "string" && /^\/api\/media\/[0-9a-f-]{36}$/i.test(block.src)))) {
            edition.issues = edition.issues.filter((issue) => issue.code !== "expiring-image-url");
          }
        }
      }
    }
  }

  const pages: NotionImportPageReport[] = [];
  const summary = blank();

  for (const refused of plan.refused) {
    pages.push({
      externalId: refused.pageId,
      title: refused.title,
      locale: "",
      action: "refused",
      slug: "",
      articleId: null,
      detail: refused.issues.some((issue) => issue.code === "ambiguous-translation-relation" || issue.code === "missing-translation-page")
        ? "translation relation requires review before import" : "this page cannot become a work",
      issues: refused.issues,
    });
    summary.refused += 1;
  }

  // A recovery conflict refuses the whole work; it must not create its tags.
  const allTags = plan.works.filter((work) => !recoveryConflicts.has(work.primary.pageId) && !provenanceConflicts.has(work.primary.pageId))
    .flatMap((work) => [work.primary, ...work.translations]).flatMap((edition) => edition.draft.tags);
  const { ids: tagIds, created: createdTags } = await resolveTags(input.deps, input.actorId, allTags, input.apply);
  const tagNote = createdTags.length > 0 ? ` (created tags: ${createdTags.join(", ")})` : "";

  for (const work of plan.works) {
    const provenanceConflict = provenanceConflicts.get(work.primary.pageId);
    if (provenanceConflict) {
      for (const edition of [work.primary, ...work.translations]) {
        pages.push({ externalId: edition.pageId, title: edition.draft.title, locale: edition.locale,
          action: "refused", slug: "", articleId: null, detail: provenanceConflict, issues: edition.issues });
        summary.refused += 1;
      }
      continue;
    }
    if (recoveryConflicts.has(work.primary.pageId)) {
      for (const edition of [work.primary, ...work.translations]) {
        pages.push({ externalId: edition.pageId, title: edition.draft.title, locale: edition.locale,
          action: "refused", slug: edition.slug, articleId: null,
          detail: "cannot recover this work: a translation is linked to a different work or account", issues: edition.issues });
        summary.refused += 1;
      }
      continue;
    }
    const primaryLink = links.get(work.primary.pageId);
    // The address a work already has, for a report that must not invent one: a
    // link stores the work's id, not its slug (a slug can be renamed in the desk,
    // a copy here would go stale), so it is read back once per work — and only
    // for works whose primary edition will not be written in this run.
    const linkedSlug = primaryLink === undefined ? null : await currentSlug(input.deps, input.actorId, primaryLink);
    const quiet = work.primary.unchanged && work.translations.every((edition) => edition.unchanged);
    // A link whose work can no longer be read is not "unchanged": it is refused
    // below, where the reason can be stated.
    const workQuiet = quiet && (primaryLink === undefined || linkedSlug !== null);
    const workLinked = primaryLink !== undefined && linkedSlug !== null;

    if (workQuiet) {
      for (const edition of [work.primary, ...work.translations]) {
        pages.push({
          externalId: edition.pageId,
          title: edition.draft.title,
          locale: edition.locale,
          action: "skip",
          slug: linkedSlug ?? edition.slug,
          articleId: links.get(edition.pageId)?.articleId ?? primaryLink?.articleId ?? null,
          detail: "unchanged since the last import",
          issues: edition.issues,
        });
        summary.skip += 1;
      }
      continue;
    }

    if (!input.apply) {
      if (recovered.has(work.primary.pageId) && linkedSlug === null) {
        for (const edition of [work.primary, ...work.translations]) {
          pages.push({ externalId: edition.pageId, title: edition.draft.title, locale: edition.locale,
            action: "refused", slug: edition.slug, articleId: primaryLink?.articleId ?? null,
            detail: "the original work is deleted or its primary edition is unavailable; restore it before retrying", issues: edition.issues });
          summary.refused += 1;
        }
        continue;
      }
      for (const edition of [work.primary, ...work.translations]) {
        const link = links.get(edition.pageId);
        // A new edition of a work that already exists is written *onto* that work,
        // so it is an update — the same thing the apply path does.
        const target = link?.articleId ?? (edition === work.primary ? null : primaryLink?.articleId ?? null);
        const action: NotionImportAction = edition.unchanged ? "skip" : target === null ? "create" : "update";
        pages.push({
          externalId: edition.pageId,
          title: edition.draft.title,
          locale: edition.locale,
          action,
          slug: workLinked ? (linkedSlug as string) : edition.slug,
          articleId: target,
          detail: edition.unchanged
            ? "unchanged since the last import"
            : action === "create"
              ? `would create${tagNote}`
              : recovered.has(work.primary.pageId)
                ? `would update ${target} and recover its missing import link; existing edits may be replaced`
                : `would update ${target}`,
          issues: edition.issues,
        });
        summary[action] += 1;
      }
      continue;
    }

    // Apply. The primary edition decides the address and the article id;
    // translations inherit both.
    let workSlug: string | null = work.primary.unchanged ? linkedSlug : null;
    let workArticleId: string | null = work.primary.unchanged ? (primaryLink?.articleId ?? null) : null;
    let primaryFailed = false;

    for (const originalEdition of [work.primary, ...work.translations]) {
      let edition = originalEdition;
      const link = links.get(edition.pageId);
      const isPrimary = originalEdition === work.primary;
      if (edition.unchanged) {
        pages.push({
          externalId: edition.pageId,
          title: edition.draft.title,
          locale: edition.locale,
          action: "skip",
          slug: workSlug ?? edition.slug,
          articleId: link?.articleId ?? null,
          detail: "unchanged since the last import",
          issues: edition.issues,
        });
        summary.skip += 1;
        continue;
      }
      if (primaryFailed) {
        pages.push({
          externalId: edition.pageId,
          title: edition.draft.title,
          locale: edition.locale,
          action: "failed",
          slug: workSlug ?? edition.slug,
          articleId: link?.articleId ?? null,
          detail: "not attempted: the primary edition of this work failed",
          issues: edition.issues,
        });
        summary.failed += 1;
        continue;
      }

      let writtenArticleId: string | null = null;
      try {
        // Check the link and target before making media side effects. The normal
        // writer still performs its own checks before committing the article.
        let incomplete = false;
        const current = link && link.ownerId === input.actorId
          ? await input.deps.getMyArticle({ articleId: link.articleId, actorId: input.actorId, locale: edition.locale }) : null;
        const mayCopy = !link || !!current;
        if (mayCopy) {
          // For an incomplete retry of the exact same source, reuse the local
          // blocks directly. For a changed source, pass them only as hints: the
          // copier must download and verify bytes before reusing an asset.
          const previous = new Map<string, string>();
          if (current) {
            let oldBlocks: unknown = current.contentBlocks;
            if (typeof oldBlocks === "string") {
              try { oldBlocks = JSON.parse(oldBlocks); } catch { oldBlocks = null; }
            }
            if (Array.isArray(oldBlocks)) {
              for (const block of oldBlocks as unknown[]) {
                if (typeof block === "object" && block !== null && "type" in block && block.type === "image" &&
                    "id" in block && typeof block.id === "string" && "src" in block && typeof block.src === "string" &&
                    /^\/api\/media\/[0-9a-f-]{36}$/i.test(block.src)) previous.set(block.id, block.src);
              }
            }
          }
          const prepared = await prepareNotionImages(
            edition, input.copyImage ?? (async () => ({ ok: false, reason: "media storage is not configured" })),
            previous, link?.digest === `incomplete:${edition.digest}`,
          );
          edition = prepared.edition;
          incomplete = prepared.incomplete;
        }
        const outcome = await writeEdition({
          actorId: input.actorId,
          deps: input.deps,
          edition,
          link,
          isPrimary,
          workArticleId,
          tagIds: tagIdsFor(edition, tagIds),
          workSlug: isPrimary ? null : workSlug,
        });
        if (outcome.report.action === "refused") {
          primaryFailed = isPrimary;
          pages.push(outcome.report);
          summary.refused += 1;
          continue;
        }
        if (outcome.digest !== null && outcome.articleId !== null) {
          writtenArticleId = outcome.articleId;
          await input.deps.upsertExternalContentLink({
            provider: NOTION_IMPORT_PROVIDER,
            externalId: edition.pageId,
            locale: edition.locale,
            articleId: outcome.articleId,
            ownerId: input.actorId,
            // An incomplete import remains linked but must be retried, rather
            // than being mistaken for a fully copied, unchanged edition.
            digest: incomplete ? `incomplete:${outcome.digest}` : outcome.digest,
            syncedAt: now().toISOString(),
          });
        }
        if (isPrimary) {
          workSlug = outcome.slug;
          workArticleId = outcome.articleId;
        }
        if (isPrimary && recovered.has(edition.pageId)) {
          outcome.report.detail += "; recovered missing import link";
        }
        pages.push(outcome.report);
        summary[outcome.report.action] += 1;
      } catch (error: unknown) {
        primaryFailed = isPrimary;
        pages.push({
          externalId: edition.pageId,
          title: edition.draft.title,
          locale: edition.locale,
          action: "failed",
          slug: workSlug ?? edition.slug,
          articleId: writtenArticleId ?? link?.articleId ?? null,
          detail: writtenArticleId !== null
            ? error instanceof ExternalContentConflictError
              ? "this page was concurrently linked to another work or account; the article was written without its import link, so check the writing desk before retrying"
              : "the article was written, but its import link could not be saved; check the writing desk before retrying"
            : error instanceof Error ? error.message : String(error),
          issues: edition.issues,
        });
        summary.failed += 1;
      }
    }
  }

  return { applied: input.apply, database: bundle.database, summary, pages };
}

/** The current address of a linked work, or `null` when it cannot be read. */
async function currentSlug(
  deps: NotionImportDeps,
  actorId: string,
  link: StoredExternalContentLink,
): Promise<string | null> {
  const article = await deps.getMyArticle({ articleId: link.articleId, actorId, locale: link.locale });
  return article?.slug ?? null;
}
