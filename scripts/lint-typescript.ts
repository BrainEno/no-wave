/**
 * `pnpm lint:typescript`: ESLint with type information, one TypeScript project
 * per process.
 *
 * Type-aware rules make the parser hold a full TypeScript program in memory,
 * and ESLint keeps every program it has built until the process exits. Linting
 * all seven projects in one process ran out of heap at about 2 GB; one process
 * per project stays well below that and is no slower in total. A runner that
 * splits work this way could also drop files on the floor, so it first proves
 * that every tracked TypeScript file belongs to exactly one project.
 */
import { spawn, spawnSync } from "node:child_process";
import { availableParallelism, totalmem } from "node:os";
import { matchesGlob } from "node:path";
import { fileURLToPath } from "node:url";
import { typescriptProjects } from "./lint-projects.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const eslint = fileURLToPath(
  new URL("../node_modules/eslint/bin/eslint.js", import.meta.url),
);

/** The directories CI lints; every TypeScript file in them must be in a project. */
export const LINTED_ROOTS = ["apps/", "packages/", "scripts/", "e2e/"];

export type Coverage = { unowned: string[]; ambiguous: string[] };

/** Which tracked files no project, or more than one project, would lint. */
export function projectCoverage(
  files: readonly string[],
  globs: readonly string[] = Object.keys(typescriptProjects),
): Coverage {
  const unowned: string[] = [];
  const ambiguous: string[] = [];
  for (const file of files) {
    if (!/\.tsx?$/.test(file) || /\.d\.ts$/.test(file)) continue;
    if (!LINTED_ROOTS.some((prefix) => file.startsWith(prefix))) continue;
    const owners = globs.filter((glob) => matchesGlob(file, glob));
    if (owners.length === 0) unowned.push(file);
    else if (owners.length > 1) ambiguous.push(file);
  }
  return { unowned, ambiguous };
}

function trackedFiles(): string[] {
  const listed = spawnSync("git", ["ls-files", "-z", ...LINTED_ROOTS], {
    cwd: root,
    encoding: "utf8",
  });
  if (listed.status !== 0) {
    throw new Error(`git ls-files failed: ${listed.stderr}`);
  }
  return listed.stdout.split("\0").filter(Boolean);
}

function run(args: string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        eslint,
        "--flag",
        "unstable_native_nodejs_ts_config",
        "--no-inline-config",
        "--max-warnings",
        "0",
        ...args,
      ],
      { cwd: root, stdio: "inherit" },
    );
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve(signal ? 1 : (code ?? 1)));
  });
}

async function main(): Promise<number> {
  const { unowned, ambiguous } = projectCoverage(trackedFiles());
  if (unowned.length || ambiguous.length) {
    for (const file of unowned) {
      process.stderr.write(`no TypeScript project lints ${file}\n`);
    }
    for (const file of ambiguous) {
      process.stderr.write(`more than one project claims ${file}\n`);
    }
    process.stderr.write(
      "Map each directory to exactly one project in scripts/lint-projects.ts.\n",
    );
    return 1;
  }
  // The configuration file belongs to no project; it is linted without types.
  const jobs = [...Object.keys(typescriptProjects), "eslint.config.ts"];
  // About one program per 2 GB: the largest (web-ui) peaks a little over 1 GB.
  const width =
    Number(process.env.LINT_CONCURRENCY) ||
    Math.max(
      1,
      Math.min(availableParallelism(), Math.floor(totalmem() / 2 ** 31)),
    );
  let failed = 0;
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(width, jobs.length) }, async () => {
      while (next < jobs.length) {
        const glob = jobs[next++]!;
        if ((await run([glob])) !== 0) failed++;
      }
    }),
  );
  return failed ? 1 : 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await main();
}
