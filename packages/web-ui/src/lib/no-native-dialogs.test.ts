import assert from "node:assert/strict";
import test from "node:test";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 原生对话框不许回到共享 UI 里（issue #168）。
 *
 * 这是一条**结构性**断言，不是行为断言：`window.prompt` / `alert` / `confirm`
 * 在测试里跑不起来，也就是说任何组件里的它们都不会被这些测试发现——正是它们
 * 藏在九个地方还活了这么久的原因。
 *
 * 三个具体的危害，按严重程度排序：
 *
 * 1. 移动端内嵌 WebView 里 `prompt()` 可能直接返回 `null` 而**不显示任何东西**，
 *    于是「插入图片」在那里永远失败，且没有任何反馈；
 * 2. `alert` / `confirm` 阻塞脚本、抢焦点，屏幕阅读器读到的是一句没有归属的话，
 *    而 `aria-describedby` 本可以把错误挂回它所属的字段；
 * 3. 样式完全不受 `UI_DESIGN_SYSTEM.md` 约束，与整站的直角线框系统无关。
 *
 * 替代品是 `components/ui/inline-form.tsx`。扫描的是源码文件本身，所以这条断言
 * 不需要浏览器，也不需要跑应用。
 */

const here = dirname(fileURLToPath(import.meta.url));
const roots = [join(here, "..", "components"), join(here, "..", "lib")];

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await sourceFiles(path));
    else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) files.push(path);
  }
  return files;
}

/**
 * 出现即违规的调用。
 *
 * 注释里提到 `window.prompt` 是允许的——好几处注释正是在解释为什么不再用它。
 * 所以匹配的是**调用**（后面跟括号），而不是这个名字本身。
 */
const FORBIDDEN_CALLS: readonly RegExp[] = [
  /window\s*\.\s*prompt\s*\(/,
  /window\s*\.\s*alert\s*\(/,
  /window\s*\.\s*confirm\s*\(/,
  // The bare forms are equally real: a bundler resolves them to the same thing.
  /(?<![.\w])prompt\s*\(\s*["'`]/,
  /(?<![.\w])confirm\s*\(\s*["'`]/,
];

function stripComments(source: string): string {
  // Block comments and whole-line `//` comments only: a `//` inside a string is
  // not a comment, and no source file here puts a URL in a position where this
  // matters. What it does catch is the nine doc comments that name these APIs.
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

test("共享 UI 里不再调用原生 prompt / alert / confirm", async () => {
  const offenders: string[] = [];
  for (const root of roots) {
    for (const file of await sourceFiles(root)) {
      if (file.endsWith(".test.ts") || file.endsWith(".test.tsx")) continue;
      const source = stripComments(await readFile(file, "utf8"));
      for (const pattern of FORBIDDEN_CALLS) {
        if (pattern.test(source)) offenders.push(`${file.slice(here.length + 1)} matches ${pattern}`);
      }
    }
  }
  assert.deepEqual(offenders, [], "native dialogs must be replaced by InlineForm / InlineConfirm");
});

test("`serial` 不再出现在写作台的作品类型下拉框里", async () => {
  const source = stripComments(await readFile(join(here, "..", "components", "authoring", "article-editor.tsx"), "utf8"));
  // The retired type is still *read*: `workTypeOptions` adds it back for a work
  // that already has it. What must not come back is offering it to a new work.
  assert.match(source, /workTypeOptions\(/, "the editor renders the filtered list");
  const choiceList = source.slice(source.indexOf("const workTypes"), source.indexOf("const SERIAL_WORK_TYPE"));
  assert.equal(/value:\s*"serial"/.test(choiceList), false, "a new work cannot choose the retired type");
  assert.match(source, /SERIAL_WORK_TYPE/, "an existing serial work still displays as one");
});
