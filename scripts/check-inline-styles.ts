import { existsSync, readFileSync, readdirSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 设计令牌的伴生守门（#345）：`packages/web-ui` 里内联 `style={{…}}` 的数量与注释。
 *
 * 间距、圆角、层级都应来自 `globals.css` 的阶梯与工具类；只有运行时才能确定
 * 的值（对选区的测量、按数据计算的布局）才允许内联，而且必须在**同一行或上一行**
 * 用注释写明原因，否则审查时无法区分「有意内联」和「又一处写死的数字」。
 */

/** 验收上限：issue #345 要求 `packages/web-ui` 内 `style={{` ≤ 15。 */
export const MAX_INLINE_STYLES = 15;

export type InlineStyleProblem = { path: string; line: number; reason: string };

export type InlineStyleReport = {
  /** Every `style={{` occurrence in the source, justified or not. */
  occurrences: number;
  problems: InlineStyleProblem[];
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

/** Source files that may carry inline styles: TypeScript and TSX. */
export function findSources(directory: string): string[] {
  const result: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!skipped.has(entry.name))
        result.push(...findSources(join(directory, entry.name)));
    } else if (
      (extname(entry.name) === ".ts" || extname(entry.name) === ".tsx") &&
      !entry.name.endsWith(".d.ts")
    )
      result.push(join(directory, entry.name));
  }
  return result.sort();
}

/**
 * Blank out block comments while keeping line numbers intact, so a `style={{`
 * inside a comment does not count as an inline style.
 */
function stripBlockComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, (match) =>
    match.replace(/[^\n]/g, " "),
  );
}

const COMMENT = /(?:\/\/|\/\*)/;

export function checkSource(path: string, source: string): InlineStyleReport {
  const lines = stripBlockComments(source).split("\n");
  const problems: InlineStyleProblem[] = [];
  let occurrences = 0;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    let at = line.indexOf("style={{");
    while (at !== -1) {
      occurrences++;
      const justified =
        COMMENT.test(line) || (index > 0 && COMMENT.test(lines[index - 1]!));
      if (!justified)
        problems.push({
          path,
          line: index + 1,
          reason: "内联 style 缺少原因注释（同行或上一行需有 // 或 /* 注释）",
        });
      at = line.indexOf("style={{", at + 1);
    }
  }
  return { occurrences, problems };
}

export function checkRepository(root: string): InlineStyleProblem[] {
  const target = join(root, "packages", "web-ui");
  const files = existsSync(target) ? findSources(target) : [];
  if (files.length === 0)
    throw new Error("No source files found; refusing to pass an empty check.");
  const reports = files.map((file) =>
    checkSource(relative(root, file), readFileSync(file, "utf8")),
  );
  const total = reports.reduce((sum, report) => sum + report.occurrences, 0);
  const problems = reports.flatMap((report) => report.problems);
  if (total > MAX_INLINE_STYLES) {
    problems.unshift({
      path: "packages/web-ui",
      line: 0,
      reason: `内联 style 共 ${total} 处，超过上限 ${MAX_INLINE_STYLES}（#345）`,
    });
  }
  return problems;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const root = fileURLToPath(new URL("..", import.meta.url));
    const problems = checkRepository(root);
    for (const { path, line, reason } of problems)
      process.stderr.write(`${path}:${line}: ${reason}\n`);
    if (problems.length) process.exitCode = 1;
    else
      process.stdout.write(
        `Inline styles within the limit (${MAX_INLINE_STYLES}) and justified.\n`,
      );
  } catch (error) {
    process.stderr.write(
      `Inline style check failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
