import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { marked } from "marked";

/** The four audited documents: relative Markdown links are executable evidence. */
const root = fileURLToPath(new URL("..", import.meta.url));
const documents = [
  "README.md",
  "docs/audit/feature-traceability.md",
  "docs/audit/2026-11-roadmap-evidence.md",
  "docs/roadmap/phase-gates.md",
  "packages/web-ui/docs/UI_DESIGN_SYSTEM.md",
];

/**
 * Check Markdown links and images using the same parser as the Markdown importer.
 * This includes reference-style links, nested parentheses and destinations with
 * spaces. Code examples are tokens rather than links, so they are ignored.
 * External URLs, site routes and same-document anchors are not repository files;
 * fragments on local files are intentionally not interpreted as GitHub slugs.
 */
export function missingLinks(document: string, content: string, exists: (path: string) => boolean): string[] {
  const failures: string[] = [];
  const tokens = marked.lexer(content);
  let searchFrom = 0;
  for (const block of tokens) {
    const found = content.indexOf(block.raw, searchFrom);
    const blockStart = found < 0 ? searchFrom : found;
    searchFrom = blockStart + block.raw.length;
    marked.walkTokens([block], (token) => {
      if (token.type !== "link" && token.type !== "image") return;
      const raw = token.href;
      if (/^(?:[a-z][a-z0-9+.-]*:|\/|#)/i.test(raw)) return;
      const insideBlock = block.raw.indexOf(token.raw);
      const line = content.slice(0, blockStart + Math.max(insideBlock, 0)).split("\n").length;
      let path: string;
      try { path = decodeURIComponent(raw.split(/[?#]/, 1)[0]!); }
      catch { failures.push(`${document}:${line}: invalid URL encoding: ${raw}`); return; }
      if (!path) return;
      const target = resolve(root, dirname(document), path);
      const rel = relative(root, target);
      if (rel === ".." || rel.startsWith("../") || isAbsolute(rel)) {
        failures.push(`${document}:${line}: outside repository: ${raw}`);
      } else if (!exists(target)) {
        failures.push(`${document}:${line}: missing ${raw}`);
      }
    });
  }
  return failures;
}

test("the audited documents link to existing repository evidence", () => {
  const failures = documents.flatMap((document) => missingLinks(document, readFileSync(resolve(root, document), "utf8"), existsSync));
  assert.deepEqual(failures, []);
});

test("a missing local evidence path fails with the document and line", () => {
  const failures = missingLinks("docs/example.md", "# Example\n[proof](../not-present.ts)\n", () => false);
  assert.equal(failures.length, 1);
  assert.match(failures[0]!, /docs\/example\.md:2: missing/);
});

test("existing paths with fragments and titles are checked as files", () => {
  const seen: string[] = [];
  const failures = missingLinks("docs/example.md", '[proof](../README.md#intro "title")', (path) => { seen.push(path); return true; });
  assert.deepEqual(failures, []);
  assert.deepEqual(seen, [resolve(root, "README.md")]);
});

test("examples and non-file links do not become fake file requirements", () => {
  const text = [
    "[web](https://example.test/path)", "[email](mailto:a@example.test)", "[heading](#heading)", "[route](/articles/example)",
    "```md", "[example](missing.md)", "```", "~~~", "[example](also-missing.md)", "~~~",
  ].join("\n");
  assert.deepEqual(missingLinks("README.md", text, () => false), []);
});

test("encoded names are decoded and attempts to escape the repository are refused", () => {
  const seen: string[] = [];
  const failures = missingLinks("README.md", "[encoded](docs/a%20b.md)\n[escape](../outside.md)\n[bad](%xx)", (path) => { seen.push(path); return true; });
  assert.deepEqual(seen, [resolve(root, "docs/a b.md")]);
  assert.equal(failures.length, 2);
  assert.match(failures[0]!, /outside repository/);
  assert.match(failures[1]!, /invalid URL encoding/);
});

test("reference-style links resolve their definitions and report missing targets", () => {
  const source = ["# Guide", "Read [the plan][plan] and ![diagram][diagram].", "", "[plan]: ../missing.md", "[diagram]: ../image.png"].join("\n");
  const failures = missingLinks("docs/example.md", source, () => false);
  assert.equal(failures.length, 2);
  assert.match(failures[0]!, /missing\.md/);
  assert.match(failures[1]!, /image\.png/);
});

test("inline code and indented code examples do not create evidence requirements", () => {
  const source = ["`[not a link](missing.md)`", "", "    [not a link](also-missing.md)"].join("\n");
  assert.deepEqual(missingLinks("README.md", source, () => false), []);
});

test("links with balanced parentheses and angle-bracket destinations are checked", () => {
  const source = "[first](docs/file%20(one).md)\n[second](<docs/a b.md>)";
  const seen: string[] = [];
  assert.deepEqual(missingLinks("README.md", source, (path) => { seen.push(path); return true; }), []);
  assert.deepEqual(seen, [resolve(root, "docs/file (one).md"), resolve(root, "docs/a b.md")]);
});

test("a local image destination is treated as evidence just like a link", () => {
  const failures = missingLinks("README.md", "![diagram](docs/missing.png)", () => false);
  assert.equal(failures.length, 1);
  assert.match(failures[0]!, /missing\.png/);
});

test("reference definitions can appear after the use and may be shared", () => {
  const source = "[one][proof] and [two][proof]\n\n[proof]: docs/evidence.md \"Evidence\"\n";
  const seen: string[] = [];
  const failures = missingLinks("README.md", source, (path) => { seen.push(path); return true; });
  assert.deepEqual(failures, []);
  assert.deepEqual(seen, [resolve(root, "docs/evidence.md"), resolve(root, "docs/evidence.md")]);
});

test("only local path portions of destinations are resolved", () => {
  const seen: string[] = [];
  const source = "[a](guide.md?format=full#heading)\n[b](guide.md#heading)\n[c](#local)";
  assert.deepEqual(missingLinks("docs/README.md", source, (path) => { seen.push(path); return true; }), []);
  assert.deepEqual(seen, [resolve(root, "docs/guide.md"), resolve(root, "docs/guide.md")]);
});

test("reference links cannot bypass repository boundary checks", () => {
  const source = "[escape][ref]\n\n[ref]: ../outside.md";
  const failures = missingLinks("README.md", source, () => true);
  assert.equal(failures.length, 1);
  assert.match(failures[0]!, /outside repository/);
});

test("links nested in lists, blockquotes and table cells are checked", () => {
  const source = ["- [list](list.md)", "", "> [quote](quote.md)", "", "| Link |", "| --- |", "| [table](table.md) |"].join("\n");
  const seen: string[] = [];
  const failures = missingLinks("README.md", source, (path) => { seen.push(path); return false; });
  assert.equal(failures.length, 3);
  assert.deepEqual(seen, ["list.md", "quote.md", "table.md"].map((file) => resolve(root, file)));
});

test("external schemes and root-relative URLs are not treated as local files", () => {
  const source = ["[web](https://example.test/a)", "[mail](mailto:a@example.test)", "[protocol](//cdn.example.test/a)", "[route](/articles/a)"].join("\n\n");
  assert.deepEqual(missingLinks("README.md", source, () => { throw new Error("unexpected file check"); }), []);
});

test("Markdown line diagnostics account for multiline blocks", () => {
  const source = "# A\n\nFirst line\n[bad](missing.md)\n\nFinal paragraph.";
  const failures = missingLinks("README.md", source, () => false);
  assert.equal(failures.length, 1);
  assert.match(failures[0]!, /^README\.md:4: missing missing\.md$/);
});

test("the migration guidance distinguishes currently implemented and open gates", () => {
  const roadmap = readFileSync(resolve(root, "docs/roadmap/phase-gates.md"), "utf8");
  assert.match(roadmap, /\[x\] Migrate auth, writing, comment and media route handlers/);
  assert.match(roadmap, /\[x\] Implement the article editor and image-upload integration/);
  assert.match(roadmap, /\[ \] Complete durable recovery of unsaved drafts/);
  assert.match(roadmap, /\[ \] Complete the core feature parity journey/);
});

test("the documented metrics default agrees with the operational guidance", () => {
  const readme = readFileSync(resolve(root, "README.md"), "utf8");
  const operations = readFileSync(resolve(root, "docs/operations/api-observability.md"), "utf8");
  assert.match(readme, /API_METRICS_ENABLED=true/);
  assert.match(readme, /endpoint returns 404 by default/);
  assert.match(operations, /disabled by default and returns 404/);
});

test("historical design names cannot be mistaken for current routes", () => {
  const design = readFileSync(resolve(root, "packages/web-ui/docs/UI_DESIGN_SYSTEM.md"), "utf8");
  assert.match(design, /历史设计稿名称，不是当前产品路由/);
  assert.match(design, /不表示存在 `\/submit` 路由或已实现审核/);
  assert.match(design, /`\/articles\/:slug`、`\/write`、`\/messages`/);
});
