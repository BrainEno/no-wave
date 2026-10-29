import assert from "node:assert/strict";
import test from "node:test";
import {
  ARTICLE_SUMMARY_MAX_LENGTH,
  summarizeArticleBlocks,
  summarizeArticleText,
} from "./article-summary.ts";

const ELLIPSIS_AFTER_PUNCTUATION = /[\p{P}\p{S}]…/u;
const TRAILING_HARD_PUNCTUATION = /[，,、；;：:]$/u;

const paragraph = (text: string) => ({ id: "p", type: "paragraph", text });

test("text shorter than the budget is returned unchanged, with no ellipsis", () => {
  const text = "这是一个很短的开头。";
  assert.equal(summarizeArticleText(text), text);
  assert.equal(summarizeArticleBlocks([paragraph(text)]), text);
});

test("complete sentences are kept while they fit and end without an ellipsis", () => {
  const first = "第一句话讲的是雨夜里的旧书店，它一直开到很晚。";
  const second = "第二句话讲的是店主养的那只猫，它睡在书堆上。";
  const summary = summarizeArticleText(`${first}${second}`);
  assert.equal(summary, `${first}${second}`);
  assert.equal(summary.endsWith("…"), false);
});

test("a following sentence that does not fit is dropped, not half-rendered", () => {
  const first = "第一句话讲的是雨夜里的旧书店，它一直开到很晚。";
  const rest = "第二句话讲的是店主养的那只猫，它睡在书堆上，而且很长。".repeat(4);
  const summary = summarizeArticleText(`${first}${rest}`);
  assert.ok(summary.length <= ARTICLE_SUMMARY_MAX_LENGTH, `too long: ${summary.length}`);
  assert.equal(`${first}${rest}`.startsWith(summary), true, "the excerpt must be a prefix of the body");
  assert.equal(summary.endsWith("…"), false, "a complete-sentence excerpt needs no ellipsis");
  assert.match(summary, /。$/);
  assert.ok(summary.length > first.length, "shorter sentences must still be kept while they fit");
});

test("a single over-long sentence is cut at a word boundary and closed with an ellipsis", () => {
  // No sentence terminator at all: nothing can be kept whole, so the sentence
  // itself has to be cut.
  const chinese = `${"雨夜里的旧书店一直开着灯，店主在门口等着一个不会来的人，这样的夜晚还有很多，".repeat(6)}`;
  const summary = summarizeArticleText(chinese);
  assert.ok(summary.length <= ARTICLE_SUMMARY_MAX_LENGTH + 1, `too long: ${summary.length}`);
  assert.equal(summary.endsWith("…"), true);
  assert.equal(chinese.startsWith(summary.slice(0, -1)), true, "the excerpt must be a prefix of the body");
  assert.equal(ELLIPSIS_AFTER_PUNCTUATION.test(summary), false);
});

test("Latin words are never split in half", () => {
  const sentence = "No Wave is a small literary magazine for people who still read long essays on rainy evenings and it keeps going."
    .repeat(3);
  const summary = summarizeArticleText(sentence, { locale: "en" });
  const head = summary.slice(0, -1);
  assert.equal(summary.endsWith("…"), true);
  assert.equal(sentence.startsWith(head), true);
  const next = sentence.slice(head.length);
  assert.match(next, /^[^A-Za-z0-9]|^$/, `the cut lands inside a word: …${head.slice(-20)}|${next.slice(0, 20)}`);
});

test("the ellipsis never follows another punctuation mark", () => {
  const samples = [
    `${"雨夜，旧书店，灯还亮着，".repeat(20)}`,
    `${"她说，这是一段很长的话，中间没有句号，只有逗号，".repeat(6)}`,
    `We waited, and waited, and waited, ${"and the rain never really stopped, ".repeat(12)}`,
    `${"第一句结束了。第二句还没完，".repeat(8)}`,
  ];
  for (const sample of samples) {
    const summary = summarizeArticleText(sample);
    assert.equal(ELLIPSIS_AFTER_PUNCTUATION.test(summary), false, `ellipsis after punctuation: ${summary}`);
    assert.equal(TRAILING_HARD_PUNCTUATION.test(summary.slice(0, -1)), false, `ends on a comma: ${summary}`);
  }
});

test("a sentence that ends on a terminator keeps its terminator", () => {
  const summary = summarizeArticleText(`${"雨夜里的旧书店一直开着灯。".repeat(12)}`);
  assert.equal(summary.endsWith("…"), false, "a complete-sentence excerpt needs no ellipsis");
  assert.match(summary, /[。！？]$/);
  assert.ok(summary.length <= ARTICLE_SUMMARY_MAX_LENGTH);
});

test("only prose blocks feed the excerpt: code and images are skipped", () => {
  const summary = summarizeArticleBlocks([
    { id: "code", type: "code", language: "ts", code: "const secret = 'not prose';" },
    { id: "image", type: "image", src: "/api/media/1", alt: "封面" },
    { id: "heading", type: "heading", level: 2, text: "雨夜" },
    { id: "list", type: "list", ordered: false, items: ["第一项", "第二项"] },
  ]);
  assert.equal(summary.includes("secret"), false);
  assert.equal(summary.includes("封面"), false);
  assert.equal(summary, "雨夜第一项，第二项");
});

test("blank input yields a blank summary instead of a stray ellipsis", () => {
  assert.equal(summarizeArticleText(""), "");
  assert.equal(summarizeArticleText("   \n  "), "");
  assert.equal(summarizeArticleBlocks([]), "");
  assert.equal(summarizeArticleBlocks(null), "");
  assert.equal(summarizeArticleBlocks([{ id: "p", type: "paragraph", text: "   " }]), "");
});

test("a custom budget is honoured", () => {
  const summary = summarizeArticleText(`${"雨夜里的旧书店一直开着灯。".repeat(12)}`, { maxLength: 20 });
  assert.ok(summary.length <= 21, `too long: ${summary.length}`);
  assert.equal(summarizeArticleText("短句。", { maxLength: 0 }), "短句。");
});
