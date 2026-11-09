import assert from "node:assert/strict";
import test from "node:test";
import { NOTION_IMPORT_PROVIDER, importNotionBundle, type NotionImportDeps } from "./notion-import.ts";
import type { StoredArticle, StoredExternalContentLink, StoredTaxonomy } from "./persistence-ports.ts";

/**
 * The import service against a stub, so every assertion is about *decisions*
 * rather than SQL: what a dry run does not write, which page becomes a create,
 * which becomes an update, and what a second run of the same bundle does.
 *
 * The real-database journey (slug resolution, tags, links, public reads) lives in
 * `transport/rest/imports.integration.test.ts`; this file is the place where the
 * behaviour can be stated one clause at a time.
 */

const text = (content: string) => ({ type: "text", plain_text: content, href: null, text: { content, link: null }, annotations: { bold: false, italic: false, underline: false, strikethrough: false, code: false, color: "default" } });
const paragraph = (content: string) => ({ object: "block", id: "p", type: "paragraph", has_children: false, paragraph: { rich_text: content ? [text(content)] : [], color: "default" } });

function page(id: string, title: string, body: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    properties: {
      Page: { type: "title", title: [text(title)] },
      Published: { type: "checkbox", checkbox: true },
      Date: { type: "date", date: { start: "2026-10-08", end: null } },
      ...extra,
    },
    blocks: body ? [paragraph(body)] : [],
  };
}

function bundle(...pages: ReturnType<typeof page>[]) {
  return { version: 1, database: { id: "db-1", title: "Bottom Think" }, pages };
}

/** An in-memory stand-in for the four services the import is allowed to use. */
function stubDeps(options: { links?: StoredExternalContentLink[] } = {}) {
  const links = new Map<string, StoredExternalContentLink>();
  for (const link of options.links ?? []) links.set(`${link.externalId}|${link.locale}`, link);
  const articles = new Map<string, StoredArticle>();
  const written: string[] = [];
  const tags: StoredTaxonomy[] = [];
  let nextId = 1;
  const slugTaken = new Set<string>();

  const deps: NotionImportDeps & { articles: typeof articles; links: typeof links; written: string[]; tags: StoredTaxonomy[] } = {
    articles,
    links,
    written,
    tags,
    async createArticle(input) {
      const id = `article-${nextId++}`;
      let slug = input.slug;
      // Same rule the store applies: a derived address may be suffixed.
      while (slugTaken.has(slug)) slug = `${slug}-${nextId}`;
      slugTaken.add(slug);
      const article: StoredArticle = {
        id, authorId: input.authorId, slug, workType: input.workType ?? "other",
        status: input.publish === true ? "published" : "draft",
        locale: input.locale ?? "zh-CN", title: input.title, summary: input.summary ?? "",
        contentBlocks: input.contentBlocks as never, contentBlocksVersion: input.contentBlocksVersion ?? 0,
        createdAt: "2026-11-01T00:00:00.000Z", updatedAt: "2026-11-01T00:00:00.000Z",
        publishedAt: input.publish === true ? "2026-10-08T00:00:00.000Z" : null,
      } as StoredArticle;
      articles.set(id, article);
      written.push(`create ${id} ${slug}`);
      return article;
    },
    async updateArticle(input) {
      const current = articles.get(input.articleId);
      assert.ok(current, "an update must address a work the stub already has");
      const article: StoredArticle = {
        ...current,
        title: input.title,
        summary: input.summary ?? "",
        status: input.publish === true ? "published" : "draft",
        contentBlocks: input.contentBlocks as never,
        slug: input.slug,
        updatedAt: "2026-11-02T00:00:00.000Z",
      } as StoredArticle;
      articles.set(input.articleId, article);
      written.push(`update ${input.articleId} ${article.slug}`);
      return article;
    },
    async getMyArticle({ articleId, actorId }) {
      const article = articles.get(articleId);
      return article && article.authorId === actorId ? article : null;
    },
    async listTaxonomies() {
      return tags;
    },
    async createTag({ name }) {
      const tag = { id: `tag-${tags.length + 1}`, kind: "tag", slug: name, name, description: "" } as StoredTaxonomy;
      tags.push(tag);
      written.push(`tag ${name}`);
      return tag;
    },
    async getExternalContentLink({ provider, externalId, locale }) {
      return links.get(`${externalId}|${locale}`) ?? null;
    },
    async upsertExternalContentLink(input) {
      links.set(`${input.externalId}|${input.locale}`, input);
      written.push(`link ${input.externalId} ${input.locale}`);
      return input;
    },
  };
  return deps;
}

const at = () => new Date("2026-11-03T00:00:00.000Z");

