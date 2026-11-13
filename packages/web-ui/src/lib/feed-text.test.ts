import assert from "node:assert/strict";
import test from "node:test";
import { feedText, feedTimestamp, xmlText } from "./feed-text.ts";

test("XML text escapes both element and attribute delimiters without creating markup", () => {
  const value = `A & B <script x="1">'unsafe'</script>`;
  assert.equal(xmlText(value), "A &amp; B &lt;script x=&quot;1&quot;&gt;&apos;unsafe&apos;&lt;/script&gt;");
  assert.equal(xmlText("&lt;existing&gt;"), "&amp;lt;existing&amp;gt;", "existing entities are still literal user text");
  assert.equal(xmlText("]]><!DOCTYPE feed [<!ENTITY x SYSTEM 'file:///etc/passwd'>]>"),
    "]]&gt;&lt;!DOCTYPE feed [&lt;!ENTITY x SYSTEM &apos;file:///etc/passwd&apos;&gt;]&gt;");
});

test("illegal XML controls and lone surrogates become replacement text, not a broken document", () => {
  for (const character of ["\0", "\u0001", "\u0008", "\u000b", "\u000c", "\u001f", "\ud800", "\udfff", "\ufffe", "\uffff"]) {
    assert.equal(xmlText(`left${character}right`), "left�right");
  }
  assert.equal(xmlText("a\tb\nc\rd"), "a\tb\nc\rd");
  assert.equal(xmlText("繁體中文 café 𠀀 🌊"), "繁體中文 café 𠀀 🌊");
});

test("bounded feed text counts Unicode scalars and keeps a whole supplementary character", () => {
  assert.equal(feedText("一二三四", 4), "一二三四");
  assert.equal(feedText("一二三四五", 4), "一二三…");
  assert.equal(feedText("𠀀🌊abc", 4), "𠀀🌊a…");
  assert.equal(feedText("𠀀🌊", 2), "𠀀🌊");
  assert.equal(feedText("more", 1), "…");
  assert.equal(feedText("", 1), "");
  assert.equal(feedText("a\ud800bc", 3), "a�…");
});

test("text caps cannot be zero, non-finite, fractional or accidentally unbounded", () => {
  for (const limit of [0, -1, 2.5, NaN, Infinity, 4001]) assert.throws(() => feedText("text", limit), /text limit/);
  assert.equal([...feedText("𠀀".repeat(10000), 320)].length, 320);
  assert.equal(feedText("x".repeat(10000), 320).endsWith("…"), true);
  assert.equal(feedText("x".repeat(320), 320).endsWith("…"), false);
});

test("a feed timestamp is normalized to a deterministic UTC instant, never the render clock", () => {
  assert.equal(feedTimestamp("2026-11-12T12:00:00+08:00"), "2026-11-12T04:00:00.000Z");
  assert.equal(feedTimestamp("2026-11-12T12:00:00.1Z"), "2026-11-12T12:00:00.100Z");
  assert.equal(feedTimestamp("2026-11-12T12:00:00.123Z"), "2026-11-12T12:00:00.123Z");
  assert.equal(feedTimestamp("2024-02-29T23:59:59Z"), "2024-02-29T23:59:59.000Z");
  assert.equal(feedTimestamp("2000-02-29T00:00:00Z"), "2000-02-29T00:00:00.000Z");
});

test("calendar overflow and locale-dependent date strings cannot become misleading publication dates", () => {
  const invalid = ["", "yesterday", "11/12/2026", "2026-11-12", "2026-02-29T00:00:00Z", "1900-02-29T00:00:00Z",
    "2026-04-31T00:00:00Z", "2026-00-01T00:00:00Z", "2026-13-01T00:00:00Z", "2026-01-00T00:00:00Z",
    "2026-01-01T24:00:00Z", "2026-01-01T00:60:00Z", "2026-01-01T00:00:60Z", "0000-01-01T00:00:00Z",
    "2026-01-01T00:00:00", "2026-01-01T00:00:00.1234Z", "2026-01-01T00:00:00+99:00"];
  for (const value of invalid) assert.throws(() => feedTimestamp(value), /publication timestamp/, value);
});
