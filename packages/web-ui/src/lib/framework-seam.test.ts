import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, relative } from "node:path";
import test from "node:test";

/**
 * The shared UI names no router (ADR 0012).
 *
 * For a while it said otherwise: every component imported `next/link` or
 * `next/navigation`, and the React Router application rendered them only because
 * a build alias rewrote those specifiers behind the scenes. That is a seam held
 * shut by configuration — invisible in the code that depends on it, and one
 * deleted alias away from breaking.
 *
 * The seam is now in the code: a component imports `@/lib/framework/*`, and
 * `src/lib/framework/` is the only place in this package that may name a router.
 * What is asserted here is that the rule still holds in both directions — no
 * component has quietly started importing `react-router` — and that the seam
 * still exports what the components ask of it.
 */

const packageRoot = fileURLToPath(new URL("../../", import.meta.url));
const repositoryRoot = fileURLToPath(new URL("../../../../", import.meta.url));

/** Every `.ts`/`.tsx` file under a directory, recursively. */
function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return sources(full);
    return /\.tsx?$/.test(entry.name) ? [full] : [];
  });
}

function importsRouter(source: string): boolean {
  const code = readFileSync(source, "utf8");
  return /from\s+"(next|react-router)(\/|")/.test(code);
}

function exportedFunctions(source: string): string[] {
  return [...readFileSync(source, "utf8").matchAll(/export function (\w+)/g)].map((match) => match[1]).sort();
}

/** Relative, slash-separated path — the same on every platform. */
function named(file: string): string {
  return relative(packageRoot, file).replace(/\\/g, "/");
}

test("no shared component imports a router", () => {
  const offenders = sources(join(packageRoot, "src/components")).filter(importsRouter).map(named);
  assert.deepEqual(
    offenders,
    [],
    "shared components must import the navigation seam (`@/lib/framework/*`), not a router",
  );
});

test("the seam is the only place in src/lib that may name a router", () => {
  const offenders = sources(join(packageRoot, "src/lib"))
    .filter(importsRouter)
    .map(named)
    .filter((file) => !file.startsWith("src/lib/framework/"));
  assert.deepEqual(offenders.sort(), []);
});

test("both halves of the seam exist and are implemented with the router", () => {
  for (const file of ["link.tsx", "navigation.ts"]) {
    const seam = join(packageRoot, "src/lib/framework", file);
    assert.ok(importsRouter(seam), `the seam's ${file} is where the router is spoken, so it has to name one`);
  }
});

test("the seam exports what the components ask of it", () => {
  assert.deepEqual(exportedFunctions(join(packageRoot, "src/lib/framework/link.tsx")), ["Link"]);
  assert.deepEqual(exportedFunctions(join(packageRoot, "src/lib/framework/navigation.ts")), ["useNavigationBlocker", "usePathname", "useRouter"]);
});

/**
 * No file carries a `"use client"` / `"use server"` directive.
 *
 * Those mark a React Server Components boundary, and React Router has none: the
 * directives were left behind by the Next.js application ADR 0017 retired, and
 * every one of them cost a build warning. Rollup reports a module-level
 * directive it cannot honour ("Module level directives cause errors when
 * bundled"), cannot map that report back to source, and prints
 * `Error when using sourcemap for reporting an error` instead — twice per file,
 * once per build environment, 56 lines of noise that hid nothing until something
 * real was printed among them. The directives were dead before this test; it
 * keeps them dead.
 */
test("no source file carries a framework directive the router cannot honour", () => {
  const directive = /^\s*["']use (client|server)["']\s*;?\s*$/m;
  const offenders = ["apps", "packages"]
    .flatMap((directory) => sources(join(repositoryRoot, directory)))
    .filter((file) => directive.test(readFileSync(file, "utf8")))
    .map((file) => relative(repositoryRoot, file).replace(/\\/g, "/"));
  assert.deepEqual(offenders.sort(), [], 'a `"use client"` directive is a Next.js RSC boundary, not a React Router one');
});
