import assert from "node:assert/strict";
import test from "node:test";
import {
  decodeSharedPassage,
  encodeSharedPassage,
  passageShareUrl,
  searchablePassage,
  SHARE_PREFIX,
  type SharedPassage,
} from "./passage-share.ts";
import { PASSAGE_LIMIT, anchorIn, characterCount, relocate } from "./passages.ts";

/**
 * 分享一段划线, without a browser.
 *
 * What is worth testing here is the boundary the link is: a passage goes in one
 * end and comes back the same at the other, in every alphabet a work is written
 * in, and everything else — a fragment that is not ours, one that has been cut
 * short by a chat window, one that has been edited by a reader who wanted to
 * see what would happen — comes back as `null` rather than as a passage that
 * was never marked.
 */

const SOURCE = "那年冬天，渡口的船停了。河面很静，静得能听见冰。第二年的春天，船又开了。";
const ANCHOR = anchorIn(SOURCE, 13, 24);

const roundTrip = (passage: SharedPassage): SharedPassage | null =>
  decodeSharedPassage(`#${SHARE_PREFIX}${encodeSharedPassage(passage)}`);

test("一段划线往返之后还是原来那段", () => {
  assert.deepEqual(roundTrip(ANCHOR), { start: 13, end: 24, text: ANCHOR.text });
  assert.equal(roundTrip(ANCHOR)?.text, SOURCE.slice(13, 24));
});

test("汉字、假名、谚文、emoji 都原样回来", () => {
  for (const text of ["河面很静", "あいうえお", "안녕하세요", "a 🚀 b 🚀 c", "mixed 中文 with ASCII", "​"]) {
    assert.equal(roundTrip({ start: 5, end: 5 + text.length, text })?.text, text);
  }
});

test("分享出去的链接里只有作品的原文，没有笔记", () => {
  // The note is the reader's own thought; it is the one thing a share must not
  // carry. Encoding takes an anchor, and an anchor has no note in it to take.
  const encoded = encodeSharedPassage(ANCHOR);
  assert.equal(encoded.includes("笔记"), false);
  assert.equal(decodeSharedPassage(`#${SHARE_PREFIX}${encoded}`) && "note" in (decodeSharedPassage(`#${SHARE_PREFIX}${encoded}`) ?? {}), false);
});

test("链接落在作品自己的地址上，并丢掉原有的 fragment", () => {
  assert.equal(passageShareUrl("https://example.test/articles/a-work", ANCHOR).split("#")[0], "https://example.test/articles/a-work");
  // A reader who follows one shared passage and then another gets the second:
  // only one belongs in a fragment, and it is the one being shared now.
  const first = passageShareUrl("https://example.test/articles/a-work", ANCHOR);
  const second = passageShareUrl(first, { start: 1, end: 2, text: "后来" });
  assert.equal(second.match(/#/g)?.length, 1);
  assert.equal(decodeSharedPassage(second)?.text, "后来");
});

test("不是我们的 fragment 就不是一段划线", () => {
  for (const hash of ["", "#", "#nw-passages", "#:~:text=河面很静", "#nw-p", "#nw-p=", "#heading-one"]) {
    assert.equal(decodeSharedPassage(hash), null, `no passage in ${JSON.stringify(hash)}`);
  }
});

test("被截断的 fragment 只剩下救得回来的那几个字", () => {
  const good = `#${SHARE_PREFIX}${encodeSharedPassage(ANCHOR)}`;
  assert.ok(decodeSharedPassage(good));
  // A chat window that wrapped a long link, or a reader who copied it by hand
  // and missed the end: what survives is a shorter passage, not a wrong one.
  const cut = decodeSharedPassage(good.slice(0, good.length - 4));
  assert.ok(cut, "the part of the link that arrived still describes a passage");
  assert.ok(cut.text.length < ANCHOR.text.length, "and it is shorter than the one that was shared");
  assert.ok(ANCHOR.text.startsWith(cut.text), "what is left is a piece of the original, never other words");
  // …and it is still the work's own words, in the work's own place.
  const where = relocate(searchablePassage(cut), SOURCE);
  assert.ok(where);
  assert.equal(SOURCE.slice(where.start, where.end), cut.text);
});

test("链接可以带上作品里没有的话，但作品说了算", () => {
  const forged = `#${SHARE_PREFIX}${encodeSharedPassage({ start: 13, end: 24, text: "一句作品里没有的话" })}`;
  assert.equal(decodeSharedPassage(forged)?.text, "一句作品里没有的话", "a link may carry any words a reader puts in it");
  // Which is why nothing is painted straight from the link: the passage is
  // looked for in the work, and the work decides.
  assert.equal(relocate(searchablePassage(decodeSharedPassage(forged)!), SOURCE), null);
});

test("畸形输入一律拒绝", () => {
  for (const body of [
    "13.24.", // no words at all
    "13.24.!!!!", // characters outside the alphabet
    "13.24.QQ==", // padding does not belong in base64url
    "13.24.Q", // one character too many for a whole group
    "13.12.aGk", // end before start
    "-1.24.aGk", // negative offsets
    "13.24.aGk.extra", // a fourth field
    "1e3.24.aGk", // not an integer
    "99999999.99999999.aGk", // offsets no work is long enough for
    "13..aGk",
  ]) {
    assert.equal(decodeSharedPassage(`#${SHARE_PREFIX}${body}`), null, `refused: ${body}`);
  }
});

test("不是 UTF-8 的字节不是一段划线", () => {
  // 0xff can never begin a UTF-8 sequence, so a decoder that is asked to be
  // strict refuses it — rather than handing the page back replacement
  // characters where a reader's words should be.
  assert.equal(decodeSharedPassage(`#${SHARE_PREFIX}0.2._w`), null);
  assert.equal(decodeSharedPassage(`#${SHARE_PREFIX}0.2.//8`), null);
});

test("超过一次划线上限的文字被截断, 而不是被拒绝", () => {
  const long = "河".repeat(PASSAGE_LIMIT + 40);
  assert.equal(characterCount(long) > PASSAGE_LIMIT, true);
  const decoded = roundTrip({ start: 0, end: long.length, text: long });
  assert.equal(characterCount(decoded?.text ?? ""), PASSAGE_LIMIT, "a link stays within what a mark can hold");
});

test("链接里只有 URL 安全的字符", () => {
  const encoded = encodeSharedPassage({ start: 13, end: 24, text: "河面很静，静得能听见冰??//" });
  assert.equal(encodeURIComponent(encoded), encoded, "it can be pasted anywhere without being mangled");
});
