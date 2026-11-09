import assert from "node:assert/strict";
import test from "node:test";
import { parseNotionBundle, draftDigest } from "./notion-bundle.ts";
import { NOTION_EXPORT_PROVIDER, exportNotionBundle, type NotionExportDeps } from "./notion-export.ts";
import { articleDraftFromNotionPage, type NotionPageLike } from "./notion-interchange.ts";
import { MAX_EXPORT_WORKS } from "./notion-export.ts";
import type { StoredArticle, StoredExternalContentLink, StoredTaxonomy } from "./persistence-ports.ts";

/**
 * The export against a stub, so every assertion is about *decisions*: which
 * edition describes a work, which page id a page carries, and what an export
 * admits it could not say.
 *
 * The journey through HTTP and a real database — a work imported, exported and
 * imported again as `skip` — lives in `transport/rest/imports.integration.test.ts`.
 */

const blocks = (content: string) => [{
  id: "b1",
  type: "paragraph",
  text: content,
  inlines: undefined,
}];

function edition(overrides: Partial<StoredArticle> & { id: string; locale: string; title: string }): StoredArticle {
  return {
    authorId: "author-1",
    slug: "qiangbi",
    workType: "poetry",
    status: "published",
    summary: "",
    contentBlocks: blocks(`${overrides.title} 的段落`),
    contentBlocksVersion: 1,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-02T00:00:00.000Z",
    publishedAt: "2026-10-08T00:00:00.000Z",
    viewCount: 0,
    ...overrides,
  } as StoredArticle;
}

/** The three reads an export is allowed to make, and a record of each call. */
function stubDeps(options: {
  works?: StoredArticle[][];
  links?: StoredExternalContentLink[];
  tags?: Record<string, StoredTaxonomy[]>;
} = {}) {
  const works = options.works ?? [];
  const tags = options.tags ?? {};
  const calls: { editions: string[]; links: string[]; taxonomies: { articleIds: string[]; locale: string }[] } = {
    editions: [], links: [], taxonomies: [],
  };
  const deps: NotionExportDeps & { calls: typeof calls } = {
    calls,
    async listMyArticleEditions({ slug, actorId }) {
      calls.editions.push(`${actorId}:${slug}`);
      const found = works.find((editions) => editions[0]?.slug === slug);
      // The store answers [] for another account's slug and for a tombstone; the
      // stub answers the same way, because the export must not be able to tell.
      return found ? found.filter((entry) => entry.authorId === actorId) : [];
    },
    async listExternalContentLinks({ provider, articleId, ownerId }) {
      calls.links.push(`${ownerId}:${articleId}`);
      assert.equal(provider, NOTION_EXPORT_PROVIDER);
      return (options.links ?? []).filter((link) => link.articleId === articleId && link.ownerId === ownerId);
    },
    async listArticlesTaxonomies({ articleIds, locale = "zh-CN" }) {
      calls.taxonomies.push({ articleIds: [...articleIds], locale });
      const answer: Record<string, StoredTaxonomy[]> = {};
      for (const id of articleIds) if (tags[id]) answer[id] = tags[id];
      return answer;
    },
  };
  return deps;
}

function tag(name: string, articleId: string): StoredTaxonomy {
  return {
    id: `tag-${name}`, kind: "tag", slug: name, name, description: "",
    locale: "zh-CN", createdBy: "author-1", articleCount: 1,
  };
}

function link(articleId: string, locale: string, externalId: string): StoredExternalContentLink {
  return {
    provider: NOTION_EXPORT_PROVIDER, externalId, locale, articleId,
    ownerId: "author-1", digest: "digest", syncedAt: "2026-10-09T00:00:00.000Z",
  };
}

const pageOf = (bundle: { pages: { id: string }[] }, index: number) => bundle.pages[index]!;
const property = (page: { properties: Record<string, unknown> }, name: string) =>
  page.properties[name] as { type?: string; title?: { plain_text?: string }[]; rich_text?: { plain_text?: string }[]; date?: { start?: string } | null; checkbox?: boolean; multi_select?: { name?: string }[]; relation?: { id?: string }[] };

