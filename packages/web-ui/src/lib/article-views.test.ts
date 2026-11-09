import assert from "node:assert/strict";
import test from "node:test";

import { articleViewBeaconPath, createViewBeacon } from "./article-views.ts";

/**
 * The reading page's view beacon (ADR 0035).
 *
 * A counter is only as honest as the client that feeds it: a beacon sent twice
 * per mount inflates every page view, and one that throws on a failed request
 * turns telemetry into an error the reader sees. Both are asserted here, without
 * a browser.
 */
test("the beacon posts to the proxy path with the work and the edition", () => {
  assert.equal(articleViewBeaconPath("portable-web-foundation", "zh-CN"), "/api/articles/portable-web-foundation/views?locale=zh-CN");
  // The slug is encoded, so a malformed one cannot escape the route segment.
  assert.equal(articleViewBeaconPath("a b", "en"), "/api/articles/a%20b/views?locale=en");
});

test("one page load sends one beacon per work and edition", async () => {
  const calls: Array<{ input: string; init: RequestInit | undefined }> = [];
  const beacon = createViewBeacon(async (input, init) => {
    calls.push({ input, init });
    return { ok: true };
  });

  await beacon("a-work", "zh-CN");
  await beacon("a-work", "zh-CN");
  assert.equal(calls.length, 1, "a second mount in the same page load is the same read");

  // Another edition of the same work is another page, and another work certainly is.
  await beacon("a-work", "en");
  await beacon("another-work", "zh-CN");
  assert.equal(calls.length, 3);

  const [first] = calls;
  assert.ok(first);
  assert.equal(first.init?.method, "POST", "a view is a write, never a GET");
  assert.equal(first.init?.body, undefined, "there is no body to send");
  assert.equal(first.init?.credentials, "same-origin", "the session rides along so the API can key the reader");
});

test("a failed beacon is silent and is not retried", async () => {
  const calls: string[] = [];
  const beacon = createViewBeacon(async (input) => {
    calls.push(input);
    throw new Error("the proxy is down");
  });
  // No rejection escapes: the page has already rendered, and telemetry is not an
  // error the reader should ever meet.
  await beacon("a-work", "zh-CN");
  await beacon("a-work", "zh-CN");
  assert.equal(calls.length, 1, "the attempt is remembered even when it failed");
});
