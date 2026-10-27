import assert from "node:assert/strict";
import test from "node:test";
import { firstLines, paginate, parsePage, parseWorkType, splitHighlight } from "./work-types.ts";

test("只接受 API 定义的作品类型", () => {
  assert.equal(parseWorkType("poetry"), "poetry");
  assert.equal(parseWorkType(["essay", "poetry"]), "essay");
  assert.equal(parseWorkType("podcast"), null);
  assert.equal(parseWorkType(undefined), null);
});
test("页码被限制在安全范围内", () => {
  assert.equal(parsePage("3"), 3);
  assert.equal(parsePage("0"), 1);
  assert.equal(parsePage("abc"), 1);
  assert.equal(parsePage("99999"), 1);
});
test("内存分页返回当前页与是否有下一页", () => {
  const items = Array.from({ length: 45 }, (_, index) => index);
  assert.deepEqual(paginate(items, 3).visible, [40, 41, 42, 43, 44]);
  assert.equal(paginate(items, 3).hasNextPage, false);
  assert.equal(paginate(items, 1).hasNextPage, true);
});
test("高亮片段不改变原文，也不使用 HTML", () => {
  const parts = splitHighlight("停电的夜晚，夜很长", "夜");
  assert.equal(parts.map((part) => part.text).join(""), "停电的夜晚，夜很长");
  assert.equal(parts.filter((part) => part.hit).length, 2);
  assert.deepEqual(splitHighlight("abc", "  "), [{ text: "abc", hit: false }]);
});
test("诗歌摘句取前两行非空行", () => {
  assert.deepEqual(firstLines("舷灯一盏\n\n海在下面\n第三行"), ["舷灯一盏", "海在下面"]);
});