test("a work exports as one address and one page per edition, paired by the English relation", async () => {
  const primary = edition({ id: "article-1", locale: "zh-CN", title: "墙壁" });
  const english = edition({ id: "article-1", locale: "en", title: "The Wall" });
  const deps = stubDeps({ works: [[primary, english]], tags: { "article-1": [tag("诗歌", "article-1")] } });

  const { bundle, report } = await exportNotionBundle({ actorId: "author-1", slugs: ["qiangbi"], deps });

  assert.equal(bundle.version, 1);
  assert.equal(bundle.pages.length, 2);
  const [zhPage, enPage] = bundle.pages as [{ id: string; properties: Record<string, unknown> }, { id: string; properties: Record<string, unknown> }];
  // The site's own order decides the primary edition, so the same work exports
  // the same way twice.
  assert.equal(property(zhPage, "Page").title?.[0]?.plain_text, "墙壁");
  assert.equal(property(enPage, "Page").title?.[0]?.plain_text, "The Wall");
  // One work, one address: the editions share it rather than inventing two.
  assert.equal(property(enPage, "Slug").rich_text?.[0]?.plain_text, "qiangbi");
  // The pairing the author's own database carries, on both sides.
  assert.deepEqual(property(zhPage, "English").relation, [{ id: "site:article-1:en" }]);
  assert.deepEqual(property(enPage, "English").relation, [{ id: "site:article-1:zh-CN" }]);
  assert.equal(report.works.length, 1);
  assert.equal(report.works[0]!.primaryLocale, "zh-CN");
  assert.deepEqual(report.works[0]!.pages.map((page) => page.provenance), ["site", "site"]);
  assert.deepEqual(report.summary, { works: 1, pages: 2, missing: 0 });
});

test("the properties are the ones the mapping owns, and the date is a calendar day", async () => {
  const primary = edition({ id: "article-1", locale: "zh-CN", title: "墙壁", summary: "摘要", publishedAt: "2026-10-08T09:30:00.000Z" });
  const deps = stubDeps({ works: [[primary]], tags: { "article-1": [tag("诗歌", "article-1")] } });

  const { bundle } = await exportNotionBundle({ actorId: "author-1", slugs: ["qiangbi"], deps });
  const page = pageOf(bundle, 0) as { properties: Record<string, unknown> };

  assert.deepEqual(Object.keys(page.properties).sort(), ["Date", "Excerpt", "Page", "Published", "Slug", "Tags"]);
  assert.equal(property(page, "Excerpt").rich_text?.[0]?.plain_text, "摘要");
  // Notion's granularity is a day; the instant is the site's, and the export does
  // not invent a time zone for it.
  assert.deepEqual(property(page, "Date").date, { start: "2026-10-08" });
  assert.equal(property(page, "Published").checkbox, true);
  assert.deepEqual(property(page, "Tags").multi_select, [{ name: "诗歌" }]);
});

test("an edition that came from Notion carries the page it came from", async () => {
  const primary = edition({ id: "article-1", locale: "zh-CN", title: "墙壁" });
  const english = edition({ id: "article-1", locale: "en", title: "The Wall" });
  const deps = stubDeps({
    works: [[primary, english]],
    links: [link("article-1", "zh-CN", "01331af0-b39c-4c76-991c-a2d67804c5ca")],
  });

  const { bundle, report } = await exportNotionBundle({ actorId: "author-1", slugs: ["qiangbi"], deps });

  // Pushing this back updates the page the author already has instead of creating
  // a second one.
  assert.equal(pageOf(bundle, 0).id, "01331af0-b39c-4c76-991c-a2d67804c5ca");
  assert.equal(report.works[0]!.pages[0]!.provenance, "notion");
  // The `en` edition was never imported, so it gets the stable id this API made
  // up — and the relation still points at it.
  assert.equal(pageOf(bundle, 1).id, "site:article-1:en");
  assert.equal(report.works[0]!.pages[1]!.provenance, "site");
  // Every lookup is the caller's own, by owner and by work.
  assert.deepEqual(deps.calls.links, ["author-1:article-1"]);
});

