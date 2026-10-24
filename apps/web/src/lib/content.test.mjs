import test from "node:test";
import assert from "node:assert/strict";
import {
  articleFixture,
  articleMetadata,
  articlePath,
  archivePath,
  getArticleBySlug,
  getAuthorByUsername,
  listArticles,
  defaultLocale
} from "./content.mjs";

test("article paths encode slugs and use a locale prefix only for non-default locales", () => {
  assert.equal(articlePath("hello world"), "/articles/hello%20world");
  assert.equal(articlePath("hello world", "en"), "/en/articles/hello%20world");
});

test("localized article metadata contains canonical and language-alternate URLs", () => {
  const metadata = articleMetadata(articleFixture, "https://blog.example");
  assert.equal(metadata.title, "文学作品的数字出版空间");
  assert.equal(metadata.alternates.canonical, "https://blog.example/articles/portable-web-foundation");
  assert.equal(metadata.alternates.languages.en, "https://blog.example/en/articles/portable-web-foundation");
  assert.equal(metadata.openGraph.url, metadata.alternates.canonical);
  assert.equal(metadata.description, articleFixture.description);
});

test("content registry returns localized article and author views", () => {
  const zhArticle = getArticleBySlug("portable-web-foundation", "zh-TW");
  const enArticle = getArticleBySlug("portable-web-foundation", "en");
  assert.equal(zhArticle.title, "可移植的 Web 基礎架構");
  assert.equal(enArticle.title, "A Portable Web Foundation");
  assert.equal(zhArticle.author.displayName, "BOT THK 團隊");
  assert.equal(enArticle.author.displayName, "BOT THK Team");
  assert.equal(zhArticle.contentBlocks[0].type, "paragraph");
  assert.equal(enArticle.contentBlocks[1].type, "heading");
  assert.equal(getArticleBySlug("missing-article", "en"), null);
  assert.equal(getAuthorByUsername("missing-author", defaultLocale), null);
});

test("article listing supports localized text search and author filtering", () => {
  assert.equal(listArticles({ locale: "zh-TW", query: "可移植" }).length, 1);
  assert.equal(listArticles({ locale: "en", query: "portable" }).length, 1);
  assert.equal(listArticles({ locale: "en", query: "完全不存在" }).length, 0);
  assert.equal(listArticles({ locale: "en", authorUsername: "bot-thk-team" }).length, 1);
  assert.equal(archivePath("en"), "/en/articles");
});


test("Simplified Chinese is the default locale and fixture copy is localized", () => {
  assert.equal(defaultLocale, "zh-CN");
  assert.equal(articleFixture.locale, "zh-CN");
  assert.equal(articleFixture.author.displayName, "无浪潮编辑部");
  assert.match(articleFixture.description, /严肃文学/);
  assert.equal(articleFixture.workType, "essay");
  assert.equal(archivePath("zh-CN"), "/articles");
});
