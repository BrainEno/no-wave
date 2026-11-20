import assert from "node:assert/strict";
import { test } from "node:test";
import { compareVaultReadback } from "./writing-vault-readback.ts";

const bytes = (text: string) => new TextEncoder().encode(text);
const signal = () => new AbortController().signal;
test("readback distinguishes exact identity, truncation, appended bytes and modified data without returning content", async () => {
  const expected = bytes("PRIVATE_PAYLOAD");
  for (const [actual, reason, count] of [
    [expected.slice(), "identical", 0],
    [expected.slice(0, -1), "truncated", 1],
    [bytes("PRIVATE_PAYLOAD "), "appended", 1],
    [bytes("PRIVATE_PAYLOAX"), "modified", 1],
  ] as const) {
    const report = await compareVaultReadback(expected, actual, signal());
    assert.equal(report.reason, reason);
    assert.equal(report.differentBytes, count);
    assert.equal(report.matches, count === 0);
    assert.equal(
      report.firstDifference,
      count === 0
        ? null
        : Math.min(expected.length, actual.length) -
            (reason === "modified" ? 1 : 0),
    );
    assert.doesNotMatch(JSON.stringify(report), /PRIVATE_/);
  }
  assert.deepEqual(expected, bytes("PRIVATE_PAYLOAD"));
});

test("byte comparisons are bounded, cancellable between chunks and immune to caller mutations during yields", async () => {
  const input = new Uint8Array(600000).fill(71),
    actual = input.slice(),
    abort = new AbortController();
  const progress: number[] = [];
  const report = await compareVaultReadback(
    input,
    actual,
    signal(),
    (percent) => progress.push(percent),
    async () => {
      input.fill(99);
      actual.fill(99);
    },
  );
  assert.equal(report.matches, true);
  assert.ok(progress.length > 1);
  assert.equal(progress.at(-1), 100);
  await assert.rejects(
    compareVaultReadback(
      input,
      actual,
      abort.signal,
      () => {},
      async () => {
        abort.abort();
      },
    ),
    { name: "AbortError" },
  );
  await assert.rejects(
    compareVaultReadback(new Uint8Array(0), actual, signal()),
  );
});

test("semantically identical JSON with different spaces is not an exact download, and a name is never a witness", async () => {
  const report = await compareVaultReadback(
    bytes('{"a":1}'),
    bytes('{ "a":1}'),
    signal(),
  );
  assert.equal(report.matches, false);
  assert.equal(report.reason, "modified");
  assert.notEqual(report.expectedDigest, report.actualDigest);
});
