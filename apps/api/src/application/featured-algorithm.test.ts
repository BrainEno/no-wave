import assert from "node:assert/strict";
import test from "node:test";
import {
  getArticleWordCount,
  rankArticlesByWordCount,
  resolveFeaturedArticles,
} from "./featured-algorithm.ts";
import { createApplicationServices } from "./services.ts";
import type { ContentPersistencePort, StoredArticle } from "./persistence-ports.ts";

function fakeArticle(
  id: string,
  options: {
    locale?: string;
    text?: string;
    readingPreviewLength?: number;
    publishedAt?: string;
    status?: string;
  } = {},
): StoredArticle {
  const locale = options.locale ?? "zh-CN";
  const text = options.text ?? "正文内容";
  return {
    id,
    authorId: "author-1",
    slug: `article-${id}`,
    workType: "short_story",
    status: options.status ?? "published",
    locale,
    title: `Title ${id}`,
    summary: "",
    contentBlocks: [{ id: "b1", type: "paragraph", text }],
    contentBlocksVersion: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    publishedAt: options.publishedAt ?? "2026-01-02T00:00:00.000Z",
    viewCount: 0,
    ...(typeof options.readingPreviewLength === "number"
      ? { readingPreview: { locale, length: options.readingPreviewLength, poemLines: [] } }
      : {}),
  };
}

test("getArticleWordCount prefers existing readingPreview length", () => {
  const article = fakeArticle("1", { readingPreviewLength: 42 });
  assert.equal(getArticleWordCount(article), 42);
});

test("getArticleWordCount calculates character count for Chinese (without whitespace)", () => {
  const article = fakeArticle("1", { locale: "zh-CN", text: "春风 又绿 江南岸" });
  // 7 Chinese characters without spaces
  assert.equal(getArticleWordCount(article), 7);
});

test("getArticleWordCount calculates word count for English", () => {
  const article = fakeArticle("1", { locale: "en", text: "No Wave is a minimalist platform for literature." });
  // 8 words
  assert.equal(getArticleWordCount(article), 8);
});

test("getArticleWordCount handles various block types (lists, quotes, headings) and ignores code/images", () => {
  const article: StoredArticle = {
    ...fakeArticle("1", { locale: "zh-CN" }),
    contentBlocks: [
      { id: "h1", type: "heading", level: 2, text: "标题" }, // 2
      { id: "p1", type: "paragraph", text: "正文第一段" }, // 5
      { id: "q1", type: "quote", text: "引用内容" }, // 4
      { id: "l1", type: "list", ordered: false, items: ["条目一", "条目二"] }, // 3 + 3 = 6
      { id: "c1", type: "code", language: "ts", code: "const x = 1;" }, // ignored
      { id: "i1", type: "image", src: "https://example.test/img.png", alt: "alt" }, // ignored
    ],
  };
  assert.equal(getArticleWordCount(article), 17);
});

test("getArticleWordCount returns 0 for malformed content without throwing", () => {
  const article = {
    ...fakeArticle("1"),
    contentBlocks: "not-json-or-array",
  };
  assert.equal(getArticleWordCount(article as unknown as StoredArticle), 0);
});

test("rankArticlesByWordCount ranks longer works first, ties broken by publishedAt DESC then id DESC", () => {
  const shortArticle = fakeArticle("short", { text: "短篇", publishedAt: "2026-01-01T00:00:00.000Z" }); // 2 chars
  const longArticle = fakeArticle("long", { text: "这是一篇非常长非常详细的深度文学作品", publishedAt: "2026-01-01T00:00:00.000Z" }); // 18 chars
  const mediumNewer = fakeArticle("medium-newer", { text: "中等长度的作品A", publishedAt: "2026-01-05T00:00:00.000Z" }); // 8 chars
  const mediumOlder = fakeArticle("medium-older", { text: "中等长度的作品B", publishedAt: "2026-01-02T00:00:00.000Z" }); // 8 chars
  const mediumSameTimeB = fakeArticle("medium-same-b", { text: "中等长度的作品C", publishedAt: "2026-01-02T00:00:00.000Z" }); // 8 chars, id starts with 'm'
  const mediumSameTimeA = fakeArticle("medium-same-a", { text: "中等长度的作品D", publishedAt: "2026-01-02T00:00:00.000Z" }); // 8 chars

  const input = [shortArticle, mediumOlder, longArticle, mediumSameTimeA, mediumNewer, mediumSameTimeB];
  const ranked = rankArticlesByWordCount(input);

  // 1. longArticle (18)
  // 2. mediumNewer (8, 2026-01-05)
  // 3. mediumSameTimeB (8, 2026-01-02, id: medium-same-b)
  // 4. mediumSameTimeA (8, 2026-01-02, id: medium-same-a)
  // 5. mediumOlder (8, 2026-01-02, id: medium-older)
  // 6. shortArticle (2, 2026-01-01)
  assert.equal(ranked[0]?.id, "long");
  assert.equal(ranked[1]?.id, "medium-newer");
  assert.equal(ranked[ranked.length - 1]?.id, "short");
});

test("rankArticlesByWordCount is a pure function that does not mutate the input array", () => {
  const a = fakeArticle("a", { text: "短" });
  const b = fakeArticle("b", { text: "长长长" });
  const original = [a, b];
  const result = rankArticlesByWordCount(original);
  assert.deepEqual(original.map((x) => x.id), ["a", "b"]);
  assert.deepEqual(result.map((x) => x.id), ["b", "a"]);
});

