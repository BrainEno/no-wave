/**
 * Bundle in, bundle out: what a *run* decides, as opposed to what a page becomes.
 *
 * The mapping in `./notion-interchange.ts` answers "what does this page become".
 * This module answers the surrounding questions that a *run* has to answer and a
 * pure mapping deliberately does not:
 *
 *   - which pages are editions of the same work (Notion's `English` relation),
 *   - what has already been imported and whether it changed (a digest),
 *   - which write each edition needs (create, update, skip).
 *
 * Everything here is still pure: no HTTP, no files, no clock except an injected
 * `now`. It lives in the application layer rather than in `scripts/` because two
 * callers share it: the operator seed (`scripts/notion-seed.ts`) and
 * `POST /api/v1/imports/notion`. A planner in either one would be a second
 * answer to "have I imported this already".
 */
import { createHash } from "node:crypto";
import {
  DEFAULT_NOTION_PROPERTY_NAMES,
  articleDraftFromNotionPage,
  type InterchangeIssue,
  type NotionArticleDraft,
  type NotionBlockLike,
  type NotionImportOptions,
  type NotionPageLike,
  type NotionPropertyValue,
} from "./notion-interchange.ts";

/** One page exactly as Notion returned it, with its body flattened in order. */
export type NotionBundlePage = {
  id: string;
  properties: Record<string, NotionPropertyValue>;
  /** Depth-first: a container's children follow it, as the mapping expects. */
  blocks: NotionBlockLike[];
  inTrash?: boolean;
  archived?: boolean;
};

/**
 * A bundle is the only thing this repository will ever ask of a Notion token.
 *
 * It is deliberately *Notion's* shape rather than a private one: a bundle can be
 * produced by this repository's fetcher, by a hand-written export, or by any
 * other client that talks to the Notion API — and the mapping cannot tell the
 * difference, which is exactly the property that keeps the REST endpoint in
 * phase 2 from needing a second mapping.
 */
export type NotionBundle = {
  version: 1;
  database: { id: string; title: string | null };
  pages: NotionBundlePage[];
};

export class NotionBundleError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Read a bundle from parsed JSON, refusing rather than guessing.
 *
 * A malformed bundle is a user error with a fixable cause (a truncated export, a
 * database page instead of its data source), so it fails loudly with the field
 * it did not like. Nothing is defaulted except the parts that genuinely have a
 * sensible empty value.
 */
export function parseNotionBundle(value: unknown): NotionBundle {
  if (!isRecord(value)) throw new NotionBundleError("A Notion bundle must be a JSON object.");
  if (value.version !== 1) throw new NotionBundleError("A Notion bundle must carry \"version\": 1.");
  const pages = value.pages;
  if (!Array.isArray(pages)) throw new NotionBundleError("A Notion bundle must carry a \"pages\" array.");

  const parsed: NotionBundlePage[] = pages.map((page, index) => {
    if (!isRecord(page)) throw new NotionBundleError(`pages[${index}] must be an object.`);
    if (typeof page.id !== "string" || page.id.length === 0) {
      throw new NotionBundleError(`pages[${index}].id must be a non-empty string.`);
    }
    if (!isRecord(page.properties)) throw new NotionBundleError(`pages[${index}].properties must be an object.`);
    if (!Array.isArray(page.blocks)) throw new NotionBundleError(`pages[${index}].blocks must be an array.`);
    return {
      id: page.id,
      properties: page.properties as Record<string, NotionPropertyValue>,
      blocks: page.blocks as NotionBlockLike[],
      ...(page.inTrash === true ? { inTrash: true } : {}),
      ...(page.archived === true ? { archived: true } : {}),
    };
  });

  const database = isRecord(value.database)
    ? {
      id: typeof value.database.id === "string" ? value.database.id : "",
      title: typeof value.database.title === "string" ? value.database.title : null,
    }
    : { id: "", title: null };

  return { version: 1, database, pages: parsed };
}

/* -------------------------------------------------------------------------- */
/* Editions of one work                                                       */
/* -------------------------------------------------------------------------- */

