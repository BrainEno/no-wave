import { existsSync, readFileSync, readdirSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "@babel/parser";

/**
 * 设计令牌的伴生守门（#345）：`packages/web-ui` 里内联 `style={{…}}` 的数量与注释。
 *
 * 间距、圆角、层级都应来自 `globals.css` 的阶梯与工具类；只有运行时才能确定
 * 的值（对选区的测量、按数据计算的布局）才允许内联，而且必须在**同一行或上一行**
 * 用注释写明运行时依据，否则审查时无法区分「有意内联」和「又一处写死的数字」。
 *
 * 判定基于语法树而不是文本：只有真正的注释 token 才算理由，字符串、模板字符串
 * 和 URL（如 `https://`）里的 `//`、`/*` 不会伪装成注释；被块注释包住的
 * `style={{` 也不计数。
 */

/** 验收上限：issue #345 要求 `packages/web-ui` 内 `style={{` ≤ 15。 */
export const MAX_INLINE_STYLES = 15;

export type InlineStyleProblem = { path: string; line: number; reason: string };

export type InlineStyleReport = {
  /** Every JSX `style={…}` attribute in the source, justified or not. */
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

const MISSING_REASON =
  "内联 style 缺少原因注释（同行或上一行需有 // 或 /* 注释）";
const VAGUE_REASON =
  "内联 style 的注释没有写明运行时依据（需说明测量或动态数据等无法用 CSS 表达的原因）";

/** 理由必须指向运行时才能知道的值；静态间距、颜色不属于这类理由。 */
const RUNTIME_CAUSE =
  /运行时|测量|动态|选区|视口|拖拽|滚动|计算|runtime|measur|dynamic|viewport|drag|scroll|selection|computed/i;
/** 以占位标记开头的注释不是理由，即使其后有文字。 */
const PLACEHOLDER = /^(todo|fixme|xxx|tbd|hack|wip)\b/i;
/** 「内联：」「inline:」这类约定前缀不计入理由。 */
const TAG = /^(内联|inline)\s*[：:]?\s*/i;

/**
 * Whether one comment's text states a runtime-only reason. Requires enough
 * substantive characters, a runtime cause, and no placeholder. This is a
 * floor: a reviewer still has to judge the substance of the reason.
 */
export function justifies(commentText: string): boolean {
  const reason = commentText
    .replace(/^\s*\*+/gm, "")
    .replace(TAG, "")
    .trim();
  if (PLACEHOLDER.test(reason)) return false;
  const substance = reason.match(/[\p{L}\p{N}]/gu) ?? [];
  return substance.length >= 6 && RUNTIME_CAUSE.test(reason);
}

type AstComment = {
  type: string;
  value: string;
  loc: { end: { line: number } };
};

/** Line of every JSX `style={…}` attribute, in document order. */
function styleAttributeLines(node: unknown, found: number[] = []): number[] {
  if (Array.isArray(node)) {
    for (const child of node) styleAttributeLines(child, found);
    return found;
  }
  if (typeof node !== "object" || node === null || !("type" in node))
    return found;
  const record = node as Record<string, unknown>;
  if (
    record.type === "JSXAttribute" &&
    typeof record.name === "object" &&
    record.name !== null &&
    (record.name as { type?: unknown }).type === "JSXIdentifier" &&
    (record.name as { name?: unknown }).name === "style" &&
    typeof record.value === "object" &&
    record.value !== null &&
    (record.value as { type?: unknown }).type === "JSXExpressionContainer"
  ) {
    const loc = record.loc as { start: { line: number } };
    found.push(loc.start.line);
  }
  for (const [key, child] of Object.entries(record)) {
    if (key === "loc" || key === "comments" || key.endsWith("Comments"))
      continue;
    styleAttributeLines(child, found);
  }
  return found;
}

/**
 * Parse one source file and check every JSX `style` attribute. Parsing
 * fails closed: a file the parser rejects is an error, not a silent pass.
 */
export function checkSource(path: string, source: string): InlineStyleReport {
  const ast = parse(source, {
    sourceType: "module",
    plugins: extname(path) === ".tsx" ? ["typescript", "jsx"] : ["typescript"],
  });
  const comments = (ast.comments ?? []) as AstComment[];
  const attributes = styleAttributeLines(ast);
  const problems: InlineStyleProblem[] = [];
  for (const line of attributes) {
    // A justification is a real comment token that ends on the style line or
    // on the line above it, so text inside a string or URL never counts.
    const nearby = comments.filter(
      (comment) =>
        comment.loc.end.line === line || comment.loc.end.line === line - 1,
    );
    if (nearby.length === 0)
      problems.push({ path, line, reason: MISSING_REASON });
    else if (!nearby.some((comment) => justifies(comment.value)))
      problems.push({ path, line, reason: VAGUE_REASON });
  }
  return { occurrences: attributes.length, problems };
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
