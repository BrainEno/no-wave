import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";

/**
 * Issue #351: status and error notices were styled by the sign-in page's class
 * names (`nw-auth-error`, `nw-auth-status`) even when a dashboard, a media
 * library or a comment thread used them. Changing the sign-in page's look then
 * meant changing every notice on the site. Notices outside the auth screens now
 * use the neutral `nw-notice-error` / `nw-notice-status`, which carry the same
 * rules.
 *
 * Layout classes (`nw-auth-panel`, `nw-auth-switch`, `nw-auth-form`) still appear
 * in a few non-auth components. Moving them needs contextual CSS selectors and
 * the e2e font assertions to change together, and that change cannot be checked
 * visually in this environment, so it is recorded below as a shrinking list
 * rather than silently allowed.
 *
 * The ellipsis rule: Chinese typesetting uses a doubled ellipsis, `……`; a single
 * `…` in visible copy is the older habit this issue retired. A few single
 * characters are not ellipses at all and are listed with their reason.
 */

const COMPONENTS = join(import.meta.dirname, "..", "components");

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return name.endsWith(".tsx") && !name.includes(".test.") ? [path] : [];
  });
}

const isAuthComponent = (path: string): boolean =>
  relative(COMPONENTS, path).split(/[\\/]/)[0] === "auth";

const isComment = (line: string): boolean => /^\s*(\/\/|\/\*|\*|\{\/\*)/.test(line);

/** Single-ellipsis characters that are not ellipses, with the reason each one stays. */
const NOT_AN_ELLIPSIS: [string, string][] = [
  ["https://…", "input placeholder: a truncated example URL"],
  ["ntn_…", "input placeholder: the shape of a Notion token"],
  ["notion.so/…", "input placeholder: the shape of a Notion page link"],
  ["⟦U+…⟧", "display notation for a code point, not text that trails off"],
  ["两个 …；", "a list of punctuation characters that pause a sentence"],
  ["「…」", "quotes the three-dot menu label of the Notion UI"],
];

const LONE_ELLIPSIS = /(?<!…)…(?!…)/;

function nonAuthUsages(pattern: RegExp): string[] {
  return sources(COMPONENTS)
    .filter((path) => !isAuthComponent(path))
    .flatMap((path) =>
      readFileSync(path, "utf8")
        .split("\n")
        .filter((line) => pattern.test(line))
        .map(() => relative(COMPONENTS, path)),
    );
}

test("non-auth components never use the sign-in notice classes", () => {
  assert.deepEqual(nonAuthUsages(/nw-auth-(error|status)\b/), []);
});

/** file -> layout class -> number of lines that use it (migrate in a follow-up). */
const REMAINING_LAYOUT_CLASSES: [string, string, number][] = [
  ["admin/featured-shelf-panel.tsx", "nw-auth-panel", 5],
  ["admin/featured-shelf-panel.tsx", "nw-auth-switch", 5],
  ["authoring/author-profile-panel.tsx", "nw-auth-form", 1],
  ["authoring/authoring-workspace.tsx", "nw-auth-panel", 1],
];

test("the remaining non-auth layout classes match the known list exactly", () => {
  for (const [file, className, expected] of REMAINING_LAYOUT_CLASSES) {
    const count = readFileSync(join(COMPONENTS, file), "utf8")
      .split("\n")
      .filter((line) => new RegExp(`\\b${className}\\b`).test(line)).length;
    assert.equal(count, expected, `${file} uses ${className} ${count} times, expected ${expected}`);
  }
  const offenders = nonAuthUsages(/nw-auth-(panel|switch|form)\b/);
  const known = REMAINING_LAYOUT_CLASSES.reduce((sum, [, , n]) => sum + n, 0);
  assert.equal(offenders.length, known, "a non-auth file uses a layout class that is not on the known list");
});

test("the notice classes have styles of their own", () => {
  const css = readFileSync(join(import.meta.dirname, "..", "styles", "globals.css"), "utf8");
  for (const name of [".nw-notice-error", ".nw-notice-status"]) {
    assert.match(css, new RegExp(`\\${name}\\b`), `${name} has no rule`);
  }
});

test("component copy uses the doubled ellipsis, with the exceptions named above", () => {
  const offenders: string[] = [];
  for (const path of sources(COMPONENTS)) {
    readFileSync(path, "utf8").split("\n").forEach((line, index) => {
      if (isComment(line)) return;
      let rest = line;
      for (const [allowed] of NOT_AN_ELLIPSIS) rest = rest.split(allowed).join("");
      if (LONE_ELLIPSIS.test(rest)) offenders.push(`${relative(COMPONENTS, path)}:${index + 1}`);
    });
  }
  assert.deepEqual(offenders, []);
});

test("every named exception still occurs, so the allowance cannot go stale", () => {
  const all = sources(COMPONENTS).map((path) => readFileSync(path, "utf8")).join("\n");
  for (const [allowed, reason] of NOT_AN_ELLIPSIS) {
    assert.ok(all.includes(allowed), `no component contains "${allowed}" (${reason})`);
  }
});
