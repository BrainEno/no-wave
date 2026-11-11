import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

/** The four audited documents: relative Markdown links are executable evidence. */
const root = fileURLToPath(new URL("..", import.meta.url));
const documents = [
  "README.md",
  "docs/audit/feature-traceability.md",
  "docs/roadmap/phase-gates.md",
  "packages/web-ui/docs/UI_DESIGN_SYSTEM.md",
];

/**
 * Check local Markdown link destinations, not examples inside fenced code.
 * External URLs, route paths and same-document fragments are not repository
 * files. Fragments on local files are ignored here: validating heading slugs is a
 * separate concern and cannot be inferred from GitHub's renderer safely.
 */
export function missingLinks(document: string, content: string, exists: (path: string) => boolean): string[] {
  const failures: string[] = [];
  let fence: string | null = null;
  for (const [index, line] of content.split("\n").entries()) {
    const delimiter = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (delimiter) {
      if (!fence) fence = delimiter[0]!;
      else if (fence === delimiter[0]) fence = null;
      continue;
    }
    if (fence) continue;
    for (const match of line.matchAll(/!?\[[^\]]*\]\(([^\s)]+)(?:\s+"[^"]*")?\)/g)) {
      const raw = match[1]!;
      if (/^(?:[a-z][a-z0-9+.-]*:|\/|#)/i.test(raw)) continue;
      let path: string;
      try { path = decodeURIComponent(raw.split(/[?#]/, 1)[0]!); }
      catch { failures.push(`${document}:${index + 1}: invalid URL encoding: ${raw}`); continue; }
      if (!path) continue;
      const target = resolve(root, dirname(document), path);
      const rel = relative(root, target);
      if (rel === ".." || rel.startsWith("../") || isAbsolute(rel)) {
        failures.push(`${document}:${index + 1}: outside repository: ${raw}`);
      } else if (!exists(target)) {
        failures.push(`${document}:${index + 1}: missing ${raw}`);
      }
    }
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