test("resolveFeaturedArticles returns editor-curated articles when curated shelf is not empty (overrides algorithm)", async () => {
  const shortCurated = fakeArticle("curated-short", { text: "短" }); // 1 char
  const longCurated = fakeArticle("curated-long", { text: "非常长" }); // 3 chars
  const publishedLongest = fakeArticle("published-longest", { text: "非常非常非常长" }); // 7 chars

  const contentPort: Pick<ContentPersistencePort, "listFeaturedArticles" | "listPublishedArticles"> = {
    async listFeaturedArticles() {
      // Editor explicitly ordered short before long
      return [shortCurated, longCurated];
    },
    async listPublishedArticles() {
      return [publishedLongest, shortCurated, longCurated];
    },
  };

  const result = await resolveFeaturedArticles(contentPort, { locale: "zh-CN", limit: 20, offset: 0 });
  // Curated shelf order is strictly preserved; algorithm is bypassed
  assert.deepEqual(result.map((a) => a.id), ["curated-short", "curated-long"]);
});

test("resolveFeaturedArticles falls back to default word-count algorithm when shelf is not curated", async () => {
  const short = fakeArticle("short", { text: "短文" }); // 2 chars
  const medium = fakeArticle("medium", { text: "这是一篇中等长度的作品" }); // 11 chars
  const long = fakeArticle("long", { text: "这是一篇非常长非常宏大的长篇文学巨作，字数非常多" }); // 24 chars

  const contentPort: Pick<ContentPersistencePort, "listFeaturedArticles" | "listPublishedArticles"> = {
    async listFeaturedArticles() {
      // No editor curation
      return [];
    },
    async listPublishedArticles() {
      return [short, medium, long];
    },
  };

  const result = await resolveFeaturedArticles(contentPort, { locale: "zh-CN", limit: 20, offset: 0 });
  // Algorithm ranks longest first
  assert.deepEqual(result.map((a) => a.id), ["long", "medium", "short"]);
});

test("resolveFeaturedArticles respects pagination limit and offset in fallback mode", async () => {
  const articles = [
    fakeArticle("1", { text: "一" }), // 1
    fakeArticle("2", { text: "二二" }), // 2
    fakeArticle("3", { text: "三三三" }), // 3
    fakeArticle("4", { text: "四四四四" }), // 4
  ];

  const contentPort: Pick<ContentPersistencePort, "listFeaturedArticles" | "listPublishedArticles"> = {
    async listFeaturedArticles() { return []; },
    async listPublishedArticles() { return articles; },
  };

  // Ranked order: [4, 3, 2, 1]
  const page1 = await resolveFeaturedArticles(contentPort, { locale: "zh-CN", limit: 2, offset: 0 });
  assert.deepEqual(page1.map((a) => a.id), ["4", "3"]);

  const page2 = await resolveFeaturedArticles(contentPort, { locale: "zh-CN", limit: 2, offset: 2 });
  assert.deepEqual(page2.map((a) => a.id), ["2", "1"]);

  const page3 = await resolveFeaturedArticles(contentPort, { locale: "zh-CN", limit: 2, offset: 4 });
  assert.deepEqual(page3, []);
});

test("resolveFeaturedArticles returns empty array when curated shelf exists but offset is past total items", async () => {
  const curated = [fakeArticle("c1", { text: "精选一" })];

  const contentPort: Pick<ContentPersistencePort, "listFeaturedArticles" | "listPublishedArticles"> = {
    async listFeaturedArticles(input) {
      const offset = input?.offset ?? 0;
      return offset === 0 ? curated : [];
    },
    async listPublishedArticles() {
      return [fakeArticle("p1", { text: "长长长长长长长长长长长长" })];
    },
  };

  // Offset 5 is beyond curated length 1. It must NOT fall back to published works because shelf IS curated.
  const result = await resolveFeaturedArticles(contentPort, { locale: "zh-CN", limit: 10, offset: 5 });
  assert.deepEqual(result, []);
});

test("resolveFeaturedArticles handles empty published catalogue gracefully", async () => {
  const contentPort: Pick<ContentPersistencePort, "listFeaturedArticles" | "listPublishedArticles"> = {
    async listFeaturedArticles() { return []; },
    async listPublishedArticles() { return []; },
  };
  const result = await resolveFeaturedArticles(contentPort, { locale: "zh-CN", limit: 20, offset: 0 });
  assert.deepEqual(result, []);
});

test("application services facade uses algorithm when uncurated and switches when editor arranges", async () => {
  const short = fakeArticle("short", { text: "短" });
  const long = fakeArticle("long", { text: "长长长" });

  let storedFeaturedIds: string[] = [];

  const fakeStore = {
    async listFeaturedArticles() {
      return storedFeaturedIds.map((id) => (id === "short" ? short : long));
    },
    async setFeaturedArticles({ articleIds }: { articleIds: string[] }) {
      storedFeaturedIds = [...articleIds];
      return storedFeaturedIds.map((id) => (id === "short" ? short : long));
    },
    async listPublishedArticles() {
      return [short, long];
    },
    async getUserRole() { return "editor"; },
    async isSessionRevoked() { return false; },
  };

  const services = createApplicationServices({
    persistence: fakeStore as never,
    env: { EDITOR_USER_IDS: "editor-1" },
  });

  // Phase 1: Uncurated -> algorithm selects [long, short]
  const initial = await services.listFeaturedArticles({ locale: "zh-CN" });
  assert.deepEqual(initial.map((a) => a.id), ["long", "short"]);

  // Phase 2: Editor manually sets [short] as featured
  await services.setFeaturedArticles({
    actorId: "editor-1",
    articleIds: ["short"],
  });

  // Phase 3: Now curated -> editor's pick overrides algorithm
  const curated = await services.listFeaturedArticles({ locale: "zh-CN" });
  assert.deepEqual(curated.map((a) => a.id), ["short"]);
});
