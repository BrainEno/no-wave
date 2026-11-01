import assert from "node:assert/strict";
import test from "node:test";
import type { ArticleContentBlock } from "./content.ts";
import { blockPosition, blockSpeech, CHUNK_LIMIT, speakChunks, speechLang, splitSentences } from "./read-aloud.ts";

const paragraph = (id: string, text: string): ArticleContentBlock => ({ id, type: "paragraph", text });

test("代码不朗读，图片只读图注，引文带上出处", () => {
  assert.equal(blockSpeech({ id: "c", type: "code", language: "ts", code: "const a = 1;" }), "");
  assert.equal(blockSpeech({ id: "i", type: "image", src: "/a.jpg", alt: "一张照片", caption: "渡口，1998" }), "渡口，1998");
  assert.equal(blockSpeech({ id: "i2", type: "image", src: "/a.jpg", alt: "一张照片" }), "");
  assert.equal(blockSpeech({ id: "q", type: "quote", text: "河面很静。", attribution: "无名" }), "河面很静。——无名");
  assert.equal(blockSpeech({ id: "q2", type: "quote", text: "河面很静。" }), "河面很静。");
});

test("列表按脚本选择停顿符号", () => {
  assert.equal(blockSpeech({ id: "l", type: "list", ordered: false, items: ["一", "二"] }), "一；二");
  assert.equal(blockSpeech({ id: "l2", type: "list", ordered: true, items: ["one", "two"] }), "one, two");
});

test("中英文都按句末标点断句，并保留标点", () => {
  assert.deepEqual(splitSentences("那年冬天，船停了。渡口没有人。"), ["那年冬天，船停了。", "渡口没有人。"]);
  assert.deepEqual(splitSentences("It stopped. Nobody came! Really?"), ["It stopped.", "Nobody came!", "Really?"]);
  assert.deepEqual(splitSentences("“走吧。”她说。"), ["“走吧。”", "她说。"]);
  assert.deepEqual(splitSentences("   "), []);
});

test("块按原文顺序朗读，空块与代码块被跳过", () => {
  const chunks = speakChunks([
    paragraph("a", "第一段。"),
    { id: "b", type: "code", language: "ts", code: "x" },
    paragraph("c", "   "),
    paragraph("d", "第二段。"),
  ]);
  assert.deepEqual(chunks.map((chunk) => [chunk.blockId, chunk.text]), [["a", "第一段。"], ["d", "第二段。"]]);
});

test("同一段内的短句合并，跨段不合并", () => {
  const chunks = speakChunks([
    paragraph("a", "第一句。第二句。"),
    paragraph("b", "第三段的第一句。"),
  ]);
  assert.deepEqual(chunks.map((chunk) => chunk.blockId), ["a", "b"]);
  assert.equal(chunks[0]?.text, "第一句。 第二句。");
});

test("超过上限的长句在标点或词界处切开，且不超过上限", () => {
  const long = `${"这是一个很长的句子，".repeat(30)}最后结束。`;
  const chunks = speakChunks([paragraph("a", long)]);
  assert.ok(chunks.length > 1, "a long sentence is split");
  for (const chunk of chunks) assert.ok(chunk.text.length <= CHUNK_LIMIT, `chunk too long: ${chunk.text.length}`);
  for (const chunk of chunks) assert.ok(!chunk.text.startsWith("，"), "a chunk never opens with the punctuation that cut it");
  // Nothing is lost: joining the pieces reproduces the sentence.
  assert.equal(chunks.map((chunk) => chunk.text).join("").replace(/\s/g, ""), long.replace(/\s/g, ""));
});

test("长英文句子在空格处切开，不切断单词", () => {
  const words = Array.from({ length: 80 }, (_unused, index) => `word${index}`).join(" ");
  const chunks = speakChunks([paragraph("a", `${words}.`)]);
  assert.ok(chunks.length > 1);
  for (const chunk of chunks) {
    assert.ok(chunk.text.length <= CHUNK_LIMIT, `chunk too long: ${chunk.text.length}`);
    for (const piece of chunk.text.split(" ")) {
      if (piece.length === 0) continue;
      assert.match(piece, /^word\d+\.?$/, `a chunk cut a word in half: ${piece}`);
    }
  }
});

test("段落位置按段数而不是分块数报给读者", () => {
  const chunks = speakChunks([
    paragraph("a", "第一段。"),
    paragraph("b", `${"很长的句子，".repeat(40)}完。`),
    paragraph("c", "第三段。"),
  ]);
  const last = chunks.length - 1;
  assert.deepEqual(blockPosition(chunks, 0), { position: 1, total: 3 });
  assert.deepEqual(blockPosition(chunks, last), { position: 3, total: 3 });
  assert.equal(blockPosition(chunks, -1), null);
  assert.equal(blockPosition(chunks, chunks.length), null);
});

test("朗读语言就是作品自己的语言", () => {
  assert.equal(speechLang("zh-CN"), "zh-CN");
  assert.equal(speechLang("zh-TW"), "zh-TW");
  assert.equal(speechLang("en"), "en-US");
});
