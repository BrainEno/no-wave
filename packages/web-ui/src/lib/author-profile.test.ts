import assert from "node:assert/strict";
import test from "node:test";

import { normalizeDisplayName, parseAuthorProfile } from "./author-profile.ts";

/**
 * The writing desk only needs two facts from the profile response: whether a
 * pen name exists at all, and whether the string the author typed is safe to
 * send to the API. Keeping these as pure boundary helpers means the shared UI
 * cannot silently accept an empty name or a malformed upstream answer.
 */

test("parseAuthorProfile accepts the API envelope and rejects anything else", () => {
  assert.deepEqual(
    parseAuthorProfile({ data: { userId: "u1", displayName: "林可行", locale: "zh-CN" } }),
    { displayName: "林可行", locale: "zh-CN" },
  );
  assert.equal(parseAuthorProfile({ data: { displayName: "" } }), null);
  assert.equal(parseAuthorProfile({ data: null }), null);
  assert.equal(parseAuthorProfile({ error: { code: "NOT_FOUND" } }), null);
  assert.equal(parseAuthorProfile(null), null);
  assert.equal(parseAuthorProfile("not an object"), null);
});

test("normalizeDisplayName trims, bounds and rejects empty pen names", () => {
  assert.equal(normalizeDisplayName("  林可行  "), "林可行");
  assert.equal(normalizeDisplayName(""), null);
  assert.equal(normalizeDisplayName("   "), null);
  assert.equal(normalizeDisplayName("x".repeat(121)), null);
  assert.equal(normalizeDisplayName(42), null);
  assert.equal(normalizeDisplayName(null), null);
});
