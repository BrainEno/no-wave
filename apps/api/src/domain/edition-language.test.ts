import assert from "node:assert/strict";
import test from "node:test";
import { inferEditionLocale } from "./edition-language.ts";

const paragraph = (text: string) => ({ type: "paragraph", text });

test("an edition with English text and no CJK anywhere is English", () => {
  assert.equal(inferEditionLocale({ title: "The Face in the Wall", contentBlocks: [paragraph("It came through the plaster.")] }), "en");
  assert.equal(inferEditionLocale({ title: "1984", summary: "A short poem", contentBlocks: [] }), "en");
  assert.equal(inferEditionLocale({ title: "", contentBlocks: [{ type: "list", ordered: false, items: ["one", "two"] }] }), "en");
});

test("one Han, kana or hangul character anywhere keeps the edition Chinese", () => {
  const english = [paragraph("Through the walls.")];
  assert.equal(inferEditionLocale({ title: "墙中脸", contentBlocks: english }), "zh-CN");
  assert.equal(inferEditionLocale({ title: "Walls", summary: "穿墙", contentBlocks: english }), "zh-CN");
  assert.equal(inferEditionLocale({ title: "Walls", contentBlocks: [...english, { type: "quote", text: "Plaster", attribution: "卡夫卡" }] }), "zh-CN");
  assert.equal(inferEditionLocale({ title: "Walls", contentBlocks: [{ type: "image", src: "/api/media/x", alt: "墙" }] }), "zh-CN");
  // Any string in the stored JSON counts, including fields no reader sees.
  assert.equal(inferEditionLocale({ title: "Walls", contentBlocks: [{ type: "code", text: "x = 1", language: "注释" }] }), "zh-CN");
  assert.equal(inferEditionLocale({ title: "かべ", contentBlocks: [] }), "zh-CN");
  assert.equal(inferEditionLocale({ title: "벽", contentBlocks: [] }), "zh-CN");
});

test("an edition with nothing to read stays Chinese, the site's default", () => {
  assert.equal(inferEditionLocale({ title: "", contentBlocks: [] }), "zh-CN");
  assert.equal(inferEditionLocale({ title: "2026", summary: "——", contentBlocks: [paragraph("1, 2, 3")] }), "zh-CN");
  // A block's type and address are Latin, but nobody reads them.
  assert.equal(inferEditionLocale({ title: "", contentBlocks: [{ type: "image", src: "/api/media/abc" }, { type: "divider" }] }), "zh-CN");
});

test("Chinese punctuation alone is not a Chinese character", () => {
  assert.equal(inferEditionLocale({ title: "“Walls”——", contentBlocks: [] }), "en");
});
