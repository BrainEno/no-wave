import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  CJK_PATTERN,
  MAX_INLINE_COPY_LINES,
  checkRepository,
  checkSource,
  findComponentSources,
  inlineCopyProblems,
} from "./check-inline-copy.ts";

function count(source: string) {
  return checkSource("example.tsx", source);
}

const hanOf = (...points: number[]) => String.fromCodePoint(...points);

test("a file without CJK counts zero", () => {
  assert.equal(
    count('const label = "Sign in";\n<div className="nw-btn" />'),
    0,
  );
});

test("a line with a CJK literal counts once", () => {
  assert.equal(count("<p>保存成功</p>"), 1);
});

test("comment-only lines are skipped", () => {
  assert.equal(
    count(
      [
        "// 保存成功的提示",
        " * 也是注释",
        "/* 块注释里的中文 */",
        "<p>正文</p>",
      ].join("\n"),
    ),
    1,
  );
});

test("block comments do not count as inline copy", () => {
  assert.equal(count("/* <p>注释里的中文</p> */\n<p>正文</p>"), 1);
});

test("simplified and traditional Chinese both count as Han", () => {
  assert.equal(count("<p>保存成功</p>"), 1);
  assert.equal(count("<p>儲存成功</p>"), 1);
  assert.equal(count("<p>發佈作品</p>"), 1);
});

test("CJK extension A, extension B and compatibility ideographs count as Han", () => {
  // U+3400 (ext A), U+20000 (ext B, outside the BMP), U+F900 and U+2F800
  // (compatibility ideographs, the latter outside the BMP).
  for (const point of [0x3400, 0x20000, 0x2a6df, 0xf900, 0x2f800]) {
    assert.equal(
      CJK_PATTERN.test(hanOf(point)),
      true,
      `U+${point.toString(16)}`,
    );
    assert.equal(count(`<p>${hanOf(point)}</p>`), 1, `U+${point.toString(16)}`);
  }
});

test("kana, hangul, private use and fullwidth forms are not Han", () => {
  // The old range spanned U+8C48–U+FAFF, which covers hangul and private use,
  // and its surrogate halves matched every supplementary-plane character.
  const notHan = [
    0x3042, // hiragana あ
    0x30a2, // katakana ア
    0xd55c, // hangul syllable 한
    0xe000, // private use area
    0xf8ff, // private use area, end of the BMP block
    0xff21, // fullwidth Latin Ａ
    0xff1a, // fullwidth colon ：
    0x3001, // ideographic comma 、 (punctuation, not an ideograph)
    0x1f600, // emoji 😀: outside the BMP, so it arrives as a surrogate pair
  ];
  for (const point of notHan) {
    assert.equal(
      CJK_PATTERN.test(hanOf(point)),
      false,
      `U+${point.toString(16)}`,
    );
    assert.equal(count(`<p>${hanOf(point)}</p>`), 0, `U+${point.toString(16)}`);
  }
});

test("a mixed-script line counts once, and Latin-only text counts zero", () => {
  assert.equal(count("<p>Save 保存 ひらがな 한국어</p>"), 1);
  assert.equal(count("<p>Save ひらがな 한국어 ＡＢＣ</p>"), 0);
});

test("hyphens and latin text are not CJK", () => {
  // The guard must not match a literal hyphen (a malformed range once did).
  assert.equal(
    count('<div className="nw-btn nw-mt-24">Sign in — check-out</div>'),
    0,
  );
});

test("several CJK lines are each counted", () => {
  assert.equal(count("<p>保存</p>\n<p>发布</p>\n<p>载入中</p>"), 3);
});

test("discovery finds nested components but skips generated and installed trees", () => {
  const root = mkdtempSync(join(tmpdir(), "inline-copy-"));
  try {
    for (const directory of [
      "packages/web-ui/src/components",
      "packages/web-ui/src/components/nested",
      "packages/web-ui/node_modules/a",
      "packages/web-ui/build",
      ".git",
    ])
      mkdirSync(join(root, directory), { recursive: true });
    for (const file of [
      "packages/web-ui/src/components/a.tsx",
      "packages/web-ui/src/components/nested/b.ts",
      "packages/web-ui/node_modules/a/no.tsx",
      "packages/web-ui/build/no.tsx",
      ".git/no.tsx",
      "packages/web-ui/src/components/not.css",
    ])
      writeFileSync(join(root, file), "<p>中文</p>");
    assert.deepEqual(
      findComponentSources(
        join(root, "packages", "web-ui", "src", "components"),
      ),
      [
        join(root, "packages/web-ui/src/components/a.tsx"),
        join(root, "packages/web-ui/src/components/nested/b.ts"),
      ],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an empty component tree is not a successful check", () => {
  const root = mkdtempSync(join(tmpdir(), "inline-copy-empty-"));
  try {
    assert.throws(() => checkRepository(root), /No component source files/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("exceeding the baseline reports a problem, staying at or below does not", () => {
  assert.deepEqual(
    inlineCopyProblems({ files: [], total: MAX_INLINE_COPY_LINES + 1 }),
    [
      {
        path: "packages/web-ui/src/components",
        line: 0,
        reason: `组件内联中文共 ${MAX_INLINE_COPY_LINES + 1} 行，超过基线 ${MAX_INLINE_COPY_LINES}（#346）`,
      },
    ],
  );
  assert.deepEqual(
    inlineCopyProblems({ files: [], total: MAX_INLINE_COPY_LINES }),
    [],
  );
  assert.deepEqual(
    inlineCopyProblems({ files: [], total: MAX_INLINE_COPY_LINES - 1 }),
    [],
  );
});

test("the repository stays within the baseline", () => {
  const root = new URL("..", import.meta.url).pathname;
  const report = checkRepository(root);
  assert.deepEqual(inlineCopyProblems(report), []);
});

test("the baseline is a positive number", () => {
  assert.ok(MAX_INLINE_COPY_LINES > 0);
});
