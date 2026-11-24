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
  justifies,
} from "./check-inline-styles.ts";

function check(source: string, path = "example.tsx") {
  return checkSource(path, source);
}

const MISSING = "内联 style 缺少原因注释（同行或上一行需有 // 或 /* 注释）";
const VAGUE =
  "内联 style 的注释没有写明运行时依据（需说明测量或动态数据等无法用 CSS 表达的原因）";

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

test("a justified JSX comment on the previous line passes", () => {
  assert.deepEqual(
    check(
      [
        "const view = (",
        "  <>",
        "    {/* 内联：选区位置由运行时测量得出 */}",
        "    <div style={{ top }} />",
        "  </>",
        ")",
      ].join("\n"),
    ),
    { occurrences: 1, problems: [] },
  );
});

test("a justified multi-line block comment ending on the previous line passes", () => {
  assert.deepEqual(
    check(
      [
        "/*",
        " * 内联：拖拽位置由运行时的指针坐标计算",
        " */",
        "<div style={{ top }} />",
      ].join("\n"),
    ),
    { occurrences: 1, problems: [] },
  );
});

test("an unjustified inline style reports file and line", () => {
  assert.deepEqual(
    check(["<div>", "  <p style={{ marginTop: 24 }} />", "</div>"].join("\n")),
    {
      occurrences: 1,
      problems: [{ path: "example.tsx", line: 2, reason: MISSING }],
    },
  );
});

test("a comment two lines above does not justify the style", () => {
  assert.deepEqual(
    check(["// 内联：运行时测量值", "", "<div style={{ top }} />"].join("\n")),
    {
      occurrences: 1,
      problems: [{ path: "example.tsx", line: 3, reason: MISSING }],
    },
  );
});

test("a comment on the line below does not justify the style", () => {
  assert.deepEqual(
    check(["<div style={{ top }} />", "// 内联：运行时测量值"].join("\n")),
    {
      occurrences: 1,
      problems: [{ path: "example.tsx", line: 1, reason: MISSING }],
    },
  );
});

test("a URL in an attribute is not a comment", () => {
  assert.deepEqual(check('<a href="https://example.com" style={{ top }} />'), {
    occurrences: 1,
    problems: [{ path: "example.tsx", line: 1, reason: MISSING }],
  });
});

test("a URL on the previous line does not justify the style", () => {
  assert.deepEqual(
    check(
      [
        'const url = "https://example.com/运行时测量";',
        "<div style={{ top }} />",
      ].join("\n"),
    ),
    {
      occurrences: 1,
      problems: [{ path: "example.tsx", line: 2, reason: MISSING }],
    },
  );
});

test("comment markers inside string and template literals are not comments", () => {
  assert.deepEqual(
    check(
      [
        'const a = "/* 内联：运行时测量值 */";',
        "const b = `// 内联：运行时测量值`;",
        "<div style={{ top }} />",
      ].join("\n"),
    ),
    {
      occurrences: 1,
      problems: [{ path: "example.tsx", line: 3, reason: MISSING }],
    },
  );
});

test("style text inside a string or a block comment is not an inline style", () => {
  assert.deepEqual(
    check(
      [
        'const doc = "<div style={{ marginTop: 24 }} />";',
        "/* <div style={{ marginTop: 24 }} /> */",
        '<div className="nw-m" />',
      ].join("\n"),
    ),
    { occurrences: 0, problems: [] },
  );
});

test("an empty comment does not justify the style", () => {
  assert.deepEqual(check(["//", "<div style={{ top }} />"].join("\n")), {
    occurrences: 1,
    problems: [{ path: "example.tsx", line: 2, reason: VAGUE }],
  });
  assert.deepEqual(check(["/* */", "<div style={{ top }} />"].join("\n")), {
    occurrences: 1,
    problems: [{ path: "example.tsx", line: 2, reason: VAGUE }],
  });
});

test("TODO and placeholder comments do not justify the style", () => {
  assert.deepEqual(check("<div style={{ top }} /> // TODO: 运行时测量值"), {
    occurrences: 1,
    problems: [{ path: "example.tsx", line: 1, reason: VAGUE }],
  });
  assert.equal(justifies("TODO 运行时测量值"), false);
  assert.equal(justifies("FIXME 之后再处理动态布局"), false);
});

test("a meaningless or generic comment does not justify the style", () => {
  for (const text of [
    "内联",
    "inline style",
    "内联样式",
    "需要内联样式",
    "样式需要",
    "style",
    "必要",
  ]) {
    assert.equal(justifies(text), false, text);
    assert.deepEqual(
      check(`// ${text}\n<div style={{ top }} />`).problems,
      [{ path: "example.tsx", line: 2, reason: VAGUE }],
      text,
    );
  }
});

test("a reason without a runtime cause does not justify the style", () => {
  assert.equal(justifies("内联：间距是 24 像素"), false);
  assert.equal(justifies("内联：设计稿这样要求的边距"), false);
});

test("a runtime reason justifies the style", () => {
  assert.equal(justifies("内联：工具条位置由运行时对选区的测量得出"), true);
  assert.equal(
    justifies("inline: position measured at runtime from the selection"),
    true,
  );
});

test("a double slash inside JSX children is visible text, not a comment", () => {
  assert.deepEqual(
    check("<p>// 内联：运行时测量得出的位置<b style={{ top }} /></p>"),
    {
      occurrences: 1,
      problems: [{ path: "example.tsx", line: 1, reason: MISSING }],
    },
  );
});

test("several occurrences on one line are each counted", () => {
  assert.deepEqual(
    check(
      [
        "<>",
        "{/* 内联：运行时测量得出的位置 */}",
        "<a style={{ top }} /><b style={{ left }} />",
        "</>",
      ].join("\n"),
    ),
    { occurrences: 2, problems: [] },
  );
});

test("a dynamic style object reference is also an inline style", () => {
  assert.deepEqual(check("<div style={layout} />"), {
    occurrences: 1,
    problems: [{ path: "example.tsx", line: 1, reason: MISSING }],
  });
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
      writeFileSync(join(root, file), 'export const x = "<div />";\n');
    assert.deepEqual(findSources(join(root, "packages", "web-ui")), [
      join(root, "packages/web-ui/src/a.tsx"),
      join(root, "packages/web-ui/src/nested/b.ts"),
    ]);
    assert.deepEqual(checkRepository(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an unparseable source fails the check instead of passing it", () => {
  assert.throws(() => check("<div style={{ top }"));
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
