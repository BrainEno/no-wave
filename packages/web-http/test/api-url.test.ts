import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { apiUrl } from "../src/api.ts";

test("API URL joining preserves nested bases, empty paths, queries and fragments while tolerating edge slashes", () => {
  for (const [base, path, expected] of [
    ["https://api.example.test", "api/v1/me", "https://api.example.test/api/v1/me"],
    ["https://api.example.test/root///", "///api/v1/me?locale=zh-TW#details", "https://api.example.test/root/api/v1/me?locale=zh-TW#details"],
    ["https://api.example.test/root", "", "https://api.example.test/root/"],
    ["https://api.example.test/root//nested/", "/api/v1/me", "https://api.example.test/root//nested/api/v1/me"],
  ]) assert.equal(apiUrl(base!, path!), expected);
});

test("slash-heavy library input is joined in bounded time rather than blocking the Web event loop with suffix backtracking", () => {
  // The subprocess enforces a wall-clock bound even for the vulnerable regex;
  // it cannot pin the root test runner or run past a failed assertion.
  const module = new URL("../src/api.ts", import.meta.url).href;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import assert from "node:assert/strict";
    import { apiUrl } from ${JSON.stringify(module)};
    const slashes = "/".repeat(500_000);
    const base = "https://api.example.test/" + slashes + "tail";
    assert.equal(apiUrl(base, "///api/v1/me"), base + "/api/v1/me");
    assert.equal(apiUrl("https://api.example.test" + slashes, slashes + "api/v1/me"), "https://api.example.test/api/v1/me");
  `], { timeout: 3000, encoding: "utf8" });
  assert.equal(result.error, undefined, "URL joining must complete before the subprocess deadline");
  assert.equal(result.status, 0, result.stderr);
});
