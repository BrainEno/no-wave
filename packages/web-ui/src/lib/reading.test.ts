import assert from "node:assert/strict";
import test from "node:test";
import { lengthLabel, readingMinutes, textLength } from "./reading.ts";

const blocks = [
  { id: "a", type: "paragraph" as const, text: "那年冬天，渡口的船停了。" },
  { id: "b", type: "list" as const, ordered: false, items: ["一", "二"] },
  { id: "c", type: "code" as const, language: "ts", code: "ignored ignored" },
];

test("中文按字数统计，代码块不计入", () => {
  assert.equal(textLength(blocks, "zh-CN"), 12 + 2);
});
test("英文按词数统计", () => {
  assert.equal(textLength([{ id: "a", type: "paragraph", text: "A small testable foundation" }], "en"), 4);
});
test("阅读时长至少 1 分钟", () => {
  assert.equal(readingMinutes(10, "zh-CN"), 1);
  assert.equal(readingMinutes(4000, "zh-CN"), 10);
});
test("篇幅标签随语言变化", () => {
  assert.equal(lengthLabel(3200, "zh-CN"), "约 3,200 字");
  assert.equal(lengthLabel(3200, "en"), "3,200 words");
});
