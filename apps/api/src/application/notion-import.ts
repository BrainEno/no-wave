import { createHash } from "node:crypto";
import { SUPPORTED_ARTICLE_LOCALES } from "../domain/article.ts";
import { prepareNotionImages, type NotionImageCopier } from "./notion-import-images.ts";
import { ArticleVersionConflictError, DomainError, ImportConflictError } from "../domain/errors.ts";
import {
  assertNotionImportPlan, notionBundleHash, NOTION_IMPORT_PLAN_TTL_MS,
  type CommitNotionImportWorkInput, type CommittedNotionImportEdition,
  type NotionImportEditionWrite, type NotionImportPlan, type NotionImportWorkExpectation,
} from "./notion-import-plan.ts";
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
  ExternalContentLinkKey,
  PersistenceResult,
  StoredArticle,
  StoredExternalContentLink,
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
 * through `getMyArticle`, writes through a locked per-work commit that composes
 * the same validated article/tag/provenance writers the desk uses.
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
  /** Authenticated, bounded, database-local preview. Required for apply. */
  planToken?: string;
  planExpiresAt?: string;
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
  getImportPlanGeneration(): PersistenceResult<string>;
  signNotionImportPlan(plan: NotionImportPlan): string;
  verifyNotionImportPlan(token: unknown): NotionImportPlan;
  commitNotionImportWork(input: CommitNotionImportWorkInput): PersistenceResult<CommittedNotionImportEdition[]>;
  getMyArticle(input: { articleId: string; actorId: string; locale?: string }): PersistenceResult<StoredArticle | null>;
  findMyArticleByCreateKey(input: { actorId: string; key: string }): PersistenceResult<string | null>;
  getExternalContentLink(input: ExternalContentLinkKey): PersistenceResult<StoredExternalContentLink | null>;
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
): Promise<{ links: Map<string, StoredExternalContentLink>; otherLocales: Set<string>; allLinks: StoredExternalContentLink[] }> {
  const links = new Map<string, StoredExternalContentLink>();
  const otherLocales = new Set<string>();
  const allLinks: StoredExternalContentLink[] = [];
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
        allLinks.push(link);
        if (locale === edition.locale) links.set(edition.pageId, link);
        else otherLocales.add(edition.pageId);
      }
    }
  }
  return { links, otherLocales, allLinks };
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
  planToken?: unknown;
  deps: NotionImportDeps;
  copyImage?: NotionImageCopier;
  now?: () => Date;
}): Promise<NotionImportReport> {
  const now = input.now ?? (() => new Date());
  const hash = notionBundleHash(input.bundle);
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

  const generation = await input.deps.getImportPlanGeneration();
  const issuedAt = now().getTime();
  const acceptedPlan = input.apply ? input.deps.verifyNotionImportPlan(input.planToken) : null;
  if (acceptedPlan) assertNotionImportPlan(acceptedPlan, { actorId: input.actorId, bundleHash: hash, generation, now: issuedAt });
  const previewWorks: NotionImportWorkExpectation[] = [];
  const createKeyArticles = new Map<string, string | null>();

  const { works } = groupNotionWorks(bundle.pages);
  const firstPass = planNotionSeed({ works, state: emptyNotionSeedState() });
  const { links, otherLocales, allLinks } = await readLinks(input.deps, firstPass.works);
  const recovered = new Set<string>();
  const recoveryConflicts = new Set<string>();
  for (const work of firstPass.works) {
    const primary = work.primary;
    // The create key is scoped by the verified author. It survives a failure
    // between creating the work and recording its Notion link, including deletes.
    const key = idempotencyKeyFor(primary.pageId);
    // Malformed keys were never valid create keys; do not turn a single bad
    // page into an exception for the whole bundle while trying to recover it.
    if (key.length > 300 || key.trim() !== key) continue;
    const articleId = await input.deps.findMyArticleByCreateKey({ actorId: input.actorId, key });
    createKeyArticles.set(primary.pageId, articleId);
    if (links.has(primary.pageId) || !articleId) continue;
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

  const rejectWork = (work: PlannedWork, detail: string, action: "refused" | "failed" = "refused", articleId: string | null = null, prepared?: ReadonlyMap<string, PlannedEdition>) => {
    for (const edition of [work.primary, ...work.translations]) {
      pages.push({ externalId: edition.pageId, title: edition.draft.title, locale: edition.locale,
        action, slug: "", articleId, detail, issues: prepared?.get(edition.pageId)?.issues ?? edition.issues });
      summary[action] += 1;
    }
  };

  for (const work of plan.works) {
    const expected = acceptedPlan?.works.find((candidate) => candidate.key === work.primary.pageId);
    const transactionBase = expected && acceptedPlan ? { actorId: input.actorId, generation: acceptedPlan.generation,
      expiresAt: acceptedPlan.expiresAt, expected } : null;
    if (input.apply && transactionBase) {
      try {
        // Cheap check before media side effects. The real commit repeats this
        // while holding the SAME lock as all article/tag/provenance writes.
        await input.deps.commitNotionImportWork({ ...transactionBase, editions: [] });
      } catch (error) {
        rejectWork(work, error instanceof ImportConflictError ? error.message : "This work could not be checked; preview again.",
          error instanceof ImportConflictError ? "refused" : "failed", expected?.article?.id ?? null);
        continue;
      }
    }
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
    const target = primaryLink === undefined ? null : await input.deps.getMyArticle({ articleId: primaryLink.articleId, actorId: input.actorId, locale: primaryLink.locale });
    const linkedSlug = target?.slug ?? null;
    if (primaryLink && (!target || target.revision === undefined)) {
      rejectWork(work, "the original work is deleted or its primary edition is unavailable; restore it before retrying", "refused", primaryLink.articleId);
      continue;
    }
    if (input.apply && !transactionBase) { rejectWork(work, new ImportConflictError().message); continue; }
    if (!input.apply) previewWorks.push({ key: work.primary.pageId,
      sourceIds: [work.primary, ...work.translations].map((edition) => edition.pageId),
      links: allLinks.filter((link) => [work.primary, ...work.translations].some((edition) => edition.pageId === link.externalId)),
      createKey: idempotencyKeyFor(work.primary.pageId), createKeyArticleId: createKeyArticles.get(work.primary.pageId) ?? null,
      article: target ? { id: target.id, revision: target.revision! } : null });
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
        const action: NotionImportAction = edition.unchanged ? "skip" : target === null && edition === work.primary ? "create" : "update";
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
              ? "would create"
              : recovered.has(work.primary.pageId)
                ? `would update ${target} and recover its missing import link; existing edits may be replaced`
                : `would update ${target}`,
          issues: edition.issues,
        });
        summary[action] += 1;
      }
      continue;
    }

    // Prepare outside the database lock; a late edit is checked again at commit.
    let mayHaveCopiedMedia = false;
    const preparedEditions = new Map<string, PlannedEdition>();
    try {
      const writes: NotionImportEditionWrite[] = [];
      for (const original of [work.primary, ...work.translations]) {
        if (original.unchanged) continue;
        const link = links.get(original.pageId);
        const current = link ? await input.deps.getMyArticle({ articleId: link.articleId, actorId: input.actorId, locale: original.locale }) : null;
        const previous = new Map<string, string>();
        let oldBlocks: unknown = current?.contentBlocks;
        if (typeof oldBlocks === "string") { try { oldBlocks = JSON.parse(oldBlocks); } catch { oldBlocks = null; } }
        if (Array.isArray(oldBlocks)) for (const block of oldBlocks as unknown[]) {
          if (typeof block === "object" && block !== null && "type" in block && block.type === "image" &&
              "id" in block && typeof block.id === "string" && "src" in block && typeof block.src === "string" &&
              /^\/api\/media\/[0-9a-f-]{36}$/i.test(block.src)) previous.set(block.id, block.src);
        }
        const prepared = await prepareNotionImages(original, async (url, previousSrc) => {
          const result = await (input.copyImage ?? (async () => ({ ok: false as const, reason: "media storage is not configured" })))(url, previousSrc);
          if (result.ok) mayHaveCopiedMedia = true;
          return result;
        }, previous, link?.digest === `incomplete:${original.digest}`);
        const edition = prepared.edition;
        preparedEditions.set(edition.pageId, edition);
        writes.push({ externalId: edition.pageId, locale: edition.locale, title: edition.draft.title,
          summary: edition.draft.summary, contentBlocks: edition.draft.contentBlocks,
          contentBlocksVersion: edition.draft.contentBlocksVersion, workType: edition.draft.workType,
          publish: edition.draft.publish, tags: edition.draft.tags,
          requestedSlug: edition.issues.some((issue) => issue.code === "slug-derived") ? null : edition.slug,
          digest: prepared.incomplete ? `incomplete:${edition.digest}` : edition.digest, syncedAt: now().toISOString() });
      }
      const committed = await input.deps.commitNotionImportWork({ ...transactionBase!, editions: writes });
      const workArticle = committed[0]?.article ?? target;
      for (const original of [work.primary, ...work.translations]) {
        const edition = preparedEditions.get(original.pageId) ?? original;
        const result = committed.find((candidate) => candidate.externalId === edition.pageId);
        const action = result ? result.created ? "create" : "update" : "skip";
        pages.push({ externalId: edition.pageId, title: edition.draft.title, locale: edition.locale, action,
          slug: result?.article.slug ?? workArticle?.slug ?? edition.slug,
          articleId: result?.article.id ?? workArticle?.id ?? null,
          detail: action === "skip" ? "unchanged since the last import" :
            `${action === "create" ? "created" : "updated"}${recovered.has(edition.pageId) ? "; recovered missing import link" : ""}`,
          issues: edition.issues });
        summary[action] += 1;
      }
    } catch (error) {
      const conflict = error instanceof ImportConflictError || error instanceof ArticleVersionConflictError;
      const detail = conflict ? new ImportConflictError().message :
        error instanceof DomainError ? `${error.message} Nothing in this work was written; preview again.` :
        "This work could not be imported. All article, tag and provenance writes were rolled back; preview again.";
      rejectWork(work, detail + (mayHaveCopiedMedia ? " Prepared images may remain in your media library; review and remove unused images." : ""),
        conflict ? "refused" : "failed", expected?.article?.id ?? null, preparedEditions);
    }
  }

  return { applied: input.apply, database: bundle.database, summary, pages,
    ...(!input.apply ? { planToken: input.deps.signNotionImportPlan({ version: 1, actorId: input.actorId,
      bundleHash: hash, generation, issuedAt, expiresAt: issuedAt + NOTION_IMPORT_PLAN_TTL_MS, works: previewWorks }),
      planExpiresAt: new Date(issuedAt + NOTION_IMPORT_PLAN_TTL_MS).toISOString() } : {}) };
}
