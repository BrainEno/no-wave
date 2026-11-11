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
  const createKeys = new Map<string, string>();
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
      if (input.idempotencyKey) createKeys.set(`${input.authorId}|${input.idempotencyKey}`, id);
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
    async findMyArticleByCreateKey({ actorId, key }) {
      return createKeys.get(`${actorId}|${key}`) ?? null;
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

// Characterization of a known data-loss risk, not desired behavior. Replace this
// with a refusal assertion when preview-bound atomic version checks are shipped.
test("current importer does not protect edits made after a dry run", async () => {
  const deps = stubDeps();
  const initial = bundle(page("page-1", "墙壁", "第一版"));
  const changed = bundle(page("page-1", "墙壁", "来源更新"));
  await importNotionBundle({ actorId: "author-1", bundle: initial, apply: true, deps, now: at });
  const dry = await importNotionBundle({ actorId: "author-1", bundle: changed, apply: false, deps, now: at });
  assert.equal(dry.summary.update, 1);
  const article = [...deps.articles.values()][0]!;
  deps.articles.set(article.id, { ...article, contentBlocks: "author edits after preview", updatedAt: "2026-11-04T00:00:00.000Z" });
  const applied = await importNotionBundle({ actorId: "author-1", bundle: changed, apply: true, deps, now: at });
  assert.equal(applied.summary.update, 1);
  assert.doesNotMatch(String(deps.articles.get(article.id)?.contentBlocks), /author edits after preview/);
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

const hostedImage = (url: string) => ({ object: "block", id: "img-1", type: "image", has_children: false, image: { type: "file", file: { url }, caption: [] } });

test("images are copied only during apply, and unchanged imports do not upload again", async () => {
  const deps = stubDeps();
  const doc = page("image-page", "带图文章", "正文");
  doc.blocks.push(hostedImage("https://prod-files-secure.s3.amazonaws.com/a?signature=secret") as never);
  const input = bundle(doc);
  let copies = 0;
  const copyImage = async () => { copies++; return { ok: true as const, src: "/api/media/00000000-0000-4000-8000-000000000001" }; };
  const dry = await importNotionBundle({ actorId: "author-1", bundle: input, apply: false, deps, copyImage, now: at });
  assert.equal(copies, 0);
  assert.ok(dry.pages[0]?.issues.some((issue) => issue.code === "expiring-image-url"));
  const applied = await importNotionBundle({ actorId: "author-1", bundle: input, apply: true, deps, copyImage, now: at });
  assert.equal(applied.summary.create, 1);
  assert.equal(copies, 1);
  assert.ok(!applied.pages[0]?.issues.some((issue) => issue.code === "expiring-image-url"));
  const article = [...deps.articles.values()][0]!;
  assert.match(String(article.contentBlocks), /\/api\/media\//);
  assert.doesNotMatch(String(article.contentBlocks), /signature=secret/);
  const again = await importNotionBundle({ actorId: "author-1", bundle: input, apply: true, deps, copyImage, now: at });
  assert.equal(again.summary.skip, 1);
  assert.ok(!again.pages[0]?.issues.some((issue) => issue.code === "expiring-image-url"));
  assert.equal(copies, 1);
});

test("a failed image is dropped and reported, and the same source is retryable", async () => {
  const deps = stubDeps();
  const doc = page("retry-image", "有图", "正文");
  doc.blocks.push(hostedImage("https://prod-files-secure.s3.amazonaws.com/a?signature=secret") as never);
  const input = bundle(doc);
  const fail = async () => ({ ok: false as const, reason: "expired" });
  const result = await importNotionBundle({ actorId: "author-1", bundle: input, apply: true, deps, copyImage: fail, now: at });
  assert.equal(result.summary.create, 1);
  assert.ok(result.pages[0]?.issues.some((issue) => issue.code === "image-copy-failed" && issue.detail.includes("expired")));
  assert.doesNotMatch(String([...deps.articles.values()][0]!.contentBlocks), /signature=secret/);
  assert.match([...deps.links.values()][0]!.digest, /^incomplete:/);
  const dry = await importNotionBundle({ actorId: "author-1", bundle: input, apply: false, deps, now: at });
  assert.equal(dry.summary.update, 1);
  const success = await importNotionBundle({ actorId: "author-1", bundle: input, apply: true, deps, now: at,
    copyImage: async () => ({ ok: true, src: "/api/media/00000000-0000-4000-8000-000000000001" }) });
  assert.equal(success.summary.update, 1);
  assert.doesNotMatch([...deps.links.values()][0]!.digest, /^incomplete:/);
});

test("another owner's image is never fetched", async () => {
  const deps = stubDeps({ links: [{ provider: NOTION_IMPORT_PROVIDER, externalId: "foreign-image", locale: "zh-CN", articleId: "theirs", ownerId: "other", digest: "old", syncedAt: at().toISOString() }] });
  const doc = page("foreign-image", "别人的", "正文");
  doc.blocks.push(hostedImage("https://prod-files-secure.s3.amazonaws.com/a?signature=secret") as never);
  let copies = 0;
  const result = await importNotionBundle({ actorId: "author-1", bundle: bundle(doc), apply: true, deps, now: at,
    copyImage: async () => { copies++; return { ok: false, reason: "no" }; } });
  assert.equal(copies, 0);
  assert.equal(result.summary.refused, 1);
});

test("retries reuse previously copied images and finish a partially copied page", async () => {
  const deps = stubDeps();
  const doc = page("many-images", "很多图", "正文");
  for (let i = 0; i < 10; i++) doc.blocks.push({ ...hostedImage(`https://prod-files-secure.s3.amazonaws.com/${i}`), id: `image-${i}` } as never);
  const input = bundle(doc);
  let firstCount = 0;
  const first = await importNotionBundle({ actorId: "author-1", bundle: input, apply: true, deps, now: at,
    copyImage: async () => (++firstCount > 8 ? { ok: false, reason: "limit" } : { ok: true, src: `/api/media/00000000-0000-4000-8000-${String(firstCount).padStart(12, "0")}` }) });
  assert.equal(first.summary.create, 1);
  assert.equal(first.pages[0]!.issues.filter((issue) => issue.code === "image-copy-failed").length, 2);
  let secondCount = 0;
  const second = await importNotionBundle({ actorId: "author-1", bundle: input, apply: true, deps, now: at,
    copyImage: async () => { secondCount++; return { ok: true, src: `/api/media/00000000-0000-4000-8000-${String(8 + secondCount).padStart(12, "0")}` }; } });
  assert.equal(second.summary.update, 1);
  assert.equal(secondCount, 2);
  assert.equal(second.pages[0]!.issues.filter((issue) => issue.code === "image-copy-failed").length, 0);
  assert.doesNotMatch([...deps.links.values()][0]!.digest, /^incomplete:/);
});

test("legacy unchanged imports containing temporary image links can be repaired", async () => {
  const deps = stubDeps();
  const doc = page("legacy-image", "旧图片", "正文");
  doc.blocks.push(hostedImage("https://prod-files-secure.s3.amazonaws.com/a?signature=secret") as never);
  const input = bundle(doc);
  // Simulate a pre-copy import by injecting the old source as the stored image.
  await importNotionBundle({ actorId: "author-1", bundle: input, apply: true, deps, now: at,
    copyImage: async () => ({ ok: true, src: "https://prod-files-secure.s3.amazonaws.com/a?signature=secret" }) });
  const dry = await importNotionBundle({ actorId: "author-1", bundle: input, apply: false, deps, now: at });
  assert.equal(dry.summary.update, 1);
  const applied = await importNotionBundle({ actorId: "author-1", bundle: input, apply: true, deps, now: at,
    copyImage: async () => ({ ok: true, src: "/api/media/00000000-0000-4000-8000-000000000001" }) });
  assert.equal(applied.summary.update, 1);
  assert.match(String([...deps.articles.values()][0]!.contentBlocks), /\/api\/media\//);
});

test("a failed provenance write reports that the article was already written", async () => {
  const deps = stubDeps();
  deps.upsertExternalContentLink = async () => { throw new Error("link store unavailable"); };
  const report = await importNotionBundle({ actorId: "author-1", bundle: bundle(page("link-error", "作品", "正文")), apply: true, deps, now: at });
  assert.equal(report.summary.failed, 1);
  assert.equal(report.pages[0]?.articleId, "article-1");
  assert.match(report.pages[0]?.detail ?? "", /article was written.*link could not be saved/);
  assert.equal(deps.articles.size, 1);
});

test("a missing provenance link is previewed and recovered without creating a duplicate", async () => {
  const deps = stubDeps();
  const doc = page("recover-page", "恢复作品", "原文");
  doc.blocks.push(hostedImage("https://prod-files-secure.s3.amazonaws.com/a?signature=secret") as never);
  const input = bundle(doc);
  const saveLink = deps.upsertExternalContentLink;
  deps.upsertExternalContentLink = async () => { throw new Error("injected link failure"); };
  let copies = 0;
  const copyImage = async () => ({ ok: true as const, src: `/api/media/00000000-0000-4000-8000-${String(++copies).padStart(12, "0")}` });
  const first = await importNotionBundle({ actorId: "author-1", bundle: input, apply: true, deps, copyImage, now: at });
  assert.equal(first.summary.failed, 1);
  assert.equal(first.pages[0]?.articleId, "article-1");
  assert.equal(deps.links.size, 0);
  deps.upsertExternalContentLink = saveLink;
  const writes = deps.written.length;
  const dry = await importNotionBundle({ actorId: "author-1", bundle: input, apply: false, deps, copyImage, now: at });
  assert.equal(dry.summary.update, 1);
  assert.equal(dry.pages[0]?.articleId, "article-1");
  assert.match(dry.pages[0]?.detail ?? "", /recover.*existing edits may be replaced/);
  assert.equal(deps.written.length, writes, "preview is read-only");
  assert.equal(copies, 1);
  const recovered = await importNotionBundle({ actorId: "author-1", bundle: input, apply: true, deps, copyImage, now: at });
  assert.equal(recovered.summary.update, 1);
  assert.match(recovered.pages[0]?.detail ?? "", /recovered missing import link/);
  assert.equal(deps.articles.size, 1);
  assert.equal([...deps.links.values()][0]?.articleId, "article-1");
  assert.equal((await importNotionBundle({ actorId: "author-1", bundle: input, apply: false, deps, now: at })).summary.skip, 1);
});

test("an unlinked tombstone is not recreated or written during recovery", async () => {
  const deps = stubDeps();
  const saveLink = deps.upsertExternalContentLink;
  deps.upsertExternalContentLink = async () => { throw new Error("link failed"); };
  const input = bundle(page("recover-deleted", "被删除", "正文"));
  await importNotionBundle({ actorId: "author-1", bundle: input, apply: true, deps, now: at });
  deps.articles.clear();
  deps.upsertExternalContentLink = saveLink;
  const dry = await importNotionBundle({ actorId: "author-1", bundle: input, apply: false, deps, now: at });
  assert.equal(dry.summary.refused, 1);
  assert.match(dry.pages[0]?.detail ?? "", /restore/);
  const applied = await importNotionBundle({ actorId: "author-1", bundle: input, apply: true, deps, now: at });
  assert.equal(applied.summary.refused, 1);
  assert.equal(deps.articles.size, 0);
  assert.equal(deps.links.size, 0);
});

test("recovery refuses a translation linked to a different work", async () => {
  const deps = stubDeps();
  const zh = page("recover-zh", "主文", "正文很长", { English: { type: "relation", relation: [{ id: "recover-en" }] } });
  const en = page("recover-en", "English", "");
  delete (en.properties as Record<string, unknown>).Date;
  en.blocks = [paragraph("English text")];
  const saveLink = deps.upsertExternalContentLink;
  deps.upsertExternalContentLink = async () => { throw new Error("link failure"); };
  const standaloneZh = page("recover-zh", "主文", "正文很长");
  const first = await importNotionBundle({ actorId: "author-1", bundle: bundle(standaloneZh), apply: true, deps, now: at });
  assert.equal(first.summary.failed, 1);
  deps.upsertExternalContentLink = saveLink;
  deps.links.set("recover-en|en", { provider: "notion", externalId: "recover-en", locale: "en", articleId: "other-work", ownerId: "other", digest: "x", syncedAt: at().toISOString() });
  const before = deps.written.length;
  const dry = await importNotionBundle({ actorId: "author-1", bundle: bundle(zh, en), apply: false, deps, now: at });
  assert.equal(dry.summary.refused, 2);
  assert.match(dry.pages[0]?.detail ?? "", /another account|translation is linked to a different work or account/);
  const applied = await importNotionBundle({ actorId: "author-1", bundle: bundle(zh, en), apply: true, deps, now: at });
  assert.equal(applied.summary.refused, 2);
  assert.equal(deps.written.length, before);
  assert.equal(deps.links.size, 1);
});

test("an invalid create key cannot break a dry run during recovery lookup", async () => {
  const deps = stubDeps();
  const keys: string[] = [];
  deps.findMyArticleByCreateKey = async ({ key }) => { keys.push(key); return null; };
  const result = await importNotionBundle({ actorId: "author-1", bundle: bundle(page("x".repeat(400), "长标识", "正文"), page("trailing ", "空格标识", "正文")), apply: false, deps, now: at });
  assert.equal(result.summary.create, 2);
  assert.deepEqual(keys, []);
});

test("a refreshed image URL is downloaded again and offers the old asset only as a hint", async () => {
  const deps = stubDeps();
  const doc = page("refresh-image", "更新图片", "正文");
  const imageUrl = "https://prod-files-secure.s3.amazonaws.com/object";
  doc.blocks.push(hostedImage(`${imageUrl}?X-Amz-Signature=old`) as never);
  const firstSrc = "/api/media/00000000-0000-4000-8000-000000000001";
  const newSrc = "/api/media/00000000-0000-4000-8000-000000000002";
  await importNotionBundle({ actorId: "author-1", bundle: bundle(doc), apply: true, deps, now: at,
    copyImage: async () => ({ ok: true, src: firstSrc }) });
  doc.blocks[1] = hostedImage(`${imageUrl}?X-Amz-Signature=new`) as never;
  const planned = await importNotionBundle({ actorId: "author-1", bundle: bundle(doc), apply: false, deps, now: at });
  assert.equal(planned.summary.update, 1, "a changed signature is not assumed to mean identical bytes");
  const hints: (string | undefined)[] = [];
  const applied = await importNotionBundle({ actorId: "author-1", bundle: bundle(doc), apply: true, deps, now: at,
    copyImage: async (_url, hint) => { hints.push(hint); return { ok: true, src: newSrc }; } });
  assert.equal(applied.summary.update, 1);
  assert.deepEqual(hints, [firstSrc]);
  assert.match(String([...deps.articles.values()][0]!.contentBlocks), new RegExp(newSrc));
});

test("a changed image that cannot be fetched is omitted, not replaced by stale media", async () => {
  const deps = stubDeps();
  const doc = page("changed-failed", "图片变更", "正文");
  doc.blocks.push(hostedImage("https://prod-files-secure.s3.amazonaws.com/a?signature=old") as never);
  await importNotionBundle({ actorId: "author-1", bundle: bundle(doc), apply: true, deps, now: at,
    copyImage: async () => ({ ok: true, src: "/api/media/00000000-0000-4000-8000-000000000001" }) });
  doc.blocks[1] = hostedImage("https://prod-files-secure.s3.amazonaws.com/b?signature=new") as never;
  let receivedHint = false;
  const result = await importNotionBundle({ actorId: "author-1", bundle: bundle(doc), apply: true, deps, now: at,
    copyImage: async (_url, hint) => { receivedHint = !!hint; return { ok: false, reason: "expired" }; } });
  assert.equal(receivedHint, true);
  assert.ok(result.pages[0]?.issues.some((issue) => issue.code === "image-copy-failed"));
  assert.doesNotMatch(String([...deps.articles.values()][0]!.contentBlocks), /api\/media/);
});

test("parent and sub-item pages import separately and disclose lost hierarchy", async () => {
  const parent = page("parent", "父文章", "父正文");
  const childA = page("child-a", "子文章甲", "子正文甲", { "Parent item": { type: "relation", relation: [{ id: "parent" }] } });
  const childB = page("child-b", "子文章乙", "子正文乙", { "Parent item": { type: "relation", relation: [{ id: "parent" }] } });
  const deps = stubDeps();
  const result = await importNotionBundle({ actorId: "author-1", bundle: bundle(parent, childA, childB), apply: true, deps, now: at });
  assert.equal(result.summary.create, 3);
  assert.equal(deps.articles.size, 3);
  assert.equal(result.pages.filter((p) => p.issues.some((i) => i.code === "hierarchy-not-carried")).length, 2);
  assert.ok([...deps.articles.values()].some((article) => article.title === "子文章甲"));
  assert.ok([...deps.articles.values()].some((article) => article.title === "子文章乙"));
});

test("ambiguous translation group and missing related page are refused before all writes", async () => {
  const relation = (...ids: string[]) => ({ type: "relation", relation: ids.map((id) => ({ id })) });
  const a = page("a", "甲", "正文甲", { English: relation("b", "c"), Tags: { type: "multi_select", multi_select: [{ name: "新标签" }] } });
  const b = page("b", "乙", "正文乙");
  const c = page("c", "丙", "正文丙");
  const deps = stubDeps();
  for (const apply of [false, true]) {
    const ambiguous = await importNotionBundle({ actorId: "author-1", bundle: bundle(a, b, c), apply, deps, now: at });
    assert.equal(ambiguous.summary.refused, 3);
    assert.ok(ambiguous.pages.every((p) => p.issues.some((issue) => issue.code === "ambiguous-translation-relation")));
    const missing = await importNotionBundle({ actorId: "author-1", bundle: bundle(a, b), apply, deps, now: at });
    assert.equal(missing.summary.refused, 2);
    assert.ok(missing.pages.every((p) => p.issues.some((issue) => issue.code === "missing-translation-page")));
  }
  assert.deepEqual(deps.written, []);
});

test("a source page already linked under another locale cannot be imported as a new work", async () => {
  const deps = stubDeps({ links: [{ provider: "notion", externalId: "en-page", locale: "en", articleId: "original", ownerId: "author-1", digest: "old", syncedAt: at().toISOString() }] });
  const selected = bundle(page("en-page", "English title", "English text", { Tags: { type: "multi_select", multi_select: [{ name: "新标签" }] } }));
  for (const apply of [false, true]) {
    const report = await importNotionBundle({ actorId: "author-1", bundle: selected, apply, deps, now: at });
    assert.equal(report.summary.refused, 1);
    assert.match(report.pages[0]!.detail, /another locale/);
    assert.equal(report.pages[0]!.articleId, null);
  }
  assert.deepEqual(deps.written, []);
});

test("preview and apply refuse foreign provenance without revealing its article or creating tags", async () => {
  const deps = stubDeps({ links: [{ provider: "notion", externalId: "foreign-page", locale: "zh-CN", articleId: "secret-work", ownerId: "other", digest: "old", syncedAt: at().toISOString() }] });
  const selected = bundle(page("foreign-page", "文字", "正文", { Tags: { type: "multi_select", multi_select: [{ name: "新标签" }] } }));
  for (const apply of [false, true]) {
    const report = await importNotionBundle({ actorId: "author-1", bundle: selected, apply, deps, now: at });
    assert.equal(report.summary.refused, 1);
    assert.equal(report.pages[0]!.articleId, null);
    assert.ok(!JSON.stringify(report).includes("secret-work"));
  }
  assert.deepEqual(deps.written, []);
});

test("previously linked pages from different works cannot be combined by a new relation", async () => {
  const deps = stubDeps({ links: [
    { provider: "notion", externalId: "zh", locale: "zh-CN", articleId: "one", ownerId: "author-1", digest: "old", syncedAt: at().toISOString() },
    { provider: "notion", externalId: "en", locale: "en", articleId: "two", ownerId: "author-1", digest: "old", syncedAt: at().toISOString() },
  ] });
  const zh = page("zh", "标题", "正文", { English: { type: "relation", relation: [{ id: "en" }] } });
  const en = page("en", "Title", "Body");
  delete (en.properties as Record<string, unknown>).Date;
  for (const apply of [false, true]) {
    const report = await importNotionBundle({ actorId: "author-1", bundle: bundle(zh, en), apply, deps, now: at });
    assert.equal(report.summary.refused, 2);
    assert.ok(report.pages.every((p) => p.articleId === null));
  }
  assert.deepEqual(deps.written, []);
});
