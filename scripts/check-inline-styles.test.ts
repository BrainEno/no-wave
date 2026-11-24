import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  MAX_INLINE_STYLES,
  checkRepository,
  checkSource,
  findSources,
} from "./check-inline-styles.ts";

function check(source: string) {
  return checkSource("example.tsx", source);
}

test("no inline styles is a clean report", () => {
  assert.deepEqual(check('<div className="nw-m" />'), {
    occurrences: 0,
    problems: [],
  });
});

test("a justified inline style on the same line passes", () => {
  assert.deepEqual(check("<div style={{ top }} /> // 内联：运行时测量值"), {
    occurrences: 1,
    problems: [],
  });
});

test("a justified inline style on the previous line passes", () => {
  assert.deepEqual(
    check(
      ["// 内联：位置由测量得出", "<div style={{ top, left }} />"].join("\n"),
    ),
    { occurrences: 1, problems: [] },
  );
});

test("an unjustified inline style reports file and line", () => {
  assert.deepEqual(
    check(["<div>", "  <p style={{ marginTop: 24 }} />", "</div>"].join("\n")),
    {
      occurrences: 1,
      problems: [
        {
          path: "example.tsx",
          line: 2,
          reason: "内联 style 缺少原因注释（同行或上一行需有 // 或 /* 注释）",
        },
      ],
    },
  );
});

test("block comments do not count as inline styles", () => {
  assert.deepEqual(
    check('/* <div style={{ marginTop: 24 }} /> */\n<div className="nw-m" />'),
    { occurrences: 0, problems: [] },
  );
});

test("several occurrences on one line are each counted", () => {
  assert.deepEqual(
    check("<a style={{ top }} /><b style={{ left }} /> // 内联：测量值"),
    { occurrences: 2, problems: [] },
  );
});

test("discovery finds nested sources but skips generated and installed trees", () => {
  const root = mkdtempSync(join(tmpdir(), "inline-styles-"));
  try {
    for (const directory of [
      "packages/web-ui/src",
      "packages/web-ui/src/nested",
      "packages/web-ui/node_modules/a",
      "packages/web-ui/build",
      ".git",
    ])
      mkdirSync(join(root, directory), { recursive: true });
    for (const file of [
      "packages/web-ui/src/a.tsx",
      "packages/web-ui/src/nested/b.ts",
      "packages/web-ui/node_modules/a/no.tsx",
      "packages/web-ui/build/no.tsx",
      ".git/no.tsx",
      "packages/web-ui/src/not.css",
    ])
      writeFileSync(join(root, file), '<div className="nw-m" />');
    assert.deepEqual(findSources(join(root, "packages", "web-ui")), [
      join(root, "packages/web-ui/src/a.tsx"),
      join(root, "packages/web-ui/src/nested/b.ts"),
    ]);
    assert.deepEqual(checkRepository(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an empty package is not a successful check", () => {
  const root = mkdtempSync(join(tmpdir(), "inline-empty-"));
  try {
    assert.throws(() => checkRepository(root), /No source files/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the repository stays within the limit with every inline style justified", () => {
  const root = new URL("..", import.meta.url).pathname;
  assert.deepEqual(checkRepository(root), []);
});

test("the limit is the issue's acceptance number", () => {
  assert.equal(MAX_INLINE_STYLES, 15);
});