test("a page id made here is stable, so two exports of one work are identical", async () => {
  const primary = edition({ id: "article-1", locale: "zh-CN", title: "墙壁" });
  const deps = stubDeps({ works: [[primary]] });

  const first = await exportNotionBundle({ actorId: "author-1", slugs: ["qiangbi"], deps });
  const second = await exportNotionBundle({ actorId: "author-1", slugs: ["qiangbi"], deps });

  assert.deepEqual(first.bundle, second.bundle);
  assert.equal(first.bundle.pages[0]!.id, "site:article-1:zh-CN");
});

test("a translation language Notion cannot address is reported, not written into the wrong one", async () => {
  const primary = edition({ id: "article-1", locale: "zh-CN", title: "墙壁" });
  const taiwan = edition({ id: "article-1", locale: "zh-TW", title: "牆壁" });
  const deps = stubDeps({ works: [[primary, taiwan]], tags: { "article-1": [tag("诗歌", "article-1")] } });

  const { bundle, report } = await exportNotionBundle({ actorId: "author-1", slugs: ["qiangbi"], deps });

  assert.equal(bundle.pages.length, 1, "a zh-TW edition has no page to travel in");
  assert.deepEqual(report.works[0]!.issues.map((issue) => issue.code), ["translation-locale-not-carried"]);
  assert.match(report.works[0]!.issues[0]!.detail, /zh-TW/);
});

test("a work type its own tags do not imply is reported, because an import would change it", async () => {
  const mismatched = edition({ id: "article-1", locale: "zh-CN", title: "墙壁", workType: "essay" });
  const matched = edition({ id: "article-2", locale: "zh-CN", title: "飞行器", slug: "feixing-qi", workType: "poetry" });
  const deps = stubDeps({
    works: [[mismatched], [matched]],
    tags: { "article-1": [tag("诗歌", "article-1")], "article-2": [tag("诗歌", "article-2")] },
  });

  const { report } = await exportNotionBundle({ actorId: "author-1", slugs: ["qiangbi", "feixing-qi"], deps });

  const [first, second] = report.works;
  assert.deepEqual(first!.issues.map((issue) => issue.code), ["work-type-not-carried"]);
  assert.match(first!.issues[0]!.detail, /essay .* would import back as poetry/);
  assert.deepEqual(second!.issues, [], "a type its tags already imply is not a loss");
});

test("a slug that is not one of my live works is listed, and the rest still exports", async () => {
  const primary = edition({ id: "article-1", locale: "zh-CN", title: "墙壁" });
  const deps = stubDeps({ works: [[primary]] });

  const { bundle, report } = await exportNotionBundle({ actorId: "author-1", slugs: ["qiangbi", "no-such-work", "qiangbi"], deps });

  assert.equal(bundle.pages.length, 1, "a duplicate slug is one work, not two pages");
  assert.deepEqual(report.missing, ["no-such-work"]);
  assert.deepEqual(report.summary, { works: 1, pages: 1, missing: 1 });
  // The addresses were resolved before anything was read, so the missing one costs
  // one lookup rather than a failure.
  assert.deepEqual(deps.calls.editions, ["author-1:qiangbi", "author-1:no-such-work"]);
});

test("another account's slug is missing, not a 403 that would confirm it exists", async () => {
  const theirs = edition({ id: "article-9", locale: "zh-CN", title: "别人的作品", authorId: "author-2" });
  const deps = stubDeps({ works: [[theirs]] });

  const { bundle, report } = await exportNotionBundle({ actorId: "author-1", slugs: ["qiangbi"], deps });

  assert.deepEqual(bundle.pages, []);
  assert.deepEqual(report.missing, ["qiangbi"]);
});

