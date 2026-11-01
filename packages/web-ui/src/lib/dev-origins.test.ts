import assert from "node:assert/strict";
import test from "node:test";
import { parseAllowedDevOrigins } from "./dev-origins.ts";

// Next.js blocks development assets for hostnames it does not trust. A silent
// empty list means the page loads without CSS or hydration when it is opened
// from another device, so the parser is pinned here.

test("WEB_DEV_ALLOWED_ORIGINS accepts host patterns and full origins", () => {
  assert.deepEqual(parseAllowedDevOrigins(undefined), []);
  assert.deepEqual(parseAllowedDevOrigins(""), []);
  assert.deepEqual(parseAllowedDevOrigins("   "), []);
  assert.deepEqual(parseAllowedDevOrigins("192.168.1.10:3000"), ["192.168.1.10:3000"]);
  assert.deepEqual(parseAllowedDevOrigins("http://192.168.1.10:3000/"), ["192.168.1.10:3000"]);
  assert.deepEqual(parseAllowedDevOrigins("*.preview.example"), ["*.preview.example"]);
  assert.deepEqual(parseAllowedDevOrigins("[::1]:3000"), ["[::1]:3000"]);
});

test("entries are trimmed, lowercased and de-duplicated", () => {
  assert.deepEqual(
    parseAllowedDevOrigins(" LocalHost:3000 , http://localhost:3000 ,dev.example "),
    ["localhost:3000", "dev.example"],
  );
});

test("malformed entries are dropped instead of breaking the config", () => {
  assert.deepEqual(parseAllowedDevOrigins("ftp://dev.example, ,http://,not a host"), []);
  assert.deepEqual(parseAllowedDevOrigins("good.example,%%%"), ["good.example"]);
});