test("a dry run writes nothing and describes what applying would do", async () => {
  const deps = stubDeps();
  const report = await importNotionBundle({
    actorId: "author-1",
    bundle: bundle(page("page-1", "墙壁", "穿透层层墙壁")),
    apply: false,
    deps,
    now: at,
  });

  assert.equal(report.applied, false);
  assert.deepEqual(report.summary, { create: 1, update: 0, skip: 0, refused: 0, failed: 0 });
  assert.equal(report.pages.length, 1);
  assert.equal(report.pages[0]?.action, "create");
  assert.match(report.pages[0]?.detail ?? "", /^would create/);
  assert.deepEqual(deps.written, [], "a dry run touches no service that writes");
  assert.equal(deps.articles.size, 0);
  assert.equal(deps.links.size, 0);
  assert.equal(deps.tags.length, 0, "a missing tag is not created by a dry run");
});

test("applying creates the work and records where it came from", async () => {
  const deps = stubDeps();
  const report = await importNotionBundle({
    actorId: "author-1",
    bundle: bundle(page("page-1", "墙壁", "穿透层层墙壁")),
    apply: true,
    deps,
    now: at,
  });

  assert.equal(report.applied, true);
  assert.deepEqual(report.summary, { create: 1, update: 0, skip: 0, refused: 0, failed: 0 });
  const link = deps.links.get("page-1|zh-CN");
  assert.ok(link, "the page is now linked to the article it produced");
  assert.equal(link.ownerId, "author-1");
  assert.equal(link.provider, NOTION_IMPORT_PROVIDER);
  assert.equal(link.articleId, report.pages[0]?.articleId);
  assert.equal(link.syncedAt, "2026-11-03T00:00:00.000Z");
  assert.match(link.digest, /^[0-9a-f]{16}$/, "the digest is the planner's fingerprint of what a reader sees");
  const article = deps.articles.get(link.articleId);
  assert.equal(article?.status, "published", "Published: true is honoured");
});

test("the same bundle a second time is all skips: the link is the memory", async () => {
  const deps = stubDeps();
  const input = { actorId: "author-1", bundle: bundle(page("page-1", "墙壁", "穿透层层墙壁")), apply: true, deps, now: at };
  await importNotionBundle(input);
  const before = [...deps.written];

  const second = await importNotionBundle(input);
  assert.deepEqual(second.summary, { create: 0, update: 0, skip: 1, refused: 0, failed: 0 });
  assert.deepEqual(deps.written, before, "a second identical import writes nothing at all");
  assert.equal(deps.articles.size, 1, "and cannot create a duplicate work");
});

test("a changed page updates the work it already belongs to and keeps its address", async () => {
  const deps = stubDeps();
  await importNotionBundle({ actorId: "author-1", bundle: bundle(page("page-1", "墙壁", "第一版")), apply: true, deps, now: at });
  const slug = deps.articles.values().next().value?.slug as string;

  const report = await importNotionBundle({ actorId: "author-1", bundle: bundle(page("page-1", "新的标题", "第二版")), apply: true, deps, now: at });
  assert.deepEqual(report.summary, { create: 0, update: 1, skip: 0, refused: 0, failed: 0 });
  assert.equal(report.pages[0]?.slug, slug, "an update never renames the work");
  assert.equal(deps.articles.size, 1);
  assert.match(String([...deps.articles.values()][0]?.contentBlocks), /第二版/, "the body is the new one");
});

test("a skipped re-import reports the address the work actually has", async () => {
  const deps = stubDeps();
  const input = { actorId: "author-1", bundle: bundle(page("page-1", "墙壁", "穿透层层墙壁")), apply: true, deps, now: at };
  await importNotionBundle(input);
  // The author renames the work in the desk after importing it.
  const [article] = [...deps.articles.values()];
  deps.articles.set(article.id, { ...article, slug: "renamed-in-the-desk" });

  const second = await importNotionBundle(input);
  assert.equal(second.summary.skip, 1);
  assert.equal(second.pages[0]?.slug, "renamed-in-the-desk", "a skip reports the real address, not the mapped one");
});

test("a dry run of a new translation says update, because that is what applying does", async () => {
  const deps = stubDeps();
  await importNotionBundle({ actorId: "author-1", bundle: bundle(page("page-zh", "墙壁", "中文正文")), apply: true, deps, now: at });

  const withEnglish = page("page-zh", "墙壁", "中文正文", { English: { type: "relation", relation: [{ id: "page-en" }] } });
  const english = page("page-en", "Walls", "");
  delete (english.properties as Record<string, unknown>).Date;
  english.blocks = [paragraph("Walls, and the walls beyond them")];

  const dry = await importNotionBundle({ actorId: "author-1", bundle: bundle(withEnglish, english), apply: false, deps, now: at });
  assert.deepEqual(dry.summary, { create: 0, update: 1, skip: 1, refused: 0, failed: 0 });
  const edition = dry.pages.find((entry) => entry.locale === "en");
  assert.equal(edition?.action, "update", "a new edition of an imported work is written onto it");
  assert.equal(edition?.articleId, dry.pages.find((entry) => entry.locale === "zh-CN")?.articleId);
});

