import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Resolve the React Router CLI from the Web workspace's own installed
 * dependencies.
 *
 * `spawn("pnpm", …)` only works when a global pnpm shim happens to be on PATH;
 * `node scripts/verify-publish.ts` on a machine that only enabled corepack
 * fails with ENOENT before the build starts. Running the local CLI with
 * `process.execPath` removes that platform dependency while keeping the same
 * `react-router build` / `react-router dev` entry point.
 *
 * The executable's file name comes from the package's own `bin` field rather
 * than being spelled out here: React Router 8 renamed it from `bin.js` to
 * `bin.cjs`, and a hard-coded name turns that rename into a stack that silently
 * resolves to a file which does not exist.
 */
export function resolveWebBuildCli(root: string): string {
  const requireFromWeb = createRequire(pathToFileURL(join(root, "apps/web-rr", "package.json")));
  const packageJson = requireFromWeb.resolve("@react-router/dev/package.json");
  const manifest = JSON.parse(readFileSync(packageJson, "utf8")) as { bin?: string | Record<string, string> };
  const declared = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.["react-router"];
  if (!declared) throw new Error("@react-router/dev does not declare a react-router CLI in its package manifest.");
  return join(dirname(packageJson), declared);
}
