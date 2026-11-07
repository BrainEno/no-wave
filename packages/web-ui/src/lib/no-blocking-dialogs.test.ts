import assert from "node:assert/strict";
import test from "node:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Regression for #195 and F-12: the writing desk and the comment box collected a
 * link URL, image alt text and image caption through `window.prompt`, reported a
 * bad URL through `window.alert`, and asked "really delete this?" through
 * `window.confirm` in three places.
 *
 * The reason this is a test rather than a review note: `prompt()` returns `null`
 * silently in some mobile WebViews, and — worse for a delete — `confirm()` can
 * be suppressed by the host WebView while still returning `false`. The button
 * then does nothing at all: no request, no error, no feedback. That is
 * indistinguishable from a broken page, and it cannot be caught by exercising
 * the happy path.
 *
 * Every one of them is now a native `<dialog>` this package owns, so the failure
 * mode is gone by construction — and this test keeps it gone.
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

test("no component blocks the page with window.prompt, alert or confirm", async () => {
  const files = await collectSources(sourceRoot);
  assert.ok(files.length > 50, `expected to scan the component tree, saw ${files.length} files`);
  const offenders: string[] = [];
  for (const file of files) {
    const code = stripComments(await readFile(file, "utf8"));
    const name = file.slice(file.indexOf("/src/") + 1);
    if (/\bwindow\s*\.\s*(prompt|alert|confirm)\s*\(/.test(code)) offenders.push(name);
    // Test files quote the unsafe strings they reject (`javascript:alert(1)`),
    // and `confirm-dialog.tsx` *is* the replacement; neither is a call site.
    if (/\.test\./.test(name) || name.endsWith("components/ui/confirm-dialog.tsx")) continue;
    // The bare form is the same call: two of the three delete questions were
    // written without the `window.` prefix. `confirm({ … })` is this package's
    // own hook (`useConfirm`), which takes an options object — that is the one
    // shape that is allowed.
    for (const match of code.matchAll(/(^|[^\w.$])(alert|prompt|confirm)\s*\(/g)) {
      const callee = match[2]!;
      const rest = code.slice(match.index! + match[0].length).trimStart();
      if (callee === "confirm" && rest.startsWith("{")) continue;
      offenders.push(`${name} (${callee})`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    "use PromptDialog (components/ui/prompt-dialog.tsx) or ConfirmDialog (components/ui/confirm-dialog.tsx) instead — a blocking dialog can be suppressed by a WebView and return false, which turns a button into a silent no-op",
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

test("the confirmation dialog cannot be dismissed into a destructive action", async () => {
  const source = stripComments(await readFile(join(sourceRoot.pathname, "components/ui/confirm-dialog.tsx"), "utf8"));
  // Native <dialog> for the same reason as the form dialog: the browser owns the
  // backdrop, the focus trap and Escape.
  assert.match(source, /<dialog/, "the confirmation must be a native <dialog>");
  assert.match(source, /showModal\(\)/, "and be opened as a modal, so focus is trapped");
  // The warning has to be part of the dialog's accessible description: a delete
  // question whose consequence is only visually adjacent to the button is a
  // question half the readers never hear.
  assert.match(source, /aria-describedby/, "the consequence must be described by the dialog");
  // Focus starts on cancel and there is no form, so Enter cannot confirm a
  // deletion. This is deliberate: `window.confirm` made Enter = OK.
  assert.match(source, /autoFocus/, "focus starts on the safe answer");
  assert.doesNotMatch(source, /<form/, "no form: Enter must not fire the action");
  // One answer per dialog, however many close events arrive.
  assert.match(
    source,
    /resolver\.current = null;[\s\S]{0,120}resolve\?\.\(value\)/,
    "the pending promise is cleared before it resolves, so a late close resolves nothing",
  );
});

test("a confirmation is not a form with no fields", async () => {
  const files = await collectSources(sourceRoot);
  const offenders: string[] = [];
  for (const file of files) {
    const name = file.slice(file.indexOf("/src/") + 1);
    if (/\.test\./.test(name)) continue;
    const source = stripComments(await readFile(file, "utf8"));
    // `fields={[]}` was how the desk asked two questions before ConfirmDialog
    // existed: a dialog that renders no input and submits on Enter. It worked,
    // and it is exactly the shape that lets a destructive answer be the default.
    if (/fields=\{\s*\[\s*\]\s*\}/.test(source)) offenders.push(name);
  }
  assert.deepEqual(offenders, [], "use ConfirmDialog (components/ui/confirm-dialog.tsx) for a yes/no question");
});
