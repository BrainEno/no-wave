import assert from "node:assert/strict";
import { test } from "node:test";
import { vaultTextPage, searchVaultText } from "./writing-vault-preview.ts";
const bytes = (text: string) => new TextEncoder().encode(text);

test("bounded literal pages preserve every UTF-8 byte including BOM, CRLF and multibyte boundaries in both directions", () => {
  const source = bytes("\ufeff\r\n" + "中文🙂é ".repeat(9000));
  let offset = 0,
    rebuilt = "";
  while (offset < source.length) {
    const page = vaultTextPage(source, offset);
    assert.equal(page.start, offset);
    assert.ok(page.end > page.start);
    assert.ok(page.end - page.start <= 8192);
    assert.deepEqual(bytes(page.text), source.slice(page.start, page.end));
    rebuilt += page.text;
    offset = page.end;
    const previous = vaultTextPage(source, offset, "backward");
    assert.equal(previous.end, offset);
    assert.deepEqual(
      bytes(previous.text),
      source.slice(previous.start, previous.end),
    );
  }
  assert.deepEqual(bytes(rebuilt), source);
  for (let anchor = 0; anchor <= 50; anchor++) {
    const page = vaultTextPage(source, anchor);
    assert.ok(page.start <= anchor);
    assert.deepEqual(bytes(page.text), source.slice(page.start, page.end));
  }
  assert.equal(vaultTextPage(source, source.length).end, source.length);
});

test("invalid offsets, directions, UTF-8 and over-budget buffers never return a partial raw page or secret-bearing diagnostic", () => {
  for (const offset of [-1, 0.5, NaN, Infinity, 10])
    assert.throws(
      () => vaultTextPage(bytes("abc"), offset),
      /来源|变化|有效|文件/,
    );
  assert.throws(() => vaultTextPage(bytes("abc"), 0, "invalid" as "forward"));
  assert.throws(() => vaultTextPage(new Uint8Array([0xf0, 0x9f, 0x8c]), 0));
  assert.throws(() => vaultTextPage(new Uint8Array(16 * 1024 * 1024 + 1), 0));
});

test("raw JSON search is exact UTF-8 literal matching, including overlaps and a match crossing a yield boundary; it builds no plaintext index", async () => {
  const source = bytes("a".repeat(65534) + "中文🙂[a.*]中文🙂[a.*]" + "ababa");
  const signal = new AbortController().signal;
  const result = await searchVaultText(source, "中文🙂[a.*]", 0, signal);
  assert.equal(result.complete, true);
  assert.equal(result.hits.length, 2);
  for (const hit of result.hits)
    assert.equal(
      new TextDecoder().decode(source.slice(hit.start, hit.end)),
      "中文🙂[a.*]",
    );
  assert.equal(
    (await searchVaultText(source, "aba", 0, signal)).hits.length,
    2,
  );
  assert.equal(
    (await searchVaultText(bytes("é"), "é", 0, signal)).hits.length,
    0,
  );
  assert.equal(
    (await searchVaultText(bytes(" A a "), "a", 0, signal)).hits[0]?.start,
    3,
  );
  assert.equal(
    (await searchVaultText(source, "PRIVATE_NOT_PRESENT", 0, signal)).hits
      .length,
    0,
  );
});

test("search bounds work, findings and offsets; cancellation and source mutation during a yield cannot silently change the owned scan", async () => {
  const source = bytes("a".repeat(100000));
  const signal = new AbortController().signal;
  const first = await searchVaultText(source, "aa", 0, signal);
  assert.equal(first.hits.length, 100);
  assert.equal(first.complete, false);
  const second = await searchVaultText(
    source,
    "aa",
    first.hits.at(-1)!.start + 1,
    signal,
  );
  assert.equal(second.hits[0]?.start, 100);
  for (const query of ["", "x".repeat(121), "\ud800"])
    await assert.rejects(searchVaultText(source, query, 0, signal));
  for (const offset of [-1, 0.5, source.length + 1])
    await assert.rejects(searchVaultText(source, "a", offset, signal));
  const abort = new AbortController();
  let yields = 0;
  await assert.rejects(
    searchVaultText(source, "not here", 0, abort.signal, async () => {
      yields++;
      abort.abort();
    }),
    { name: "AbortError" },
  );
  assert.ok(yields > 0);
  const changing = bytes("b".repeat(70000) + "target");
  const snapshot = await searchVaultText(
    changing,
    "target",
    0,
    signal,
    async () => {
      changing.fill(0);
    },
  );
  assert.equal(snapshot.hits[0]?.start, 70000);
});
