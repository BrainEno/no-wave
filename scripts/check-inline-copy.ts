import { existsSync, readFileSync, readdirSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 内联中文文案的守门（#346）：`packages/web-ui/src/components` 里用户可见的
 * 中文文案应迁入 `lib/ui-copy.ts`，让语言扩展成为「翻译数据」而不是改写组件。
 *
 * 计数口径与 issue #346 一致：**非注释行**中只要出现一个中日韩汉字就计一行。
 * 块注释被抹空后仍保留行号，纯注释行（`//`、`*`、`/*` 开头）不计。这个口径偏宽，
 * 目的是让基线只降不升——迁移把文案搬进 `ui-copy.ts` 后，组件里的中文行数必然
 * 减少，而新增内联中文会被立刻发现。
 *
 * 基线随迁移逐步下调：改这个常量前，先确认 `packages/web-ui/src/components` 的
 * 实际计数已经降到目标值以下，否则守门会失败。
 */

/**
 * 当前基线：迁移 account 模块后的实测行数（2501）。
 *
 * 只降不升——任何让组件内中文行数超过这个值的改动都视为回退。
 * 后续按 authoring / media / comments / admin 逐个模块迁移时，把文案搬进
 * `ui-copy.ts` 后再把这个常量同步下调到新的实测值。
 */
export const MAX_INLINE_COPY_LINES = 2501;

/**
 * 匹配一个汉字：Unicode 脚本属性 Han，覆盖基本区、扩展 A–I 与兼容表意文字，
 * 简体与繁体都计入。假名、谚文、私用区和全角符号不计入。
 *
 * 旧的手写区间 `豈-﫿` 实际是 U+8C48–U+FAFF（豈 是 U+8C48，不是 U+F900），
 * 会把谚文音节、私用区和全角字符都算成汉字。它也没有 `u` 标志，补充平面字符
 * 被拆成代理对，代理对恰好落在该区间内，于是 emoji 等字符也被误判为汉字。
 */
export const CJK_PATTERN = /\p{Script=Han}/u;

export type InlineCopyProblem = { path: string; line: number; reason: string };

export type InlineCopyReport = {
  /** 每个文件里被计入的中文行数。 */
  files: { path: string; lines: number }[];
  /** 全部计入行数（所有文件之和）。 */
  total: number;
};

const skipped = new Set([
  ".git",
  "node_modules",
  "build",
  "dist",
  ".react-router",
  ".arena",
  "coverage",
]);

/** Source files that may carry inline copy: TypeScript and TSX. */
export function findComponentSources(directory: string): string[] {
  const result: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!skipped.has(entry.name))
        result.push(...findComponentSources(join(directory, entry.name)));
    } else if (
      (extname(entry.name) === ".ts" || extname(entry.name) === ".tsx") &&
      !entry.name.endsWith(".d.ts")
    )
      result.push(join(directory, entry.name));
  }
  return result.sort();
}

/**
 * Blank out block comments while keeping line numbers intact, so a Chinese
 * string inside a `/* … *\/` comment does not count as inline copy.
 */
function stripBlockComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, (match) =>
    match.replace(/[^\n]/g, " "),
  );
}

const COMMENT_ONLY = /^\s*(\/\/|\*|\/\*)/;

/** Count the non-comment lines that contain a CJK literal in one file. */
export function countInlineCopy(path: string, source: string): number {
  const lines = stripBlockComments(source).split("\n");
  let count = 0;
  for (const line of lines) {
    if (COMMENT_ONLY.test(line)) continue;
    if (CJK_PATTERN.test(line)) count++;
  }
  return count;
}

export function checkSource(path: string, source: string): number {
  return countInlineCopy(path, source);
}

export function checkRepository(root: string): InlineCopyReport {
  const target = join(root, "packages", "web-ui", "src", "components");
  const files = existsSync(target) ? findComponentSources(target) : [];
  if (files.length === 0)
    throw new Error(
      "No component source files found; refusing to pass an empty check.",
    );
  const perFile = files.map((file) => ({
    path: relative(root, file),
    lines: checkSource(relative(root, file), readFileSync(file, "utf8")),
  }));
  const total = perFile.reduce((sum, file) => sum + file.lines, 0);
  return { files: perFile, total };
}

/** Violations: the total exceeding the baseline, or the total rising at all. */
export function inlineCopyProblems(
  report: InlineCopyReport,
  baseline: number = MAX_INLINE_COPY_LINES,
): InlineCopyProblem[] {
  if (report.total > baseline)
    return [
      {
        path: "packages/web-ui/src/components",
        line: 0,
        reason: `组件内联中文共 ${report.total} 行，超过基线 ${baseline}（#346）`,
      },
    ];
  return [];
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const root = fileURLToPath(new URL("..", import.meta.url));
    const report = checkRepository(root);
    const problems = inlineCopyProblems(report);
    for (const { path, line, reason } of problems)
      process.stderr.write(`${path}:${line}: ${reason}\n`);
    if (problems.length) process.exitCode = 1;
    else
      process.stdout.write(
        `Inline copy within the baseline (${MAX_INLINE_COPY_LINES}): ${report.total} lines.\n`,
      );
  } catch (error) {
    process.stderr.write(
      `Inline copy check failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
