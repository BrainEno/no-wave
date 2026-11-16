import assert from "node:assert/strict";
import test from "node:test";
import { findInReadingBlocks, nextReadingMatch, type ReadingFindOptions } from "./reader-find.ts";

const options: ReadingFindOptions = { caseSensitive: false, foldWidth: true };

test("article search is literal, bounded, and returns original UTF-16 offsets after width/case folding", () => {
  const result = findInReadingBlocks([{ id: "p", text: "第一句：Ｒｉｖｅｒ。River 与 river。" }], "river", options);
  assert.equal(result.matches.length, 3);
  for (const match of result.matches) assert.match(match.text, /Ｒｉｖｅｒ|River|river/u);
  assert.equal(result.matches[0]?.start, 4);
  assert.equal(findInReadingBlocks([{ id: "p", text: "a+b [x]" }], "a+b", options).matches.length, 1);
  assert.equal(findInReadingBlocks([{ id: "p", text: "Ｒｉｖｅｒ River river" }], "River", { caseSensitive: true, foldWidth: false }).matches.length, 1);
  assert.equal(findInReadingBlocks([{ id: "p", text: "  " }], "", options).matches.length, 0);
});

test("normalization preserves emoji, combining marks, repeated spaces and DOM range witnesses", () => {
  const text = "🦊 cafe\u0301   浪潮。";
  const result = findInReadingBlocks([{ id: "p", text }], "café 浪", options);
  assert.equal(result.matches.length, 1);
  const match = result.matches[0]!;
  assert.equal(text.slice(match.start, match.end), "cafe\u0301   浪");
  assert.equal(match.blockId, "p");
  assert.equal(findInReadingBlocks([{ id: "p1", text: "river" }, { id: "p2", text: "bank" }], "riverbank", options).matches.length, 0, "paragraph boundaries never disappear");
});

test("limits are explicit and a long article/query cannot create unbounded ranges", () => {
  const result = findInReadingBlocks([{ id: "p", text: "浪".repeat(500) }], "浪", options);
  assert.equal(result.matches.length, 200);
  assert.equal(result.moreMatches, true);
  assert.equal(findInReadingBlocks([{ id: "p", text: "a".repeat(210_000) }], "z", options).limitedText, true);
  assert.equal(findInReadingBlocks([{ id: "p", text: "a" }], "x".repeat(101), options).invalidQuery, true);
});

test("next and previous wrap without inventing an active match for empty results", () => {
  assert.equal(nextReadingMatch(-1, 1, 3), 0);
  assert.equal(nextReadingMatch(2, 1, 3), 0);
  assert.equal(nextReadingMatch(0, -1, 3), 2);
  assert.equal(nextReadingMatch(-1, -1, 3), 2);
  assert.equal(nextReadingMatch(0, 1, 0), -1);
});
