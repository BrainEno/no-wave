import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

type Predicate = { test(input: string): boolean; exec(input: string): RegExpExecArray | null; source?: string };
type MatchResult = { isMatch: boolean; input: string; output: string; state: { negated: boolean; negatedExtglob: boolean } };
type Matcher = { (input: string): boolean; (input: string, details: true): MatchResult; state?: MatchResult["state"] };
type GlobApi = {
  (pattern: string | string[], options?: Record<string, unknown>, state?: boolean): Matcher;
  makeRe(pattern: string, options?: Record<string, unknown>): Predicate;
  scan(pattern: string, options?: Record<string, unknown>): { base: string; glob: string; parts?: string[]; negated: boolean };
};

const rootRequire = createRequire(import.meta.url);
const stylelintRequire = createRequire(rootRequire.resolve("stylelint"));
// Stylelint 18 imports `picomatch` itself (micromatch and fast-glob left its
// tree), so that is the transitive resolution these assertions exercise.
const glob = stylelintRequire("picomatch") as GlobApi;

test("the installed transitive glob implementation does not compile the entire glob to a backtracking RegExp", () => {
  const predicate = glob.makeRe("**/*.{ts,tsx}");
  assert.equal(predicate instanceof RegExp, false, "build tools must use the non-recursive predicate, not a renamed regex compiler");
  assert.equal(predicate.test("packages/web-http/src/index.ts"), true);
  assert.equal(predicate.test("packages/web-http/src/index.css"), false);
  assert.throws(() => predicate.source, /cannot be serialized/i);
  assert.throws(() => String(predicate), /cannot be serialized/i);
});

test("the matcher keeps ordered micromatch result metadata and ignore callbacks", () => {
  const events: string[] = [];
  const matcher = glob("**/*.ts", {
    ignore: "**/*.test.ts",
    onResult: (result: MatchResult) => events.push(`result:${result.output}`),
    onMatch: (result: MatchResult) => events.push(`match:${result.output}`),
    onIgnore: (result: MatchResult) => events.push(`ignore:${result.output}`),
  }, true);
  assert.equal(matcher("src/index.ts"), true);
  const ignored = matcher("src/index.test.ts", true);
  assert.equal(ignored.isMatch, false);
  assert.equal(ignored.input, "src/index.test.ts");
  assert.deepEqual(events, ["result:src/index.ts", "match:src/index.ts", "result:src/index.test.ts", "ignore:src/index.test.ts"]);
  assert.equal(glob("!**/*.test.ts", {}, true).state?.negated, true);
  assert.equal(glob("!(*.test).ts", {}, true).state?.negatedExtglob, true);
});

test("project glob features preserve positive and negative matching", () => {
  for (const [pattern, yes, no, options] of [
    ["apps/**/*.{ts,tsx}", "apps/web-rr/app/root.tsx", "apps/web-rr/app/root.css", {}],
    ["**/+(*.test|*.spec).ts", "scripts/router.test.ts", "scripts/router.ts", {}],
    ["**/!(*.test).ts", "scripts/router.ts", "scripts/router.test.ts", {}],
    ["**/.env*", "apps/web-rr/.env.local", "apps/web-rr/env.ts", { dot: true }],
    ["**/*.ts", "src/中文.ts", "src/.private.ts", {}],
    ["*.TS", "C:\\src\\index.ts", "C:\\src\\index.css", { windows: true, nocase: true, matchBase: true }],
    ["file-{1..3}.txt", "file-2.txt", "file-4.txt", {}],
  ] as const) {
    const matcher = glob(pattern, options);
    assert.equal(matcher(yes), true, `${pattern} matches ${yes}`);
    assert.equal(matcher(no), false, `${pattern} rejects ${no}`);
    const predicate = glob.makeRe(pattern, options);
    assert.equal(predicate.test(yes), true, `makeRe facade: ${pattern}`);
    assert.equal(predicate.test(no), false, `makeRe facade rejects: ${pattern}`);
  }
});

test("pattern scanning preserves the path root and grouped slash boundaries", () => {
  const scan = glob.scan("!./packages/{web-http,web-ui}/**/*.{ts,tsx}", { parts: true });
  assert.equal(scan.base, "packages");
  assert.equal(scan.glob, "{web-http,web-ui}/**/*.{ts,tsx}");
  assert.equal(scan.negated, true);
  assert.deepEqual(scan.parts, ["packages", "{web-http,web-ui}", "**", "*.{ts,tsx}"]);
  assert.deepEqual(glob.scan("src/@(a/b|c)/*.ts", { parts: true }).parts, ["src", "@(a/b|c)", "*.ts"]);
});

test("unsupported regex-only interfaces and excessive work fail explicitly", () => {
  for (const options of [{ capture: true }, { regex: true }, { bash: true }, { flags: "g" }, { prepend: "prefix" }]) {
    assert.throws(() => glob("*.ts", options), /not support|Only the i/i);
  }
  assert.throws(() => glob("a".repeat(65_537)), /budget/);
  assert.throws(() => glob("*.ts", { maxLength: 0 }), /positive/);
  assert.throws(() => glob("needle", { contains: true })("x".repeat(513)), /budget/);
  assert.equal(glob("needle", { contains: true })("a/needle/b"), true);
  assert.equal(glob("needle", { contains: true })("a/other/b"), false);
  assert.equal(glob("!(foo)", { noext: true }, true).state?.negatedExtglob, false);
  assert.equal(glob("!(foo)", { noext: true })("!(foo)"), true);
  assert.equal(glob("**/*.ts", { nonegate: true })("src/中文.ts"), true);
  assert.equal(glob([])("src/中文.ts"), false);
});

test("character-class construction has a conservative budget without charging escaped literals", () => {
  assert.equal(glob("[a]".repeat(200))("a".repeat(200)), true);
  assert.throws(() => glob("[a]".repeat(1000)), /construction.*budget/);
  assert.equal(glob(String.raw`\[`.repeat(1000))("[".repeat(1000)), true);
});

test("dot prefixes, literal trailing slashes and negated-extglob dot rules are not widened", () => {
  assert.equal(glob("src")("src/"), false);
  assert.equal(glob("**")("./src/index.ts"), false);
  assert.equal(glob("**/*.ts")("./src/index.ts"), false);
  assert.equal(glob("**/!(*.test).ts")("src/.private.ts"), true);
  assert.equal(glob("**/!(*.test).ts")("src/.secret/index.ts"), false);
  assert.equal(glob("**/!(.private).ts")("src/.private.ts"), false);
});
