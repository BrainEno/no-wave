import assert from "node:assert/strict";
import test from "node:test";
import type { ArticleView, WorkType } from "./content.ts";
import { renderSiteFeed, SITE_FEED_LIMIT, siteFeedLinks, siteFeedPath } from "./site-feed.ts";

function work(index: number, workType: WorkType = "other"): ArticleView {
  return { slug: `work-${index}`, title: `作品 ${index}`, description: "<b>不是 HTML</b>", workType, contentBlocks: [],
    publishedAt: `2026-11-${String(10 + (index % 10)).padStart(2, "0")}T08:00:00.000Z`,
    author: { username: "writer", displayName: "作者", bio: "", locale: "zh-CN", availableLocales: ["zh-CN"] },
    categories: [], tags: [], locale: "zh-CN", availableLocales: ["zh-CN"], likeCount: 0 };
}

test("the site feed lives under the archive in each locale and is advertised in both formats", () => {
  assert.equal(siteFeedPath("zh-CN", "atom"), "/articles/feed.atom");
  assert.equal(siteFeedPath("zh-CN", "rss"), "/articles/feed.xml");
  assert.equal(siteFeedPath("en", "atom"), "/en/articles/feed.atom");
  assert.deepEqual(siteFeedLinks("en").map((link) => [link.href, link.type]), [
    ["/en/articles/feed.atom", "application/atom+xml"], ["/en/articles/feed.xml", "application/rss+xml"],
  ]);
});

test("the site feed is bounded, filed by genre and never carries markup", () => {
  const articles = Array.from({ length: SITE_FEED_LIMIT + 5 }, (_, index) => work(index, index === 0 ? "novel" : "other"));
  const { body, self, alternate } = renderSiteFeed({ articles, locale: "zh-CN", siteUrl: "https://site.example/ignored", format: "atom" });
  assert.equal(body.match(/<entry>/g)?.length, SITE_FEED_LIMIT);
  assert.equal(self, "https://site.example/articles/feed.atom");
  assert.equal(alternate, "https://site.example/articles");
  assert.match(body, /<entry>\n<id>https:\/\/site\.example\/articles\/work-0<\/id>[\s\S]*?<category term="小说"\/>/);
  assert.match(body, /<category term="其他文体"\/>/);
  assert.ok(!body.includes("<b>"));
  assert.match(body, /&lt;b&gt;不是 HTML&lt;\/b&gt;/);
});