test("tags are read once per language, for every work that speaks it", async () => {
  const chinese = edition({ id: "article-1", locale: "zh-CN", title: "墙壁" });
  const second = edition({ id: "article-2", locale: "zh-CN", title: "飞行器", slug: "feixing-qi" });
  const english = edition({ id: "article-3", locale: "en", title: "Aircraft", slug: "aircraft" });
  const deps = stubDeps({
    works: [[chinese], [second], [english]],
    tags: { "article-1": [tag("诗歌", "article-1")], "article-3": [tag("poetry", "article-3")] },
  });

  const { bundle } = await exportNotionBundle({ actorId: "author-1", slugs: ["qiangbi", "feixing-qi", "aircraft"], deps });

  assert.deepEqual(deps.calls.taxonomies, [
    { articleIds: ["article-1", "article-2"], locale: "zh-CN" },
    { articleIds: ["article-3"], locale: "en" },
  ]);
  assert.deepEqual(property(pageOf(bundle, 2) as { properties: Record<string, unknown> }, "Tags").multi_select, [{ name: "poetry" }]);
});

test("an exported bundle is a bundle the import accepts, with the same reader-visible content", async () => {
  const source = edition({ id: "article-1", locale: "zh-CN", title: "墙壁", summary: "摘要", workType: "poetry" });
  const deps = stubDeps({ works: [[source]], tags: { "article-1": [tag("诗歌", "article-1")] } });

  const { bundle } = await exportNotionBundle({ actorId: "author-1", slugs: ["qiangbi"], deps });

  // The real parser, then the real mapping: nothing here is a stand-in.
  const parsed = parseNotionBundle(bundle);
  assert.equal(parsed.pages.length, 1);
  const reimported = articleDraftFromNotionPage({
    page: parsed.pages[0] as unknown as NotionPageLike,
    blocks: parsed.pages[0]!.blocks,
  });

  assert.ok(reimported.draft, "an exported page must still be an article");
  assert.equal(reimported.draft.title, source.title);
  assert.equal(reimported.draft.summary, source.summary);
  assert.equal(reimported.draft.slug, source.slug, "an ASCII address survives, so an import never renames");
  assert.equal(reimported.draft.workType, source.workType);
  assert.equal(reimported.draft.publish, true);
  assert.equal(reimported.draft.publishedAt, source.publishedAt);
  assert.deepEqual(reimported.draft.tags, ["诗歌"]);
  assert.deepEqual(
    reimported.draft.contentBlocks.map((block) => block.text),
    ["墙壁 的段落"],
  );
  // The digest is what a re-import compares: equal here means the round trip would
  // be `skip` rather than a rewrite.
  const sourceDraft = articleDraftFromNotionPage({
    page: {
      id: "01331af0-b39c-4c76-991c-a2d67804c5ca",
      properties: {
        Page: { type: "title", title: [{ type: "text", plain_text: "墙壁" }] },
        Slug: { type: "rich_text", rich_text: [{ type: "text", plain_text: "qiangbi" }] },
        Excerpt: { type: "rich_text", rich_text: [{ type: "text", plain_text: "摘要" }] },
        Date: { type: "date", date: { start: "2026-10-08" } },
        Published: { type: "checkbox", checkbox: true },
        Tags: { type: "multi_select", multi_select: [{ name: "诗歌" }] },
      },
    },
    blocks: [{
      id: "notion-1", type: "paragraph",
      paragraph: { rich_text: [{ type: "text", plain_text: "墙壁 的段落", text: { content: "墙壁 的段落", link: null } }] },
    }],
  });
  assert.ok(sourceDraft.draft);
  assert.equal(draftDigest(reimported.draft), draftDigest(sourceDraft.draft));
});

test("the request bounds are refused before anything is read", async () => {
  const deps = stubDeps({});
  await assert.rejects(
    exportNotionBundle({ actorId: "author-1", slugs: [], deps }),
    /At least one work slug is required/,
  );
  await assert.rejects(
    exportNotionBundle({
      actorId: "author-1",
      slugs: Array.from({ length: MAX_EXPORT_WORKS + 1 }, (_, index) => `work-${index}`),
      deps,
    }),
    new RegExp(`at most ${MAX_EXPORT_WORKS} works`),
  );
  assert.deepEqual(deps.calls.editions, [], "a refused request must not touch the database");
});
