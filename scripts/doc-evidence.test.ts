import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { marked } from "marked";

/** All versioned Markdown, plus new unignored documents in the current change. */
const root = fileURLToPath(new URL("..", import.meta.url));
export function repositoryMarkdown(): string[] {
  const paths = execFileSync(
    "git",
    [
      "ls-files",
      "-z",
      "--cached",
      "--others",
      "--exclude-standard",
      "--",
      "*.md",
    ],
    { cwd: root, encoding: "utf8" },
  );
  return [
    ...new Set(
      paths
        .split("\0")
        .filter(
          (path) => path.endsWith(".md") && existsSync(resolve(root, path)),
        ),
    ),
  ].sort();
}
const documents = repositoryMarkdown();

/**
 * Check Markdown links and images using the same parser as the Markdown importer.
 * This includes reference-style links, nested parentheses and destinations with
 * spaces. Code examples are tokens rather than links, so they are ignored.
 * External URLs, site routes and same-document anchors are not repository files;
 * fragments on local files are intentionally not interpreted as GitHub slugs.
 */
export function missingLinks(
  document: string,
  content: string,
  exists: (path: string) => boolean,
): string[] {
  const failures: string[] = [];
  const tokens = marked.lexer(content);
  let searchFrom = 0;
  for (const block of tokens) {
    const found = content.indexOf(block.raw, searchFrom);
    const blockStart = found < 0 ? searchFrom : found;
    searchFrom = blockStart + block.raw.length;
    // Synchronous walk: no async marked extensions are registered here.
    void marked.walkTokens([block], (token) => {
      if (token.type !== "link" && token.type !== "image") return;
      const raw = token.href;
      if (/^(?:[a-z][a-z0-9+.-]*:|\/|#)/i.test(raw)) return;
      const insideBlock = block.raw.indexOf(token.raw);
      const line = content
        .slice(0, blockStart + Math.max(insideBlock, 0))
        .split("\n").length;
      let path: string;
      try {
        path = decodeURIComponent(raw.split(/[?#]/, 1)[0]!);
      } catch {
        failures.push(`${document}:${line}: invalid URL encoding: ${raw}`);
        return;
      }
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

/** The only values a `Status:` header may take (docs/README.md). */
export const DOCUMENT_STATUSES = ["active", "done", "archived"] as const;

/**
 * A document's `Status:` value: the whole trimmed remainder of the first
 * status line, or null when it has no status header. The value is not cut at
 * the first word, so prose after the keyword stays visible and fails
 * `isValidDocumentStatus` instead of being silently accepted.
 */
export function documentStatus(content: string): string | null {
  const match = content.match(/^Status:[ \t]*(.*?)[ \t]*$/m);
  return match ? match[1]! : null;
}

export function isValidDocumentStatus(value: string | null): boolean {
  return (
    value !== null && (DOCUMENT_STATUSES as readonly string[]).includes(value)
  );
}

/** One `- [Title](path) — Status: value` line of docs/README.md. */
const INDEX_ENTRY = /^- \[([^\]]+)\]\(([^)\s]+)\) — Status: (.+)$/;

export type IndexEntry = { path: string; status: string; line: number };

/**
 * Parse the documentation index. Every bullet that starts a link must match
 * the entry format; a malformed bullet is reported, not skipped.
 */
export function parseDocumentIndex(index: string): {
  entries: IndexEntry[];
  malformed: number[];
} {
  const entries: IndexEntry[] = [];
  const malformed: number[] = [];
  index.split("\n").forEach((text, offset) => {
    if (!text.startsWith("- [")) return;
    const match = text.match(INDEX_ENTRY);
    if (!match) malformed.push(offset + 1);
    else
      entries.push({
        // Index links are relative to docs/, like the file they describe.
        path: `docs/${match[2]!}`,
        status: match[3]!,
        line: offset + 1,
      });
  });
  return { entries, malformed };
}

/**
 * Consistency between the index and the documents it lists. `headers` maps
 * each non-ADR document to its header status (null when absent).
 */
export function documentIndexProblems(
  index: string,
  headers: ReadonlyMap<string, string | null>,
): string[] {
  const { entries, malformed } = parseDocumentIndex(index);
  const problems = malformed.map(
    (line) => `docs/README.md:${line}: index entry does not match the format`,
  );
  const listed = new Map<string, number>();
  for (const entry of entries) {
    listed.set(entry.path, (listed.get(entry.path) ?? 0) + 1);
    if (!headers.has(entry.path)) {
      problems.push(
        `docs/README.md:${entry.line}: ${entry.path} is not a non-ADR document under docs/`,
      );
      continue;
    }
    if (!isValidDocumentStatus(entry.status))
      problems.push(
        `docs/README.md:${entry.line}: illegal index status "${entry.status}" for ${entry.path}`,
      );
    if (entry.status !== headers.get(entry.path))
      problems.push(
        `docs/README.md:${entry.line}: index status "${entry.status}" differs from the header of ${entry.path}`,
      );
  }
  for (const path of headers.keys()) {
    const count = listed.get(path) ?? 0;
    if (count !== 1)
      problems.push(
        `${path}: listed ${count} times in docs/README.md, expected 1`,
      );
  }
  return problems;
}

/** Non-ADR Markdown under `docs/` that the status-header rule applies to. */
export function statusRuleDocuments(paths: readonly string[]): string[] {
  return paths.filter(
    (path) =>
      path.startsWith("docs/") &&
      !path.startsWith("docs/architecture/decisions/") &&
      path.endsWith(".md"),
  );
}

test("all repository Markdown documents link to existing repository evidence", () => {
  const failures = documents.flatMap((document) =>
    missingLinks(
      document,
      readFileSync(resolve(root, document), "utf8"),
      existsSync,
    ),
  );
  assert.deepEqual(failures, []);
});

test("a missing local evidence path fails with the document and line", () => {
  const failures = missingLinks(
    "docs/example.md",
    "# Example\n[proof](../not-present.ts)\n",
    () => false,
  );
  assert.equal(failures.length, 1);
  assert.match(failures[0]!, /docs\/example\.md:2: missing/);
});

test("existing paths with fragments and titles are checked as files", () => {
  const seen: string[] = [];
  const failures = missingLinks(
    "docs/example.md",
    '[proof](../README.md#intro "title")',
    (path) => {
      seen.push(path);
      return true;
    },
  );
  assert.deepEqual(failures, []);
  assert.deepEqual(seen, [resolve(root, "README.md")]);
});

test("examples and non-file links do not become fake file requirements", () => {
  const text = [
    "[web](https://example.test/path)",
    "[email](mailto:a@example.test)",
    "[heading](#heading)",
    "[route](/articles/example)",
    "```md",
    "[example](missing.md)",
    "```",
    "~~~",
    "[example](also-missing.md)",
    "~~~",
  ].join("\n");
  assert.deepEqual(
    missingLinks("README.md", text, () => false),
    [],
  );
});

test("encoded names are decoded and attempts to escape the repository are refused", () => {
  const seen: string[] = [];
  const failures = missingLinks(
    "README.md",
    "[encoded](docs/a%20b.md)\n[escape](../outside.md)\n[bad](%xx)",
    (path) => {
      seen.push(path);
      return true;
    },
  );
  assert.deepEqual(seen, [resolve(root, "docs/a b.md")]);
  assert.equal(failures.length, 2);
  assert.match(failures[0]!, /outside repository/);
  assert.match(failures[1]!, /invalid URL encoding/);
});

test("reference-style links resolve their definitions and report missing targets", () => {
  const source = [
    "# Guide",
    "Read [the plan][plan] and ![diagram][diagram].",
    "",
    "[plan]: ../missing.md",
    "[diagram]: ../image.png",
  ].join("\n");
  const failures = missingLinks("docs/example.md", source, () => false);
  assert.equal(failures.length, 2);
  assert.match(failures[0]!, /missing\.md/);
  assert.match(failures[1]!, /image\.png/);
});

test("inline code and indented code examples do not create evidence requirements", () => {
  const source = [
    "`[not a link](missing.md)`",
    "",
    "    [not a link](also-missing.md)",
  ].join("\n");
  assert.deepEqual(
    missingLinks("README.md", source, () => false),
    [],
  );
});

test("links with balanced parentheses and angle-bracket destinations are checked", () => {
  const source = "[first](docs/file%20(one).md)\n[second](<docs/a b.md>)";
  const seen: string[] = [];
  assert.deepEqual(
    missingLinks("README.md", source, (path) => {
      seen.push(path);
      return true;
    }),
    [],
  );
  assert.deepEqual(seen, [
    resolve(root, "docs/file (one).md"),
    resolve(root, "docs/a b.md"),
  ]);
});

test("a local image destination is treated as evidence just like a link", () => {
  const failures = missingLinks(
    "README.md",
    "![diagram](docs/missing.png)",
    () => false,
  );
  assert.equal(failures.length, 1);
  assert.match(failures[0]!, /missing\.png/);
});

test("reference definitions can appear after the use and may be shared", () => {
  const source =
    '[one][proof] and [two][proof]\n\n[proof]: docs/evidence.md "Evidence"\n';
  const seen: string[] = [];
  const failures = missingLinks("README.md", source, (path) => {
    seen.push(path);
    return true;
  });
  assert.deepEqual(failures, []);
  assert.deepEqual(seen, [
    resolve(root, "docs/evidence.md"),
    resolve(root, "docs/evidence.md"),
  ]);
});

test("only local path portions of destinations are resolved", () => {
  const seen: string[] = [];
  const source =
    "[a](guide.md?format=full#heading)\n[b](guide.md#heading)\n[c](#local)";
  assert.deepEqual(
    missingLinks("docs/README.md", source, (path) => {
      seen.push(path);
      return true;
    }),
    [],
  );
  assert.deepEqual(seen, [
    resolve(root, "docs/guide.md"),
    resolve(root, "docs/guide.md"),
  ]);
});

test("reference links cannot bypass repository boundary checks", () => {
  const source = "[escape][ref]\n\n[ref]: ../outside.md";
  const failures = missingLinks("README.md", source, () => true);
  assert.equal(failures.length, 1);
  assert.match(failures[0]!, /outside repository/);
});

test("links nested in lists, blockquotes and table cells are checked", () => {
  const source = [
    "- [list](list.md)",
    "",
    "> [quote](quote.md)",
    "",
    "| Link |",
    "| --- |",
    "| [table](table.md) |",
  ].join("\n");
  const seen: string[] = [];
  const failures = missingLinks("README.md", source, (path) => {
    seen.push(path);
    return false;
  });
  assert.equal(failures.length, 3);
  assert.deepEqual(
    seen,
    ["list.md", "quote.md", "table.md"].map((file) => resolve(root, file)),
  );
});

test("external schemes and root-relative URLs are not treated as local files", () => {
  const source = [
    "[web](https://example.test/a)",
    "[mail](mailto:a@example.test)",
    "[protocol](//cdn.example.test/a)",
    "[route](/articles/a)",
  ].join("\n\n");
  assert.deepEqual(
    missingLinks("README.md", source, () => {
      throw new Error("unexpected file check");
    }),
    [],
  );
});

test("Markdown line diagnostics account for multiline blocks", () => {
  const source = "# A\n\nFirst line\n[bad](missing.md)\n\nFinal paragraph.";
  const failures = missingLinks("README.md", source, () => false);
  assert.equal(failures.length, 1);
  assert.match(failures[0]!, /^README\.md:4: missing missing\.md$/);
});

test("the migration guidance distinguishes currently implemented and open gates", () => {
  const roadmap = readFileSync(
    resolve(root, "docs/roadmap/phase-gates.md"),
    "utf8",
  );
  assert.match(
    roadmap,
    /\[x\] Migrate auth, writing, comment and media route handlers/,
  );
  assert.match(
    roadmap,
    /\[x\] Implement the article editor and image-upload integration/,
  );
  assert.match(roadmap, /\[ \] Complete durable recovery of unsaved drafts/);
  assert.match(roadmap, /\[ \] Complete the core feature parity journey/);
});

test("the documented metrics default agrees with the operational guidance", () => {
  const readme = readFileSync(resolve(root, "README.md"), "utf8");
  const operations = readFileSync(
    resolve(root, "docs/operations/api-observability.md"),
    "utf8",
  );
  assert.match(readme, /API_METRICS_ENABLED=true/);
  assert.match(readme, /endpoint returns 404 by default/);
  assert.match(operations, /disabled by default and returns 404/);
});

test("historical design names cannot be mistaken for current routes", () => {
  const design = readFileSync(
    resolve(root, "packages/web-ui/docs/UI_DESIGN_SYSTEM.md"),
    "utf8",
  );
  assert.match(design, /历史设计稿名称，不是当前产品路由/);
  assert.match(design, /不表示存在 `\/submit` 路由或已实现审核/);
  assert.match(design, /`\/articles\/:slug`、`\/write`、`\/messages`/);
});

test("fenced code blocks with language hints never produce false missing links", () => {
  const source = [
    "```markdown",
    "[inline](not-a-file.md)",
    "[ref][example]",
    "[example]: absent.md",
    "```",
    "",
    "[real](real.md)",
  ].join("\n");
  const visited: string[] = [];
  const failures = missingLinks("README.md", source, (path) => {
    visited.push(path);
    return true;
  });
  assert.deepEqual(failures, []);
  assert.deepEqual(visited, [resolve(root, "real.md")]);
});

test("a missing license link is rejected by the same evidence checker", () => {
  const readme = readFileSync(resolve(root, "README.md"), "utf8");
  const failures = missingLinks(
    "README.md",
    readme,
    (path) => path !== resolve(root, "LICENSE"),
  );
  assert.equal(
    failures.filter((failure) => failure.includes("missing LICENSE")).length,
    1,
  );
});

test("a bad link in a previously unlisted document fails the full-repository check", () => {
  const document = "apps/api/README.md";
  assert.ok(documents.includes(document));
  const source =
    readFileSync(resolve(root, document), "utf8") +
    "\n[intentional regression](not-present-regression.md)\n";
  const failures = missingLinks(document, source, existsSync);
  assert.ok(
    failures.some(
      (failure) =>
        failure.includes(`${document}:`) &&
        failure.includes("not-present-regression.md"),
    ),
  );
  assert.ok(
    documents.includes("AGENTS.md") &&
      documents.includes(
        "docs/architecture/decisions/0014-password-recovery-and-email-verification.md",
      ),
  );
});

test("every non-ADR document under docs/ declares a Status header", () => {
  const failures = statusRuleDocuments(documents).filter(
    (document) =>
      documentStatus(readFileSync(resolve(root, document), "utf8")) === null,
  );
  assert.deepEqual(failures, []);
});

test("no roadmap document is marked done", () => {
  const failures = documents
    .filter(
      (document) =>
        document.startsWith("docs/roadmap/") && document.endsWith(".md"),
    )
    .filter(
      (document) =>
        documentStatus(readFileSync(resolve(root, document), "utf8")) ===
        "done",
    );
  assert.deepEqual(failures, []);
});

test("every non-ADR document under docs/ declares an exact legal status", () => {
  const failures = statusRuleDocuments(documents).flatMap((document) => {
    const status = documentStatus(
      readFileSync(resolve(root, document), "utf8"),
    );
    return isValidDocumentStatus(status)
      ? []
      : [`${document}: illegal Status "${status}"`];
  });
  assert.deepEqual(failures, []);
});

test("the documentation index agrees with every document it lists", () => {
  // The index describes the other documents; it does not list itself.
  const headers = new Map(
    statusRuleDocuments(documents)
      .filter((document) => document !== "docs/README.md")
      .map((document) => [
        document,
        documentStatus(readFileSync(resolve(root, document), "utf8")),
      ]),
  );
  const index = readFileSync(resolve(root, "docs/README.md"), "utf8");
  assert.deepEqual(documentIndexProblems(index, headers), []);
});

test("the index checker rejects illegal, mismatched, missing and duplicated entries", () => {
  const headers = new Map<string, string | null>([
    ["docs/a.md", "active"],
    ["docs/b.md", "archived"],
    ["docs/c.md", "done"],
  ]);
  const index = [
    "- [A](a.md) — Status: active",
    "- [B](b.md) — Status: **archived**",
    "- [B again](b.md) — Status: archived",
    "- [C](c.md) — Status: active",
    "- [Ghost](ghost.md) — Status: active",
    "- [Broken] — Status: active",
  ].join("\n");
  const problems = documentIndexProblems(index, headers);
  assert.ok(
    problems.some((p) =>
      p.includes('illegal index status "**archived**" for docs/b.md'),
    ),
  );
  assert.ok(
    problems.some((p) =>
      p.includes(
        'docs/README.md:4: index status "active" differs from the header of docs/c.md',
      ),
    ),
  );
  assert.ok(
    problems.some((p) => p.includes("docs/ghost.md is not a non-ADR document")),
  );
  assert.ok(
    problems.some((p) =>
      p.includes("docs/README.md:6: index entry does not match the format"),
    ),
  );
  assert.ok(
    problems.some(
      (p) => p === "docs/b.md: listed 2 times in docs/README.md, expected 1",
    ),
  );
  assert.equal(
    problems.some((p) => p.startsWith("docs/c.md: listed")),
    false,
  );
});

test("the status vocabulary rejects the values that were once in use", () => {
  for (const value of [
    "foundation",
    "Minimal",
    "Initial",
    "**foundation",
    "active.",
    "Active",
    "",
  ]) {
    assert.equal(isValidDocumentStatus(value), false, value);
  }
  for (const value of DOCUMENT_STATUSES) {
    assert.equal(isValidDocumentStatus(value), true, value);
  }
  assert.equal(isValidDocumentStatus(null), false);
});

test("prose after the status keyword is not a legal status", () => {
  assert.equal(
    isValidDocumentStatus(
      documentStatus("# T\n\nStatus: active. Extra prose\n"),
    ),
    false,
  );
  assert.equal(
    isValidDocumentStatus(
      documentStatus("# T\n\nStatus: **foundation only**\n"),
    ),
    false,
  );
  assert.equal(documentStatus("# T\n\nStatus: archived   \n"), "archived");
});

test("the status header helper reads the first Status line", () => {
  assert.equal(documentStatus("# Title\n\nStatus: active\n"), "active");
  assert.equal(documentStatus("# Title\n\nStatus: archived\n"), "archived");
  assert.equal(documentStatus("# Title\n\nno header here\n"), null);
});

test("the status rule covers docs/ but not the ADR directory", () => {
  assert.ok(
    statusRuleDocuments(documents).includes("docs/roadmap/phase-gates.md"),
  );
  assert.ok(
    !statusRuleDocuments(documents).some((d) =>
      d.startsWith("docs/architecture/decisions/"),
    ),
  );
});
