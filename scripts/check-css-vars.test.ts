import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { checkRepository, findStylesheets, undefinedCssVariables } from "./check-css-vars.ts";

function check(css: string) {
  return undefinedCssVariables([{ path: "example.css", css }]);
}

test("a missing custom property reports file, source line and name", () => {
  assert.deepEqual(check(":root { --paper: white }\np { color: var(--unknown); background: var(--paper) }"), [
    { path: "example.css", line: 2, name: "--unknown" },
  ]);
});

test("definitions may appear after uses or in a different stylesheet", () => {
  assert.deepEqual(undefinedCssVariables([
    { path: "use.css", css: "p { color: var(--ink) }" },
    { path: "tokens.css", css: ":root { --ink: black }" },
  ]), []);
});

test("nested fallback references are checked, even when the outer token exists", () => {
  assert.deepEqual(check(":root { --known: red } p { color: var(--known, var(--missing, blue)) }"), [
    { path: "example.css", line: 1, name: "--missing" },
  ]);
});

test("comments, quoted strings and URLs do not create spurious references", () => {
  assert.deepEqual(check('/* var(--comment) */ p { content: "var(--string)"; background: url("var(--url)") }'), []);
});

test("case-sensitive custom properties and registered @property definitions are respected", () => {
  const result = check("@property --ink { syntax: '<color>'; inherits: true; initial-value: black } p { color: var(--ink); background: var(--Ink) }");
  assert.deepEqual(result, [{ path: "example.css", line: 1, name: "--Ink" }]);
});

test("custom properties used inside other custom properties are checked", () => {
  assert.deepEqual(check(":root { --composite: calc(var(--missing) * 2) }"), [
    { path: "example.css", line: 1, name: "--missing" },
  ]);
});

test("multiple occurrences are reported with their own locations", () => {
  assert.deepEqual(check("p { color: var(--missing) }\na { border-color: var(--missing) }"), [
    { path: "example.css", line: 1, name: "--missing" },
    { path: "example.css", line: 2, name: "--missing" },
  ]);
});

test("invalid CSS fails closed instead of silently skipping a stylesheet", () => {
  assert.throws(() => check("p { color: var(--ink)"), /Unclosed block/);
});

test("discovery finds nested source CSS but skips generated and installed trees", () => {
  const root = mkdtempSync(join(tmpdir(), "css-check-"));
  try {
    for (const directory of ["src", "src/nested", "node_modules/a", "build", ".git"]) mkdirSync(join(root, directory), { recursive: true });
    for (const file of ["src/a.css", "src/nested/b.css", "node_modules/a/no.css", "build/no.css", ".git/no.css", "src/not.txt"]) writeFileSync(join(root, file), ":root { --defined: 1 }");
    assert.deepEqual(findStylesheets(root), [join(root, "src/a.css"), join(root, "src/nested/b.css")]);
    assert.deepEqual(checkRepository(root), []);
    writeFileSync(join(root, "src/nested/b.css"), "p { color: var(--missing) }");
    assert.deepEqual(checkRepository(root), [{ path: "src/nested/b.css", line: 1, name: "--missing" }]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a repository with no source CSS is not a successful check", () => {
  const root = mkdtempSync(join(tmpdir(), "css-empty-"));
  try { assert.throws(() => checkRepository(root), /No CSS source files/); }
  finally { rmSync(root, { recursive: true, force: true }); }
});

test("current source stylesheets declare all referenced custom properties", () => {
  const root = new URL("..", import.meta.url).pathname;
  assert.deepEqual(checkRepository(root), []);
});