export type NotionWork = {
  /** Stable across runs: the primary page id. */
  key: string;
  primary: NotionBundlePage;
  /** Other editions of the same work; today only `en` is reachable. */
  translations: { locale: string; page: NotionBundlePage }[];
  issues: InterchangeIssue[];
};

function relationIds(value: NotionPropertyValue | undefined): string[] {
  if (!value || !Array.isArray(value.relation)) return [];
  return value.relation.map((item) => item?.id).filter((id): id is string => typeof id === "string");
}

function bodyLength(page: NotionBundlePage): number {
  return page.blocks.reduce((total, block) => {
    const data = isRecord(block[block.type ?? ""]) ? (block[block.type!] as Record<string, unknown>) : {};
    const rich = Array.isArray(data.rich_text) ? (data.rich_text as { plain_text?: string }[]) : [];
    return total + rich.reduce((sum, item) => sum + (typeof item.plain_text === "string" ? item.plain_text.length : 0), 0);
  }, 0);
}

/**
 * Group pages into works through the translation relation.
 *
 * In Notion a translation is a second *page* in the same database, linked by a
 * self-relation that both sides carry. In this site it is
 * `article_translations`, addressed by one slug — so the importer has to decide
 * which page is the work and which is its English edition, and it must decide
 * the same way every time or a re-import would split one work into two.
 *
 * The rule is deterministic and stated, in order: the page that carries a
 * `Date`; if neither does, the page with the longer body; if those tie, the
 * smaller page id. Everything else in the component becomes an `en` edition.
 */
export function groupNotionWorks(
  pages: readonly NotionBundlePage[],
  { propertyNames }: { propertyNames?: Partial<typeof DEFAULT_NOTION_PROPERTY_NAMES> } = {},
): { works: NotionWork[]; issues: InterchangeIssue[] } {
  const names = { ...DEFAULT_NOTION_PROPERTY_NAMES, ...(propertyNames ?? {}) };
  const byId = new Map(pages.map((page) => [page.id, page]));
  const relationName = "English";
  const neighbours = new Map<string, string[]>();

  for (const page of pages) {
    const linked = [...relationIds(page.properties[relationName]), ...relationIds(page.properties["Parent item"])]
      .filter((id) => byId.has(id) && id !== page.id);
    neighbours.set(page.id, linked);
  }
  // The relation is duplicated on both sides in this database, so the graph has
  // to be walked as undirected: a page that only ever appears as a target is
  // still an edition of the same work.
  for (const page of pages) {
    for (const id of neighbours.get(page.id) ?? []) {
      const back = neighbours.get(id) ?? [];
      if (!back.includes(page.id)) back.push(page.id);
      neighbours.set(id, back);
    }
  }

  const issues: InterchangeIssue[] = [];
  const visited = new Set<string>();
  const works: NotionWork[] = [];

  for (const page of pages) {
    if (visited.has(page.id)) continue;
    const component: NotionBundlePage[] = [];
    const queue = [page.id];
    visited.add(page.id);
    while (queue.length > 0) {
      const id = queue.shift()!;
      const member = byId.get(id);
      if (!member) continue;
      component.push(member);
      for (const next of neighbours.get(id) ?? []) {
        if (visited.has(next)) continue;
        visited.add(next);
        queue.push(next);
      }
    }
    if (component.length === 1) {
      works.push({ key: page.id, primary: page, translations: [], issues: [] });
      continue;
    }

    const [primary] = [...component].sort((a, b) => {
      const aDate = a.properties[names.date]?.date?.start ? 1 : 0;
      const bDate = b.properties[names.date]?.date?.start ? 1 : 0;
      if (aDate !== bDate) return bDate - aDate;
      const length = bodyLength(b) - bodyLength(a);
      if (length !== 0) return length;
      return a.id.localeCompare(b.id);
    });
    const workIssues: InterchangeIssue[] = [];
    if (component.length > 2) {
      workIssues.push({ code: "hierarchy-not-carried", detail: `${component.length - 1} linked pages, only one translation is supported` });
    }
    works.push({
      key: primary!.id,
      primary: primary!,
      translations: component
        .filter((member) => member.id !== primary!.id)
        // The site's article carries one slug per work, so an edition cannot be
        // a second work with its own address; anything beyond `en` is reported.
        .map((member) => ({ locale: "en", page: member })),
      issues: workIssues,
    });
    issues.push(...workIssues);
  }
  return { works, issues };
}

