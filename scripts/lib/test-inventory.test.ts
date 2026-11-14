import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { parse } from "@babel/parser";
import test from "node:test";

/**
 * Every test file must be reachable from a script that actually runs it (audit
 * F-13).
 *
 * The suites are hard-coded lists of paths (the root `test` script) or package
 * globs (`node --test test/*.test.ts`). Both shapes fail the same way: a new
 * file is added, nothing runs it, and the suite reports green without it. This
 * guard turns that silence into a failure.
 */

const repositoryRoot = new URL("../..", import.meta.url).pathname;

/** Directories whose contents are generated, installed or historical. */
const SKIPPED_DIRECTORIES = new Set([
  ".git",
  "node_modules",
  "build",
  "dist",
  "coverage",
  ".react-router",
  ".turbo",
  ".arena",
]);

function listTestFiles(directory: string, found: string[] = []): string[] {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
      listTestFiles(join(directory, entry.name), found);
      continue;
    }
    if (entry.name.endsWith(".test.ts")) found.push(relative(repositoryRoot, join(directory, entry.name)));
  }
  return found;
}

type TestScript = { packagePath: string; script: string; args: string[] };

/** Every `test` script in the workspace, with the arguments it passes to node. */
function testScripts(): TestScript[] {
  const packages = [
    "package.json",
    "apps/api/package.json",
    "apps/web-rr/package.json",
    "packages/web-http/package.json",
    "packages/web-ui/package.json",
  ];
  const scripts: TestScript[] = [];
  for (const packagePath of packages) {
    if (!existsSync(join(repositoryRoot, packagePath))) continue;
    const manifest = JSON.parse(readFileSync(join(repositoryRoot, packagePath), "utf8")) as {
      scripts?: Record<string, string>;
    };
    const script = manifest.scripts?.test;
    if (!script) continue;
    scripts.push({
      packagePath,
      script,
      args: script.split(/\s+/).filter((token) => token.includes(".test.ts")),
    });
  }
  return scripts;
}

/** Expand the one glob shape the scripts use: `<directory>/*.test.ts`. */
function expandArgument(packagePath: string, argument: string): string[] {
  const packageRoot = join(repositoryRoot, packagePath, "..");
  const absolute = join(packageRoot, argument);
  if (!argument.includes("*")) return [relative(repositoryRoot, absolute)];
  const directory = relative(repositoryRoot, join(absolute, ".."));
  if (SKIPPED_DIRECTORIES.has(directory.split("/").pop() ?? "")) return [];
  let entries: string[];
  try {
    entries = readdirSync(join(repositoryRoot, directory));
  } catch {
    return [];
  }
  return entries.filter((name) => name.endsWith(".test.ts")).map((name) => join(directory, name));
}

test("every test file is named by a script that runs it", () => {
  const scripts = testScripts();
  assert.ok(scripts.length > 0, "no test script was found; the guard would pass vacuously");

  const covered = new Set<string>();
  for (const { packagePath, args } of scripts) {
    for (const argument of args) {
      for (const file of expandArgument(packagePath, argument)) covered.add(file);
    }
  }

  const unreachable = listTestFiles(repositoryRoot).filter((file) => !covered.has(file));
  assert.deepEqual(
    unreachable,
    [],
    `these test files are never executed by a test script:\n${unreachable.join("\n")}`,
  );
});

test("a test script does not name a file that no longer exists", () => {
  // The root list once pointed at `scripts/local-dev-config.test.ts` after the
  // file moved. A missing explicit path is worse than a missing new one: it
  // breaks the whole invocation on some Node versions and is silently skipped on
  // others, which is how four files stopped running unnoticed.
  const missing = testScripts().flatMap(({ packagePath, args }) =>
    args
      .filter((argument) => !argument.includes("*"))
      .map((argument) => expandArgument(packagePath, argument))
      .flat()
      .filter((file) => !existsSync(join(repositoryRoot, file))),
  );
  assert.deepEqual(missing, [], `test scripts name files that do not exist:\n${missing.join("\n")}`);
});


test("every browser suite and extended stack is rooted in the enforcing CSP audit fixture", () => {
  const directory = join(repositoryRoot, "e2e");
  const fixture = join(directory, "support/csp-fixture.ts");
  const cache = new Map<string, ReturnType<typeof parse>>();
  const tree = (file: string) => {
    if (!cache.has(file)) cache.set(file, parse(readFileSync(file, "utf8"), { sourceType: "module", plugins: ["typescript"] }));
    return cache.get(file)!;
  };
  const reachesAudit = (file: string, seen = new Set<string>()): boolean => {
    if (file === fixture) return true;
    if (seen.has(file)) return false;
    seen.add(file);
    for (const statement of tree(file).program.body) {
      if (statement.type !== "ImportDeclaration" || statement.importKind === "type") continue;
      const importsTest = statement.specifiers.some(specifier => specifier.type === "ImportSpecifier" && specifier.importKind !== "type" &&
        specifier.imported.type === "Identifier" && specifier.imported.name === "test");
      if (!importsTest) continue;
      assert.ok(statement.source.value.startsWith("."), `${relative(repositoryRoot, file)} bypasses the automatic CSP audit`);
      if (reachesAudit(resolve(file, "..", statement.source.value), seen)) return true;
    }
    return false;
  };
  const suites = readdirSync(directory).filter(name => name.endsWith(".spec.ts"));
  assert.ok(suites.length >= 30, "the suite inventory must not pass on an empty directory");
  for (const suite of suites) assert.equal(reachesAudit(join(directory, suite)), true, suite);
  for (const file of [...suites.map(name => join(directory, name)), ...readdirSync(join(directory, "support")).filter(name => name.endsWith(".ts")).map(name => join(directory, "support", name))]) {
    if (file === fixture) continue;
    for (const statement of tree(file).program.body) {
      if (statement.type !== "ImportDeclaration" || statement.source.value !== "@playwright/test" || statement.importKind === "type") continue;
      for (const specifier of statement.specifiers) {
        assert.equal(specifier.type, "ImportSpecifier", `${file}: namespace/default imports can hide an unaudited test`);
        if (specifier.type === "ImportSpecifier" && specifier.importKind !== "type" && specifier.imported.type === "Identifier") {
          assert.notEqual(specifier.imported.name, "test", `${file}: extend csp-fixture rather than the unobserved Playwright base`);
        }
      }
    }
  }
});
