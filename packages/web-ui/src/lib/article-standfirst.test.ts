import assert from "node:assert/strict";
import test from "node:test";
import { summarizeArticleBlocks } from "../../../../apps/api/src/domain/article-summary.ts";
import { repeatsArticleOpening } from "./article-standfirst.ts";
import type { ArticleContentBlock } from "./content.ts";

const paragraph = (text: string): ArticleContentBlock => ({ id: "p", type: "paragraph", text });
const heading = (text: string): ArticleContentBlock => ({ id: "h", type: "heading", level: 2, text });
const quote = (text: string): ArticleContentBlock => ({ id: "q", type: "quote", text });
const list = (...items: string[]): ArticleContentBlock => ({ id: "l", type: "list", ordered: false, items });
const image: ArticleContentBlock = { id: "i", type: "image", src: "/image.webp", alt: "", caption: "Cover" };
const code: ArticleContentBlock = { id: "c", type: "code", code: "const hidden = true;", language: "ts" };

test("a summary repeating the first paragraph is hidden, independently of whitespace", () => {
  const content = [paragraph("  天亮了。\n  雨还在下。 ")];
  assert.equal(repeatsArticleOpening("天亮了。 雨还在下。", content), true);
  assert.equal(repeatsArticleOpening("天亮了。", content), true);
  assert.equal(repeatsArticleOpening("天亮了。雨还在下。", content), false, "whitespace is not discarded between words");
});

test("a distinct editorial standfirst is retained even when body contains similar text later", () => {
  const content = [paragraph("故事从这里开始。"), paragraph("夜晚的来信。")] ;
  for (const summary of ["夜晚的来信。", "故事从别处开始。", "这是一篇不同的作品。", "前言：故事从这里开始。", "故事从这里开始。额外介绍"]) {
    assert.equal(repeatsArticleOpening(summary, content), false, summary);
  }
});

test("cut summaries with an ellipsis compare against the visible opening", () => {
  const content = [paragraph("一场漫长的雨，改变了这个地方。")];
  assert.equal(repeatsArticleOpening("一场漫长的雨…", content), true);
  assert.equal(repeatsArticleOpening("一场漫长的雨...", content), true);
  assert.equal(repeatsArticleOpening("完全不同…", content), false);
  assert.equal(repeatsArticleOpening("…", content), false);
  assert.equal(repeatsArticleOpening("", content), false);
});

test("opening comparison follows the same block selection as the API summary", () => {
  const content = [image, code, heading("开篇"), paragraph("雨下了一夜。"), quote("后来天晴了。"), list("甲", "乙")];
  const summary = summarizeArticleBlocks(content);
  assert.equal(summary, "开篇雨下了一夜。后来天晴了。甲，乙");
  assert.equal(repeatsArticleOpening(summary, content), true);
  assert.equal(repeatsArticleOpening("Cover", content), false);
  assert.equal(repeatsArticleOpening("const hidden = true;", content), false);
});

test("Latin block boundaries retain a word separator without inventing Chinese spaces", () => {
  assert.equal(repeatsArticleOpening("First paragraph Second paragraph", [paragraph("First paragraph"), paragraph("Second paragraph")]), true);
  assert.equal(repeatsArticleOpening("First paragraphSecond paragraph", [paragraph("First paragraph"), paragraph("Second paragraph")]), false);
  assert.equal(repeatsArticleOpening("第一段第二段", [paragraph("第一段"), paragraph("第二段")]), true);
});

test("no body prose never hides a summary", () => {
  for (const blocks of [[], [image], [code], [paragraph("  ")]]) {
    assert.equal(repeatsArticleOpening("Visible description", blocks), false);
  }
});

test("API-generated excerpts are recognized across languages and length boundaries", () => {
  const samples = [
    [paragraph("这是一篇短文章。")],
    [paragraph("雨夜里的旧书店一直开着灯。".repeat(20))],
    [paragraph("A long literary sentence with several words that continues without stopping ".repeat(8))],
    [heading("序言"), paragraph("他走进了一间安静的书房。"), paragraph("窗外仍有雨。")],
    [list("第一项", "第二项"), paragraph("列表之后。")],
  ];
  for (const blocks of samples) {
    for (const limit of [30, 60, 110]) {
      const summary = summarizeArticleBlocks(blocks, { maxLength: limit });
      assert.ok(summary);
      assert.equal(repeatsArticleOpening(summary, blocks), true, `generated: ${summary}`);
    }
  }
});
