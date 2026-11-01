import assert from "node:assert/strict";
import test from "node:test";
import { defaultCovers, hashSeed, pickDefaultCover } from "./covers.ts";

test("同一个 slug 永远得到同一张默认封面", () => {
  assert.equal(pickDefaultCover("snow-line").src, pickDefaultCover("snow-line").src);
  assert.ok(defaultCovers.some((cover) => cover.src === pickDefaultCover("any-slug").src));
});
test("哈希是稳定的 32 位无符号整数", () => {
  assert.equal(hashSeed(""), 0x811c9dc5);
  assert.ok(hashSeed("夜航") >= 0 && hashSeed("夜航") <= 0xffffffff);
});
test("不同的 slug 会分布到多张封面上", () => {
  const used = new Set(Array.from({ length: 40 }, (_, index) => pickDefaultCover("work-" + index).name));
  assert.ok(used.size >= 3);
});
