import assert from "node:assert/strict";
import test from "node:test";
import { sanitizeEditorHref } from "./editor-href.ts";

/**
 * Regression for issue #154: the writing desk's old character class was
 * `/[\\u0000-\\u0020\\u007f\\\\]/`. Its unintended `0-\\` range matched ':',
 * digits and uppercase letters, so every ordinary HTTP(S) URL was refused.
 */
test("accepts HTTP(S) URLs, including paths, queries and uppercase characters", () => {
  assert.equal(sanitizeEditorHref("https://example.com"), "https://example.com");
  assert.equal(sanitizeEditorHref("http://example.org/a"), "http://example.org/a");
  assert.equal(sanitizeEditorHref("https://example.com/path?a=1&b=NoWave"), "https://example.com/path?a=1&b=NoWave");
  assert.equal(sanitizeEditorHref("  https://nowave.org/articles/2026  "), "https://nowave.org/articles/2026");
});

test("accepts site-absolute paths that carry digits and uppercase letters", () => {
  assert.equal(sanitizeEditorHref("/articles/2026"), "/articles/2026");
  assert.equal(sanitizeEditorHref("/articles/2026-NoWave"), "/articles/2026-NoWave");
  assert.equal(sanitizeEditorHref("/en/articles/A1"), "/en/articles/A1");
});

test("refuses protocol-relative, opaque-scheme and credential-bearing URLs", () => {
  for (const value of [
    "//evil.example",
    "javascript:alert(1)",
    "data:text/plain,hello",
    "https://user:pass@example.com/a",
    "http://user@example.com",
  ]) {
    assert.equal(sanitizeEditorHref(value), null, `expected ${value} to be refused`);
  }
});

test("refuses control characters, backslashes, whitespace inside the value and empty input", () => {
  for (const value of [
    "",
    "   ",
    "https://example.com/a\u0000b",
    "https://example.com/a\u007fb",
    "https://example.com/a\\b",
    "https://example.com/a b",
    "/articles/2026\u0007",
  ]) {
    assert.equal(sanitizeEditorHref(value), null, `expected ${JSON.stringify(value)} to be refused`);
  }
});