/* -------------------------------------------------------------------------- */
/* Digests and state                                                          */
/* -------------------------------------------------------------------------- */

/**
 * What a re-import compares.
 *
 * A raw JSON hash of the draft would change whenever the mapping's internal id
 * scheme changed, turning every re-run into a full rewrite. The digest is
 * therefore over *what a reader sees*: the text, the marks, the order, and the
 * properties that decide where and whether the work appears. A page that was
 * merely touched in Notion (a moved cursor, a recoloured block) is not a change.
 */
export function draftDigest(draft: NotionArticleDraft): string {
  const shape = {
    title: draft.title,
    summary: draft.summary,
    locale: draft.locale,
    workType: draft.workType,
    tags: [...draft.tags].sort(),
    publish: draft.publish,
    publishedAt: draft.publishedAt,
    blocks: draft.contentBlocks.map((block) => {
      const { id: _id, ...rest } = block;
      return rest;
    }),
  };
  return createHash("sha256").update(JSON.stringify(shape), "utf8").digest("hex").slice(0, 16);
}

/** What a previous run stored, per Notion page. */
export type NotionSeedStatePage = {
  articleId: string;
  slug: string;
  locale: string;
  digest: string;
  syncedAt: string;
};

export type NotionSeedState = {
  version: 1;
  pages: Record<string, NotionSeedStatePage>;
};

export function emptyNotionSeedState(): NotionSeedState {
  return { version: 1, pages: {} };
}

export function parseNotionSeedState(value: unknown): NotionSeedState {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.pages)) return emptyNotionSeedState();
  const pages: Record<string, NotionSeedStatePage> = {};
  for (const [id, entry] of Object.entries(value.pages)) {
    if (!isRecord(entry)) continue;
    if (typeof entry.articleId !== "string" || typeof entry.slug !== "string" || typeof entry.digest !== "string") continue;
    pages[id] = {
      articleId: entry.articleId,
      slug: entry.slug,
      locale: typeof entry.locale === "string" ? entry.locale : "zh-CN",
      digest: entry.digest,
      syncedAt: typeof entry.syncedAt === "string" ? entry.syncedAt : "",
    };
  }
  return { version: 1, pages };
}

/* -------------------------------------------------------------------------- */
/* The plan                                                                   */
/* -------------------------------------------------------------------------- */

export type PlannedEdition = {
  pageId: string;
  locale: string;
  draft: NotionArticleDraft;
  digest: string;
  /** `null` when no previous run created this work. */
  articleId: string | null;
  /** The work's address: the primary edition decides it. */
  slug: string;
  /** True when this edition is unchanged since the run that stored it. */
  unchanged: boolean;
  issues: InterchangeIssue[];
};

export type PlannedWork = {
  key: string;
  slug: string;
  primary: PlannedEdition;
  translations: PlannedEdition[];
  issues: InterchangeIssue[];
};

export type SeedPlan = {
  works: PlannedWork[];
  /** Pages that could not become a draft at all, with the reason. */
  refused: { pageId: string; title: string; issues: InterchangeIssue[] }[];
};

function titleOf(page: NotionBundlePage): string {
  for (const value of Object.values(page.properties)) {
    if (value?.type === "title" && Array.isArray(value.title)) {
      return value.title.map((item) => (typeof item.plain_text === "string" ? item.plain_text : "")).join("");
    }
  }
  return "";
}

/**
 * Turn a bundle plus a previous state into the exact list of writes to attempt.
 *
 * Slug uniqueness is *not* resolved here: the store owns it, and a create that
 * collides is answered by the API with the conflict the desk also gets. The plan
 * proposes the mapping's derived address and records the one the API returned,
 * so the next run addresses the same work.
 */