test("a page that cannot become a work is refused, and the others still land", async () => {
  const deps = stubDeps();
  const report = await importNotionBundle({
    actorId: "author-1",
    bundle: bundle(page("page-1", "墙壁", "有正文"), page("page-2", "空页", "")),
    apply: true,
    deps,
    now: at,
  });

  assert.equal(report.summary.create, 1);
  assert.equal(report.summary.refused, 1);
  const refused = report.pages.find((entry) => entry.action === "refused");
  assert.equal(refused?.externalId, "page-2");
  assert.ok(refused?.issues.some((issue) => issue.code === "empty-body"), "the reason is carried, not just the verdict");
  assert.equal(deps.articles.size, 1, "one empty page does not fail the import");
});

test("another account's page is refused rather than copied", async () => {
  const deps = stubDeps({
    links: [{
      provider: NOTION_IMPORT_PROVIDER, externalId: "page-1", locale: "zh-CN", articleId: "article-theirs",
      ownerId: "author-2", digest: "0".repeat(64), syncedAt: "2026-11-01T00:00:00.000Z",
    }],
  });
  const report = await importNotionBundle({ actorId: "author-1", bundle: bundle(page("page-1", "墙壁", "正文")), apply: true, deps, now: at });

  assert.deepEqual(report.summary, { create: 0, update: 0, skip: 0, refused: 1, failed: 0 });
  assert.match(report.pages[0]?.detail ?? "", /another account/);
  assert.equal(deps.articles.size, 0, "a shared database cannot double the site's content");
});

test("a link whose work was deleted is refused, never silently recreated", async () => {
  const deps = stubDeps({
    links: [{
      provider: NOTION_IMPORT_PROVIDER, externalId: "page-1", locale: "zh-CN", articleId: "article-gone",
      ownerId: "author-1", digest: "0".repeat(64), syncedAt: "2026-11-01T00:00:00.000Z",
    }],
  });
  const report = await importNotionBundle({ actorId: "author-1", bundle: bundle(page("page-1", "墙壁", "正文")), apply: true, deps, now: at });

  assert.equal(report.summary.refused, 1);
  assert.match(report.pages[0]?.detail ?? "", /deleted|gone/);
  assert.equal(deps.articles.size, 0);
});

test("translations become editions of one work and inherit its address", async () => {
  const wall = page("page-zh", "墙壁", "穿透层层墙壁", { English: { type: "relation", relation: [{ id: "page-en" }] } });
  // The English page of the real database has no `Date` and a shorter body, which
  // is what makes the Chinese page the primary edition of the work.
  const english = page("page-en", "Walls", "");
  const englishProperties = english.properties as Record<string, unknown>;
  delete englishProperties.Date;
  englishProperties.Slug = { type: "rich_text", rich_text: [text("walls")] };
  english.blocks = [paragraph("Walls, and the walls beyond them")];
  const deps = stubDeps();
  const report = await importNotionBundle({ actorId: "author-1", bundle: bundle(wall, english), apply: true, deps, now: at });

  // The work is created once; the English page is a second *edition* of it, so it
  // is written as an update of the same article rather than as a second article.
  assert.deepEqual(report.summary, { create: 1, update: 1, skip: 0, refused: 0, failed: 0 });
  const [primary, translation] = report.pages;
  assert.equal(primary?.locale, "zh-CN");
  assert.equal(translation?.locale, "en");
  assert.equal(translation?.articleId, primary?.articleId, "both editions are one article");
  assert.equal(translation?.slug, primary?.slug, "one work has one address");
  assert.equal(deps.links.get("page-en|en")?.articleId, primary?.articleId);
});

test("a bundle that is not a bundle is rejected before anything is read", async () => {
  const deps = stubDeps();
  await assert.rejects(
    () => importNotionBundle({ actorId: "author-1", bundle: { version: 2 }, apply: true, deps, now: at }),
    /bundle|version/i,
  );
  assert.deepEqual(deps.written, []);
});

test("a bundle larger than the page limit is refused", async () => {
  const deps = stubDeps();
  const pages = Array.from({ length: 201 }, (_, index) => page(`page-${index}`, `标题 ${index}`, "正文"));
  await assert.rejects(
    () => importNotionBundle({ actorId: "author-1", bundle: bundle(...pages), apply: true, deps, now: at }),
    /at most 200 pages/,
  );
  assert.deepEqual(deps.written, []);
});
