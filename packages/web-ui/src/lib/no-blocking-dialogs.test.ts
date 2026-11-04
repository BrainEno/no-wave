import assert from "node:assert/strict";
import test from "node:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Regression for #195: the writing desk and the comment box collected a link
 * URL, image alt text and image caption through `window.prompt`, and reported a
 * bad URL through `window.alert`.
 *
 * The reason this is a test rather than a review note: `prompt()` returns `null`
 * silently in some mobile WebViews. The image upload then never starts and no
 * error is shown anywhere, so the failure is invisible on exactly the platform
 * where the feature matters most. That cannot be caught by exercising the happy
 * path.
 */

const sourceRoot = new URL("../", import.meta.url);

async function collectSources(directory: URL): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const child = new URL(`${entry.name}${entry.isDirectory() ? "/" : ""}`, directory);
    if (entry.isDirectory()) {
      found.push(...(await collectSources(child)));
    } else if (/\.(tsx?|jsx?)$/.test(entry.name)) {
      found.push(child.pathname);
    }
  }
  return found;
}

/** A call, not the word in prose. Comments are allowed to explain why it is gone. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

test("no component collects input through window.prompt or window.alert", async () => {
  const files = await collectSources(sourceRoot);
  assert.ok(files.length > 50, `expected to scan the component tree, saw ${files.length} files`);
  const offenders: string[] = [];
  for (const file of files) {
    const code = stripComments(await readFile(file, "utf8"));
    if (/\bwindow\s*\.\s*(prompt|alert)\s*\(/.test(code)) {
      offenders.push(file.slice(file.indexOf("/src/") + 1));
    }
  }
  assert.deepEqual(
    offenders,
    [],
    "use PromptDialog (components/ui/prompt-dialog.tsx) instead — prompt() returns null silently in some WebViews",
  );
});

test("the dialog is a native dialog with described fields", async () => {
  const source = await readFile(join(sourceRoot.pathname, "components/ui/prompt-dialog.tsx"), "utf8");
  // Native <dialog> rather than a positioned div: the browser owns the backdrop,
  // focus trapping and Escape (UI_DESIGN_SYSTEM §4.9, and the §3 dialog rule).
  assert.match(source, /<dialog/, "the form must be a native <dialog>");
  assert.match(source, /showModal\(\)/, "and be opened as a modal, so focus is trapped");
  // The error has to be reachable by the input, not merely next to it.
  assert.match(source, /aria-describedby/, "an invalid field must point at its error");
  assert.match(source, /aria-invalid/, "and say that it is invalid");
  assert.match(source, /⚠ 错误：/, "errors carry the design-system prefix");
  assert.match(source, /role="alert"/, "and are announced");
});
