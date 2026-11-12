import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename } from "node:path";
import test from "node:test";
import postcss from "postcss";
import { expandUnicodeRange, unicodeRange, validateWoff2, type FontManifest } from "../../../scripts/lib/font-assets.ts";

const client = new URL("../build/client/", import.meta.url);
const assets = new URL("assets/", client);
const manifest = JSON.parse(readFileSync(new URL("../../../packages/web-ui/src/styles/fonts/manifest.json", import.meta.url), "utf8")) as FontManifest;
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

function builtFontStylesheet(): string {
  assert.ok(existsSync(assets), "Build the production Web app before its tests: pnpm test:web");
  const files = readdirSync(assets).filter((file) => /^fonts-[A-Za-z0-9_-]+\.css$/.test(file));
  assert.equal(files.length, 1, "one separately cacheable first-party font stylesheet is emitted");
  return readFileSync(new URL(files[0]!, assets), "utf8");
}

function identity(family: string, style: string, weight: string, range: string): string {
  // Vite's CSS minifier losslessly turns e.g. U+2000-20FF into U+20??.
  const expandedWildcards = range.replaceAll(/U\+([0-9a-f]*)(\?+)/gi, (_match, prefix: string, wildcards: string) =>
    `U+${prefix}${"0".repeat(wildcards.length)}-${prefix}${"F".repeat(wildcards.length)}`);
  return `${family}:${style}:${weight}:${unicodeRange(expandUnicodeRange(expandedWildcards.replaceAll(/\s/g, "")))}`;
}

test("production CSS addresses every source face through an actual hashed same-origin WOFF2", () => {
  const css = builtFontStylesheet();
  assert.doesNotMatch(css, /https?:|data:|local\(|@import/);
  const expected = new Map(manifest.faces.map((face) => [identity(face.family, face.style, face.weight, face.unicodeRange), face]));
  const seen = new Set<string>();
  const published = new Set<string>();
  const stylesheet = postcss.parse(css);
  stylesheet.walkAtRules("font-face", (rule) => {
    const declarations = new Map<string, string>();
    rule.walkDecls((declaration) => { declarations.set(declaration.prop, declaration.value); });
    const family = (declarations.get("font-family") ?? "").replaceAll(/["']/g, "");
    const key = identity(family, declarations.get("font-style") ?? "normal", declarations.get("font-weight") ?? "400", declarations.get("unicode-range") ?? "");
    const original = expected.get(key);
    assert.ok(original, `emitted face has no checked-in receipt: ${key}`);
    assert.equal(seen.has(key), false, "a face is not duplicated by a second stylesheet path");
    assert.equal(declarations.get("font-display"), "swap");
    const src = declarations.get("src") ?? "";
    const match = /^url\(["']?(\/assets\/[a-zA-Z0-9_-]+\.woff2)["']?\)\s*format\(["']woff2["']\)$/.exec(src);
    assert.ok(match, `the font must not be external, inline, or dependent on a system font: ${src}`);
    const path = match[1]!;
    assert.match(basename(path), new RegExp(`^${original.file.slice(0, -6)}-[A-Za-z0-9_-]+\\.woff2$`));
    const bytes = readFileSync(new URL(path.slice(1), client));
    validateWoff2(bytes);
    assert.equal(bytes.length, original.byteLength, original.file);
    assert.equal(sha256(bytes), original.sha256, original.file);
    seen.add(key);
    published.add(basename(path));
  });
  assert.equal(seen.size, manifest.faces.length, "no lazy script, glyph range, weight or italic disappears during bundling");
  const emittedFiles = readdirSync(assets).filter((file) => file.endsWith(".woff2")).sort();
  assert.deepEqual(emittedFiles, [...published].sort(), "the client build ships neither unowned nor unreachable fonts");
});

test("font tools and upstream source-download logic do not enter browser JavaScript", () => {
  assert.ok(existsSync(assets), "The production Web build is required.");
  const files = readdirSync(assets).filter((file) => file.endsWith(".js"));
  assert.ok(files.length > 0);
  const code = files.map((file) => readFileSync(new URL(file, assets), "utf8")).join("\n");
  for (const serverOnly of ["harfbuzz-subset.wasm", "no-wave-font-builder", "github.com/repos/google/fonts/git/blobs", "fontkit", "subset-font"]) {
    assert.equal(code.includes(serverOnly), false, `${serverOnly} is a generation-only dependency`);
  }
  assert.doesNotMatch(code, /fonts\.(?:googleapis|gstatic)\.com/);
});
