import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { Script } from "node:vm";
import { resolveConfig } from "prettier";

const require = createRequire(import.meta.url);
const stylelintRequire = createRequire(require.resolve("stylelint"));
const webRequire = createRequire(new URL("../apps/web-rr/package.json", import.meta.url));
const viteRequire = createRequire(webRequire.resolve("vite"));
const sorted = (files: string[]) => files.map(file => file.replace(/\\/g, "/")).sort();

test("real fast-glob, tinyglobby and fdir consumers preserve discovery, exclusions and dotfiles", async () => {
  const root = await mkdtemp(join(tmpdir(), "no-wave-glob-walkers-"));
  try {
    const files = ["src/a/index.ts", "src/a/index.test.ts", "src/b/view.tsx", "src/b/view.css", "src/.secret/private.ts", "space [demo]/中文.ts"];
    for (const file of files) {
      await mkdir(dirname(join(root, file)), { recursive: true });
      await writeFile(join(root, file), "fixture\n");
    }
    const fastGlob = stylelintRequire("fast-glob") as (patterns: string[], options: Record<string, unknown>) => Promise<string[]>;
    const tinyGlob = viteRequire("tinyglobby") as {
      glob(patterns: string[], options: Record<string, unknown>): Promise<string[]>;
      globSync(patterns: string[], options: Record<string, unknown>): string[];
    };
    const patterns = ["src/**/*.{ts,tsx}", "!**/*.test.ts"];
    const expected = ["src/a/index.ts", "src/b/view.tsx"];
    assert.deepEqual(sorted(await fastGlob(patterns, { cwd: root })), expected);
    assert.deepEqual(sorted(await tinyGlob.glob(patterns, { cwd: root })), expected);
    assert.deepEqual(sorted(tinyGlob.globSync(patterns, { cwd: root })), expected);
    const withDots = ["src/.secret/private.ts", ...expected];
    assert.deepEqual(sorted(await fastGlob(patterns, { cwd: root, dot: true })), withDots);
    assert.deepEqual(sorted(tinyGlob.globSync(patterns, { cwd: root, dot: true })), withDots);
    assert.deepEqual(sorted(tinyGlob.globSync(["src/a"], { cwd: root })), ["src/a/index.test.ts", "src/a/index.ts"]);
    assert.deepEqual(tinyGlob.globSync(["space \\[demo\\]/*.ts"], { cwd: root }), ["space [demo]/中文.ts"]);

    const fdirRequire = createRequire(viteRequire.resolve("tinyglobby"));
    type Crawler = { crawl(root: string): { sync(): string[] } };
    const { fdir: Fdir } = fdirRequire("fdir") as { fdir: new () => {
      withRelativePaths(): { glob(pattern: string): Crawler; globWithOptions(patterns: string[], options: { dot: boolean }): Crawler };
    } };
    // fdir deliberately defaults to dot:true, unlike the other two walkers.
    assert.deepEqual(sorted(new Fdir().withRelativePaths().glob("src/**/*.ts").crawl(root).sync()), ["src/.secret/private.ts", "src/a/index.test.ts", "src/a/index.ts"]);
    assert.deepEqual(sorted(new Fdir().withRelativePaths().globWithOptions(["src/**/*.ts"], { dot: false }).crawl(root).sync()), ["src/a/index.test.ts", "src/a/index.ts"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Prettier's bundled matcher executes the non-recursive engine for config overrides", async () => {
  const root = await mkdtemp(join(tmpdir(), "no-wave-glob-prettier-"));
  const engineRequire = createRequire(require.resolve("@bot-thk/glob-match/package.json"));
  const { Minimatch } = engineRequire("minimatch") as { Minimatch: { prototype: { match(input: string, partial?: boolean): boolean } } };
  const original = Minimatch.prototype.match;
  let calls = 0;
  Minimatch.prototype.match = function (input: string, partial?: boolean): boolean {
    calls++;
    return original.call(this, input, partial);
  };
  try {
    const config = join(root, ".prettierrc.json");
    await writeFile(config, JSON.stringify({ tabWidth: 2, overrides: [{ files: "{apps,packages}/**/*.ts", excludeFiles: "**/*.test.ts", options: { tabWidth: 6 } }] }));
    const options = { config, editorconfig: false, useCache: false };
    assert.equal((await resolveConfig(join(root, "apps/api/index.ts"), options))?.tabWidth, 6);
    assert.equal((await resolveConfig(join(root, "apps/api/index.test.ts"), options))?.tabWidth, 2);
    assert.ok(calls > 0, "changing the lockfile alone must not leave Prettier's bundled compiler active");
  } finally {
    Minimatch.prototype.match = original;
    await rm(root, { recursive: true, force: true });
  }
});

test("bundled compilers have no references outside their inactive definitions", async () => {
  const playwrightRequire = createRequire(require.resolve("@playwright/test"));
  for (const [bundle, prefix] of [
    [join(dirname(playwrightRequire.resolve("playwright")), "lib/matchers/expect.js"), "// node_modules/picomatch/"],
    [join(dirname(require.resolve("prettier")), "index.mjs"), "// node_modules/micromatch/node_modules/picomatch/"],
  ]) {
    const source = await readFile(bundle!, "utf8");
    const start = source.indexOf(`${prefix}lib/constants.js`);
    const end = source.indexOf(`${prefix}index.js`, start);
    assert.ok(start >= 0 && end > start, "review this guard when updating the upstream bundle layout");
    const definitions = source.slice(start, end);
    const callers = source.slice(0, start) + source.slice(end);
    // Utilities have fixed-source path regexes and Prettier reuses them. The
    // legacy parser and compiler themselves must have no external references.
    const initializers = [...definitions.matchAll(/\/lib\/(?:parse|picomatch)\.js\nvar (require_\w+) = __commonJS/g)];
    assert.equal(initializers.length, 2, "both legacy compiler entrypoints must be checked");
    for (const initializer of initializers) assert.doesNotMatch(callers, new RegExp(`\\b${initializer[1]}\\b`));
    assert.match(callers, /module2?\.exports = (?:__)?require\("@bot-thk\/glob-match"\)/);
  }
});

test("Playwright's actual bundled helpers execute the replacement for ordered and all-negative globs", async () => {
  const playwrightRequire = createRequire(require.resolve("@playwright/test"));
  const bundle = join(dirname(playwrightRequire.resolve("playwright")), "lib/matchers/expect.js");
  const source = await readFile(bundle, "utf8");
  type BundledHelpers = {
    globsToMatcher(globs: string[]): (input: string) => boolean;
    formatPath(line: string, config: { rootDir: string; testMatch: string[] }): string;
  };
  const instance = { exports: {} as BundledHelpers };
  // These Jest helpers are internal, not Playwright public exports. Execute
  // the installed bundle unchanged, adding only an isolated export probe; do
  // not modify the installed module or substitute a mock implementation.
  const execute = new Script(`(function(exports,require,module,__filename,__dirname){\n${source}\nmodule.exports={globsToMatcher:require_build7().globsToMatcher,formatPath:require_build8().formatPath};\n})`, { filename: bundle }).runInThisContext() as (
    exports: BundledHelpers, require: NodeJS.Require, module: typeof instance, filename: string, directory: string,
  ) => void;
  const engineRequire = createRequire(require.resolve("@bot-thk/glob-match/package.json"));
  const { Minimatch } = engineRequire("minimatch") as { Minimatch: { prototype: { match(input: string, partial?: boolean): boolean } } };
  const original = Minimatch.prototype.match;
  let calls = 0;
  Minimatch.prototype.match = function (input: string, partial?: boolean): boolean {
    calls++;
    return original.call(this, input, partial);
  };
  try {
    execute(instance.exports, createRequire(bundle), instance, bundle, dirname(bundle));
    const { globsToMatcher, formatPath } = instance.exports;
    const ordered = globsToMatcher(["**/*.ts", "!**/*.test.ts"]);
    assert.equal(ordered("src/index.ts"), true);
    assert.equal(ordered("src/index.test.ts"), false);
    assert.equal(ordered("src/index.css"), false);
    assert.equal(ordered("src/.private.ts"), true, "Jest deliberately defaults to dot:true");
    const negativeOnly = globsToMatcher(["!**/*.test.ts"]);
    assert.equal(negativeOnly("src/index.ts"), true);
    assert.equal(negativeOnly("src/index.test.ts"), false);
    assert.equal(globsToMatcher(["!**/*.test.ts", "**/*.ts"])("src/index.test.ts"), true);
    assert.ok(calls > 0, "the actual bundled glob helper must call the new engine");
    const beforeFormat = calls;
    assert.match(formatPath("    at example (/fixture/src/index.test.ts:1:2)", { rootDir: "/fixture", testMatch: ["**/*.test.ts"] }), /src\/index\.test\.ts/);
    assert.ok(calls > beforeFormat, "the second bundled caller must also use the replacement");
  } finally {
    Minimatch.prototype.match = original;
  }
});