export function planNotionSeed(input: {
  works: readonly NotionWork[];
  state: NotionSeedState;
  options?: NotionImportOptions;
}): SeedPlan {
  const works: PlannedWork[] = [];
  const refused: SeedPlan["refused"] = [];

  for (const work of input.works) {
    const primary = articleDraftFromNotionPage({
      page: work.primary as NotionPageLike,
      blocks: work.primary.blocks,
      options: input.options,
    });
    if (primary.draft === null) {
      refused.push({ pageId: work.primary.id, title: titleOf(work.primary), issues: primary.issues });
      continue;
    }
    const slug = input.state.pages[work.primary.id]?.slug ?? primary.draft.slug;
    const workArticleId = input.state.pages[work.primary.id]?.articleId ?? null;

    const edition = (page: NotionBundlePage, locale: string, draft: NotionArticleDraft, issues: InterchangeIssue[]): PlannedEdition => {
      const previous = input.state.pages[page.id];
      // A missing Date uses the current time for publication, but that generated
      // value is not source content. Hashing the clock causes every retry (and
      // even the dry run and apply) to look different. Explicit dates still
      // participate in the digest. Translations inherit the primary date.
      const dateName = input.options?.propertyNames?.date ?? DEFAULT_NOTION_PROPERTY_NAMES.date;
      const hasDate = !!work.primary.properties[dateName]?.date?.start;
      const digest = draftDigest(hasDate ? draft : { ...draft, publishedAt: null });
      return {
        pageId: page.id,
        locale,
        draft,
        digest,
        articleId: previous?.articleId ?? workArticleId,
        slug: previous?.slug ?? slug,
        unchanged: previous?.digest === digest && previous !== undefined,
        issues,
      };
    };

    const plannedPrimary = edition(work.primary, primary.draft.locale, primary.draft, primary.issues);
    const translations: PlannedEdition[] = [];
    for (const translation of work.translations) {
      // A blank English page is not a translation yet (see the mapping's
      // `empty-body`): it is reported and the work still lands in one locale.
      // Publishing is a property of the *work*, not of a row: in the real
      // database the English page has `Published: false` while the Chinese page
      // it belongs to is published, which means "the author never ticked this
      // box", not "this work is a draft". The edition therefore follows the
      // primary edition's status, and a `publish` option still wins.
      const converted = articleDraftFromNotionPage({
        page: translation.page as NotionPageLike,
        blocks: translation.page.blocks,
        options: { ...input.options, locale: translation.locale, publish: input.options?.publish ?? primary.draft.publish },
      });
      if (converted.draft === null) {
        plannedPrimary.issues.push(
          ...converted.issues.map((issue) => ({ code: issue.code, detail: `${translation.locale}: ${issue.detail}` })),
        );
        continue;
      }
      // One work has one publication instant. An edition inherits it, and this is
      // also what keeps a re-run stable: a page with no `Date` would otherwise be
      // dated by the clock, so every run would look like a change and rewrite an
      // untouched work.
      converted.draft.publishedAt = primary.draft.publishedAt;
      translations.push(edition(translation.page, translation.locale, converted.draft, converted.issues));
    }

    works.push({ key: work.key, slug, primary: plannedPrimary, translations, issues: work.issues });
  }
  return { works, refused };
}

/* -------------------------------------------------------------------------- */
/* Request bodies                                                             */
/* -------------------------------------------------------------------------- */

/**
 * The article write body, exactly as the REST contract takes it.
 *
 * `locale` is sent explicitly even when it is the default: an import must not
 * depend on the API's historical Simplified-Chinese default staying what it is.
 */
export function articleWriteBody(draft: NotionArticleDraft, tagIds: readonly string[] = []): Record<string, unknown> {
  return {
    title: draft.title,
    summary: draft.summary,
    locale: draft.locale,
    contentBlocks: draft.contentBlocks,
    contentBlocksVersion: draft.contentBlocksVersion,
    workType: draft.workType,
    publish: draft.publish,
    slug: draft.slug,
    ...(tagIds.length > 0 ? { tagIds } : {}),
  };
}

/**
 * The idempotency key a create carries.
 *
 * The API stores the key with the article (ADR 0019), so a run that dies
 * half-way and is repeated cannot create a second copy of a page it already
 * created — the server, not this script's state file, is the authority for
 * that. The state file only carries the *digest*, which decides updates.
 */
export function idempotencyKeyFor(pageId: string): string {
  return `notion-seed:${pageId}`;
}
