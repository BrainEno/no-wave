import assert from "node:assert/strict";
import test from "node:test";
import { serializeRestArticle, serializeRestArticles } from "./serializers.ts";

const AUTHOR = (userId: string, isFollowing = false) => ({
  userId, role: "member", displayName: `作者 ${userId}`, bio: "", avatarUrl: null, websiteUrl: null,
  locale: "zh-CN", followerCount: 1, followingCount: 1, isFollowing,
  createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-02T00:00:00.000Z",
});

const CATEGORY = { id: "cat-1", kind: "category", slug: "essay", name: "随笔", description: "", locale: "zh-CN", createdBy: "u", articleCount: 1 };
const TAG = { id: "tag-1", kind: "tag", slug: "portability", name: "可移植", description: "", locale: "zh-CN", createdBy: "u", articleCount: 1 };

function articleAt(index: number, authorId = `author-${index % 5}`) {
  return {
    id: `article-${index}`,
    authorId,
    slug: `work-${index}`,
    locale: "zh-CN",
    title: `第 ${index} 篇`,
    summary: "",
    contentBlocks: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    publishedAt: "2026-01-01T00:00:00.000Z",
  };
}

/**
 * A counting adapter that answers exactly what the real one would.
 *
 * Counting calls, not milliseconds: a timing assertion passes on a fast machine
 * with a bad query and fails on a loaded one with a good one. What the transport
 * is allowed to ask for is the contract; how long it takes follows from it.
 */
function countingServices({ articles, failBatch = false }: { articles: any[]; failBatch?: boolean }) {
  const calls: string[] = [];
  const services: Record<string, any> = {
    async getAuthorProfile({ userId, locale, viewerId }: any) {
      calls.push("getAuthorProfile");
      return { ...AUTHOR(userId, viewerId !== null), locale };
    },
    async getAuthorProfilesByIds({ userIds, locale, viewerId }: any) {
      calls.push("getAuthorProfilesByIds");
      if (failBatch) throw new Error("no batch method");
      return new Map(userIds.map((userId: string) => [userId, { ...AUTHOR(userId, viewerId !== null), locale }]));
    },
    async listArticleTaxonomies({ kind }: any) {
      calls.push("listArticleTaxonomies");
      return kind === "category" ? [CATEGORY] : [TAG];
    },
    async listArticlesTaxonomies({ articleIds, locale }: any) {
      calls.push("listArticlesTaxonomies");
      if (failBatch) throw new Error("no batch method");
      // Two of the five works carry a category, one of them also a tag: the
      // grouping has to survive an uneven page.
      // `article-0` is the work with a category and a tag; `article-1` has a
      // category only. Keyed by id, not by position, so a batch of one answers
      // exactly what a batch of many does — which is what the comparison against
      // the single-work path is testing.
      const grouped = new Map(articleIds.map((id: string) => [id, { categories: [] as any[], tags: [] as any[] }]));
      grouped.get("article-0")?.categories.push({ ...CATEGORY, locale });
      grouped.get("article-0")?.tags.push({ ...TAG, locale });
      if (grouped.has("article-1")) grouped.get("article-1")!.categories.push({ ...CATEGORY, locale });
      return grouped;
    },
  };
  return { services, calls, articles };
}

/**
 * A page of works costs a fixed number of reads (issue #162).
 *
 * Before this, `serializeRestArticles` was `Promise.all` over the single-work
 * serializer, and each work asked for its author, its categories and its tags:
 * 3N + 1 statements for a page of N. With N = 50 the measured count was 151, all
 * of them synchronous on the SQLite provider. The assertion below is the fix in
 * the form a reader can check: the count must not grow with the page.
 */
test("a page of fifty works reads a fixed number of times, not three per work", async () => {
  const articles = Array.from({ length: 50 }, (_, index) => articleAt(index));
  const { services, calls } = countingServices({ articles });
  const page = await serializeRestArticles(services, articles, null);
  assert.equal(page.length, 50);
  assert.deepEqual([...new Set(calls)].sort(), ["getAuthorProfilesByIds", "listArticlesTaxonomies"]);
  assert.equal(calls.length, 2, "one author query and one taxonomy query for the whole page");
});

test("the same page costs the same two reads at one work and at two hundred", async () => {
  for (const size of [1, 5, 200]) {
    const articles = Array.from({ length: size }, (_, index) => articleAt(index));
    const { services, calls } = countingServices({ articles });
    await serializeRestArticles(services, articles, "viewer-1");
    assert.equal(calls.length, 2, `a page of ${size} must not read more often than a page of one`);
  }
});

test("a page produces exactly the JSON the one-by-one path produced", async () => {
  // The contract of this change is "same output, fewer reads", so the comparison
  // is against the single-work serializer itself rather than a fixture that could
  // drift with it.
  const articles = Array.from({ length: 6 }, (_, index) => articleAt(index));
  const { services } = countingServices({ articles });
  const page = await serializeRestArticles(services, articles, "viewer-1");
  // The single-work path asks the single-work methods, so the fixture answers the
  // same references there. What is being compared is the shape of the output.
  const singleCalls: Array<[string, unknown]> = [];
  services.listArticleTaxonomies = async ({ articleId, kind }: any) => {
    singleCalls.push([articleId, kind]);
    const grouped = await services.listArticlesTaxonomies({ articleIds: [articleId], locale: "zh-CN" });
    return kind === "category" ? grouped.get(articleId)!.categories : grouped.get(articleId)!.tags;
  };
  const oneByOne = [];
  for (const article of articles) oneByOne.push(await serializeRestArticle(services, article, "viewer-1"));
  assert.equal(singleCalls.length, articles.length * 2, "the old path really was two reads per work");
  assert.deepEqual(page, oneByOne);

  // Spot-check the shape as well, so a change that breaks both paths identically
  // is still caught.
  assert.deepEqual(Object.keys(page[0] as object).sort(), [
    "author", "authorId", "categories", "contentBlocks", "createdAt", "id", "locale",
    "publishedAt", "slug", "summary", "tags", "title", "updatedAt",
  ]);
  assert.equal((page[0] as any).author.isFollowing, true, "the viewer's follow state survives the batch");
  assert.equal((page[0] as any).categories.length, 1);
  assert.deepEqual((page[2] as any).categories, [], "a work with no taxonomies still answers empty arrays");
});

test("an empty page asks nothing at all", async () => {
  const { services, calls } = countingServices({ articles: [] });
  assert.deepEqual(await serializeRestArticles(services, [], null), []);
  assert.deepEqual(await serializeRestArticles(services, null, null), []);
  assert.deepEqual(calls, []);
});

test("two locales on one page are read once each, not twice per work", async () => {
  const articles = [articleAt(0), { ...articleAt(1), locale: "en" }, { ...articleAt(2), locale: "en" }];
  const { services, calls } = countingServices({ articles });
  await serializeRestArticles(services, articles, null);
  // One batch per locale: the profile a reader sees is the one translated into
  // the work's language, so the two cannot be merged into one query.
  assert.equal(calls.filter((call) => call === "getAuthorProfilesByIds").length, 2);
  assert.equal(calls.filter((call) => call === "listArticlesTaxonomies").length, 2);
});

test("a work with no author is not looked up", async () => {
  const articles = [{ ...articleAt(0), authorId: null }, { ...articleAt(1), authorId: "" }];
  const { services, calls } = countingServices({ articles });
  const page = await serializeRestArticles(services, articles, null);
  assert.equal(calls.includes("getAuthorProfilesByIds"), false, "no ids, no query");
  assert.deepEqual(page.map((entry: any) => entry.author), [null, null]);
});
