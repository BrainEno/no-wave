import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "@babel/parser";
import { alternatePath, localeOf } from "./locale-navigation.ts";
import { notificationPresentation } from "./chrome.ts";

for (const path of ["/authors", "/feed", "/messages", "/messages/thread-17", "/reading-list"]) {
  test(`locale toggle keeps the same registered page in both directions: ${path}`, () => {
    assert.equal(alternatePath(path, "zh-CN"), `/en${path}`);
    assert.equal(alternatePath(`/en${path}`, "en"), path);
  });
}

test("every paired page in the real route table has a deliberate two-way locale contract", () => {
  const source = readFileSync(new URL("../../../../apps/web-rr/app/routes.ts", import.meta.url), "utf8");
  const tree = parse(source, { sourceType: "module", plugins: ["typescript"] });
  const paths = new Map<string, string>();
  function visit(value: unknown): void {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) { value.forEach(visit); return; }
    const n = value as Record<string, unknown>;
    if (n.type === "CallExpression" && n.callee && typeof n.callee === "object" && "name" in n.callee && Array.isArray(n.arguments)) {
      const [path, file] = n.arguments as { type?: string; value?: string }[];
      if (n.callee.name === "route" && path?.type === "StringLiteral" && file?.value?.endsWith(".tsx")) paths.set(path.value!, file.value);
      if (n.callee.name === "index" && path?.value) paths.set("", path.value);
    }
    for (const child of Object.values(n)) visit(child);
  }
  visit(tree.program);
  const pairs = [...paths.keys()].filter(path => path === "en" || path.startsWith("en/"));
  assert.ok(pairs.length >= 12, "the contract must enumerate actual bilingual pages, not an empty list");
  const concrete = (path: string) => "/" + path.replace(":id", "thread-17").replace(":username", "writer-17").replace(":slug", "sample-work");
  for (const english of pairs) {
    const bare = english.replace(/^en\/?/, "");
    assert.equal(paths.get(bare), paths.get(english), english);
    const en = concrete(english), zh = concrete(bare);
    const fallback = bare === "articles/:slug" ? "/articles" : bare === "tags/:slug" ? "/tags" : null;
    assert.equal(alternatePath(zh, "zh-CN"), fallback ? `/en${fallback}` : en, zh);
    assert.equal(alternatePath(en, "en"), fallback ?? zh, en);
  }
});

test("unknown notification destinations stay within the current language's real inbox", () => {
  assert.equal(notificationPresentation({ type: "unknown" }, "en").href, "/en/notifications");
  assert.equal(notificationPresentation({ type: "unknown" }, "zh-CN").href, "/notifications");
});

test("only an exact English path segment selects English", () => {
  for (const path of ["/en", "/en/messages", "/en/authors"]) assert.equal(localeOf(path), "en");
  for (const path of ["/", "/english", "/enough", "/authors/en"]) assert.equal(localeOf(path), "zh-CN");
});

test("switching language keeps each loader's meaningful query state, not credentials or cursors", () => {
  const cases = [
    ["/authors?q=forest&page=3&next=%2Fwrite&token=private", "/en/authors?q=forest&page=3"],
    ["/articles?q=sea&page=2&type=poetry&cursor=private", "/en/articles?q=sea&page=2&type=poetry"],
    ["/authors/writer?page=4&type=essay&q=unused", "/en/authors/writer?page=4&type=essay"],
    ["/categories?q=sea&page=2&type=poetry", "/en/categories?q=sea&page=2"],
    ["/categories/poetry?page=2&q=private", "/en/categories/poetry?page=2"],
    ["/search?q=sea&tab=authors&type=poetry", "/en/search?q=sea&tab=authors&type=poetry"],
    ["/tags?q=sea&page=2", "/en/tags?q=sea&page=2"],
    ["/messages?to=writer-17&cursor=private", "/en/messages?to=writer-17"],
    ["/notifications?view=unread&kind=messages&actorId=private", "/en/notifications?view=unread&kind=messages"],
  ];
  for (const [source, destination] of cases) {
    assert.equal(alternatePath(source!, "zh-CN"), destination);
    assert.equal(alternatePath(destination!, "en"), destination!.replace(/^\/en/, ""));
  }
});

test("ambiguous and invalid filters do not survive the language boundary", () => {
  for (const query of ["page=0", "page=5002", "page=1.5", "page=2&page=3", "q=a&q=b", "q=%00private", "q=%FF", "type=unpublished", "tab=admin"]) {
    assert.equal(alternatePath(`/articles?${query}`, "zh-CN"), "/en/articles");
  }
  assert.equal(alternatePath("/search?q=" + "a".repeat(101), "zh-CN"), "/en/search");
  assert.equal(alternatePath("/messages?to=%20writer-17%20", "zh-CN"), "/en/messages?to=writer-17");
  assert.equal(alternatePath("/notifications?view=all&kind=all", "zh-CN"), "/en/notifications");
});

test("malformed or external addresses and resource routes only get a local home fallback", () => {
  for (const value of ["https://outside.invalid/messages", "//outside.invalid/messages", "/\\outside.invalid", "/en/../messages", "/en/%2e%2e/messages", "/messages/a%2fb", "/messages/a%252fb", "/messages/%00", "/messages/%", "/en//authors", "/api/authoring/session", "/tags/topic/feed.atom", "/en/write", "/english"]) {
    assert.equal(alternatePath(value, "zh-CN"), "/en", value);
  }
});

test("detail translations have explicit directory fallbacks without leaking their parameters", async () => {
  const { localeDestination } = await import("./locale-navigation.ts");
  for (const path of ["/articles/sample-work", "/tags/sample-tag"]) {
    assert.deepEqual(localeDestination(path + "?page=4&token=private#paragraph", "zh-CN"), {
      href: path + (path.startsWith("/tags/") ? "?page=4" : "") + "#paragraph", page: path.startsWith("/articles/") ? "article" : "tag", exact: true,
    });
    assert.equal(localeDestination(path + "?token=private#paragraph", "en").exact, false);
    assert.equal(alternatePath(path + "?token=private#paragraph", "zh-CN"), "/en" + path.split("/").slice(0, 2).join("/"));
  }
});
