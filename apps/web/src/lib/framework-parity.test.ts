import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, relative } from "node:path";
import test from "node:test";

/**
 * The shared UI names no framework (ADR 0012).
 *
 * `apps/web/src/components` is rendered by two applications, and for a while it
 * said so in the wrong place: every component imported `next/link` or
 * `next/navigation`, and the React Router prototype worked only because a build
 * alias rewrote those specifiers behind the scenes. That is a seam held shut by
 * configuration — invisible in the code that depends on it, and one deleted
 * alias away from breaking.
 *
 * These assertions move the seam into the code. A component now imports
 * `@/lib/framework/*`, which is a contract *this* application owns; Next.js and
 * React Router are two implementations of it. What is asserted here is that the
 * contract is honoured in both directions and that no component has quietly gone
 * back to naming a framework.
 *
 * Two files may still mention Next.js, and the test names them rather than
 * ignoring them: the contract's own Next.js implementation, and the App Router's
 * route-proxy helper — which is a route adapter like `app/api/**`, not shared
 * UI, and would only be shared if the prototype stopped having its own.
 */

const webRoot = fileURLToPath(new URL("../../", import.meta.url));
const prototypeRoot = fileURLToPath(new URL("../../../web-rr/", import.meta.url));

/** Every `.ts`/`.tsx` file under a directory, recursively. */
function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return sources(full);
    return /\.tsx?$/.test(entry.name) ? [full] : [];
  });
}

function importsFramework(source: string): boolean {
  return /from\s+"next(\/|")/.test(readFileSync(source, "utf8"));
}

/** The symbols a module re-exports, e.g. `export { usePathname, useRouter } from "…"`. */
function reExported(source: string): string[] {
  const found = /export\s*{([^}]*)}\s*from/.exec(readFileSync(source, "utf8"));
  if (!found) return [];
  return found[1].split(",").map((name) => name.trim().split(/\s+as\s+/).pop() ?? "").filter(Boolean).sort();
}

const ALLOWED = ["src/lib/framework/link.tsx", "src/lib/framework/navigation.ts", "src/lib/authoring-proxy.ts"];

test("no shared component imports Next.js", () => {
  const offenders = sources(join(webRoot, "src/components")).filter(importsFramework);
  assert.deepEqual(
    offenders.map((file) => relative(webRoot, file)),
    [],
    "shared components must import the navigation seam, not a framework",
  );
});

test("the only files allowed to name Next.js are the ones the test names", () => {
  const offenders = sources(join(webRoot, "src/lib")).filter(importsFramework)
    .map((file) => relative(webRoot, file).replace(/\\/g, "/"));
  assert.deepEqual(offenders.sort(), [...ALLOWED].sort());
});

test("both halves of the seam exist and are implemented without the other one", () => {
  for (const file of ["link.tsx", "navigation.ts"]) {
    const nextImpl = join(webRoot, "src/lib/framework", file);
    const routerImpl = join(prototypeRoot, "app/framework", file);
    assert.ok(importsFramework(nextImpl), `the Next.js implementation of ${file} has to import Next.js`);
    assert.equal(importsFramework(routerImpl), false, `the React Router implementation of ${file} must not`);
  }
});

test("the two implementations export the same symbols", () => {
  for (const file of ["link.tsx", "navigation.ts"]) {
    const nextImpl = reExported(join(webRoot, "src/lib/framework", file));
    const routerImpl = (() => {
      const source = readFileSync(join(prototypeRoot, "app/framework", file), "utf8");
      return [...source.matchAll(/export function (\w+)/g)].map((match) => match[1]).sort();
    })();
    assert.deepEqual(
      routerImpl,
      nextImpl,
      `${file}: an implementation that exports something the other does not is a contract drift`,
    );
  }
});
