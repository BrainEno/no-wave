import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

/**
 * Issue #416: the design system had two colour sources that disagreed (the
 * spec's `--orange` / `--flesh` / `--text-2` against the executable `--or` /
 * `--t2` in globals.css), and the implementation notes described a stack that
 * no longer existed. `globals.css` is the executable token source. The spec's
 * token block must name the same tokens with the same HEX values, the shadow
 * deviation is frozen so it cannot grow silently, and the reading path from the
 * rules file to the spec must stay connected.
 */

const REPO = join(import.meta.dirname, "..", "..", "..", "..");
const read = (path: string): string => readFileSync(join(REPO, path), "utf8");

const SPEC = "packages/web-ui/docs/UI_DESIGN_SYSTEM.md";
const CSS = "packages/web-ui/src/styles/globals.css";
const NOTES = "packages/web-ui/docs/IMPLEMENTATION_NOTES.md";

type Tokens = Map<string, string>;

function hexDeclarations(block: string): Tokens {
  const tokens: Tokens = new Map();
  for (const match of block.matchAll(/--([a-z0-9-]+)\s*:\s*(#[0-9a-fA-F]{6})\b/g))
    tokens.set(match[1]!, match[2]!.toLowerCase());
  return tokens;
}

function ruleBody(source: string, selector: RegExp): string {
  const match = selector.exec(source);
  assert.ok(match, `selector ${selector} not found`);
  return match[1]!;
}

const spec = read(SPEC);
const css = read(CSS);

// §3.1 is the first css block under the colour heading.
const specBlock = /### 3\.1 颜色\s*```css\n([\s\S]*?)```/.exec(spec);
assert.ok(specBlock, "§3.1 colour code block is missing");
const specTokens = specBlock[1]!;

const specLight = hexDeclarations(ruleBody(specTokens, /^:root\s*\{([^}]*)\}/m));
const specDarkMedia = hexDeclarations(
  ruleBody(specTokens, /:root:not\(\[data-theme="light"\]\)\s*\{([^}]*)\}/),
);
const specDarkAttr = hexDeclarations(ruleBody(specTokens, /:root\[data-theme="dark"\]\s*\{([^}]*)\}/));

const cssLight = hexDeclarations(ruleBody(css, /:root\s*\{([^}]*)\}/));
const cssDarkMedia = hexDeclarations(
  ruleBody(css, /@media \(prefers-color-scheme: dark\)\s*\{\s*:root:not\(\[data-theme="light"\]\)\s*\{([^}]*)\}/),
);
const cssDarkAttr = hexDeclarations(ruleBody(css, /:root\[data-theme="dark"\]\s*\{([^}]*)\}/));

function assertSameTokens(documented: Tokens, implemented: Tokens, scope: string): void {
  assert.ok(documented.size > 0, `${scope}: no tokens were parsed from the spec`);
  for (const [name, value] of documented) {
    assert.ok(implemented.has(name), `${scope}: --${name} is documented but globals.css does not define it`);
    assert.equal(implemented.get(name), value, `${scope}: --${name} differs between the spec and globals.css`);
  }
}

test("the spec's light colour tokens match globals.css", () => {
  assertSameTokens(specLight, cssLight, "light :root");
});

test("the spec's dark colour tokens match globals.css in both dark selectors", () => {
  assertSameTokens(specDarkMedia, cssDarkMedia, "prefers-color-scheme: dark");
  assertSameTokens(specDarkAttr, cssDarkAttr, "[data-theme=dark]");
});

test("the retired token names do not reappear in the spec's colour block", () => {
  for (const retired of ["orange", "flesh", "text-2", "text-2-on-ink"]) {
    assert.ok(!specTokens.includes(`--${retired}:`), `--${retired} is not an implemented token`);
  }
});

/**
 * Known deviation: the spec says no shadows, while globals.css still has
 * decorative shadows. The count is frozen here. Lower the number when a shadow
 * is removed; a new shadow fails this test until the spec is changed on purpose.
 */
const SHADOW_BASELINE = 23;

test("box-shadow declarations do not grow beyond the recorded baseline", () => {
  const count = css.split("\n").filter((line) => line.includes("box-shadow")).length;
  assert.ok(
    count <= SHADOW_BASELINE,
    `globals.css has ${count} box-shadow lines; the spec forbids shadows, so new ones need a spec change (baseline ${SHADOW_BASELINE}, see #416)`,
  );
});

test("the spec names globals.css as the executable token source", () => {
  assert.match(spec, /唯一可执行的 token 源[^\n]*globals\.css/);
});

test("the rules file and the docs index both reach the current UI spec", () => {
  const agents = read("AGENTS.md");
  const index = read("docs/README.md");
  assert.ok(agents.includes("packages/web-ui/docs/UI_DESIGN_SYSTEM.md"), "AGENTS.md does not link the UI spec");
  assert.ok(
    index.includes("../packages/web-ui/docs/UI_DESIGN_SYSTEM.md") && index.includes("Status: active"),
    "docs/README.md does not index the active UI spec",
  );
});

test("the early implementation notes are explicitly archived", () => {
  const head = read(NOTES).split("\n").slice(0, 6).join("\n");
  assert.match(head, /Status: archived/);
});
