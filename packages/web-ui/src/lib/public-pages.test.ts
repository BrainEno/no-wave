import assert from "node:assert/strict";
import test from "node:test";
import type { PublicContentSource } from "./api-content.ts";
import type { ArticleView, WorkType } from "./content.ts";
import { ARCHIVE_TYPE_SCAN_LIMIT, GENRE_NEWEST_LIMIT, HOME_LATEST_LIMIT, loadCategoryIndexPage, loadHomePage, summarizeGenres } from "./public-pages.ts";

function work(slug: string, workType: WorkType): ArticleView {
  return { slug, title: slug, description: "", workType, contentBlocks: [],
    publishedAt: "2026-11-01T08:30:00.000Z", author: { username: "writer", displayName: "作者", bio: "", locale: "zh-CN", availableLocales: ["zh-CN"] },
    categories: [], tags: [], locale: "zh-CN", availableLocales: ["zh-CN"], likeCount: 0 };
}

/** Newest first, the order `sort: "latest"` returns. */
const window = [
  work("n1", "novel"), work("o1", "other"), work("n2", "novel"), work("n3", "novel"),
  work("n4", "novel"), work("o2", "other"),
];

test("genres are the three work types in a fixed order, each with its count and newest works", () => {
  const genres = summarizeGenres(window, { windowFull: false });
  assert.deepEqual(genres.map((genre) => genre.type), ["novel", "poetry", "other"]);
  assert.deepEqual(genres.map((genre) => genre.count), [4, 0, 2]);
  assert.deepEqual(genres[0]?.newest.map((article) => article.slug), ["n1", "n2", "n3"]);
  assert.equal(genres[0]?.newest.length, GENRE_NEWEST_LIMIT);
  // An empty genre is still a column, not a missing one.
  assert.deepEqual(genres[1], { type: "poetry", count: 0, countIsLowerBound: false, newest: [] });
  assert.ok(summarizeGenres(window, { windowFull: true }).every((genre) => genre.countIsLowerBound));
  assert.ok(summarizeGenres(window, { windowFull: false, newest: 0 }).every((genre) => genre.newest.length === 0));
});

/** A source that records every call and answers each list from `window`. */
function recordingSource(failing: ReadonlySet<string> = new Set()) {
  const calls: string[] = [];
  const source = {
    listPublicFeatured: async () => { calls.push("featured"); if (failing.has("featured")) throw new Error("down"); return []; },
    listPublicArticles: async (options: { sort?: string; limit?: number }) => {
      calls.push(`articles:${options.sort}:${options.limit}`);
      if (failing.has(options.sort ?? "")) throw new Error("down");
      return window.slice(0, options.limit);
    },
    listPublicCategories: async () => { calls.push("categories"); return []; },
  } as unknown as PublicContentSource;
  return { source, calls };
}

test("the home page reads the newest window once and draws the latest row and the genres from it", async () => {
  const { source, calls } = recordingSource();
  const page = await loadHomePage({ locale: "zh-CN" }, source);
  assert.deepEqual(calls.sort(), ["articles:latest:" + ARCHIVE_TYPE_SCAN_LIMIT, "articles:popular:6", "featured"]);
  assert.ok(page.latest.length <= HOME_LATEST_LIMIT);
  assert.deepEqual(page.latest.map((article) => article.slug), window.map((article) => article.slug));
  assert.deepEqual(page.genres.map((genre) => genre.newest.map((article) => article.slug)), [["n1", "n2", "n3"], [], ["o1", "o2"]]);
  assert.equal(page.genres[0]?.countIsLowerBound, false);
});

test("a failed shelf is dropped, but a failed newest read still fails the home page", async () => {
  const shelvesDown = await loadHomePage({ locale: "zh-CN" }, recordingSource(new Set(["featured", "popular"])).source);
  assert.deepEqual(shelvesDown.featured, []);
  assert.deepEqual(shelvesDown.popular, []);
  assert.equal(shelvesDown.genres[0]?.count, 4);
  await assert.rejects(loadHomePage({ locale: "zh-CN" }, recordingSource(new Set(["latest"])).source));
});

test("the category index counts the same window and lists no works", async () => {
  const { source, calls } = recordingSource();
  const page = await loadCategoryIndexPage({ locale: "en" }, source);
  assert.deepEqual(calls, ["articles:latest:" + ARCHIVE_TYPE_SCAN_LIMIT]);
  assert.deepEqual(page.genres.map((genre) => [genre.type, genre.count, genre.newest.length]), [["novel", 4, 0], ["poetry", 0, 0], ["other", 2, 0]]);
});
