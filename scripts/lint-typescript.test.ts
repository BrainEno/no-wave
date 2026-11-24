import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { LINTED_ROOTS, projectCoverage } from "./lint-typescript.ts";

test("a file no project claims, or two projects claim, is reported instead of skipped", () => {
  const globs = ["apps/api/**/*.ts", "apps/**/*.ts"];
  assert.deepEqual(
    projectCoverage(
      [
        "apps/api/src/a.ts",
        "apps/web/b.ts",
        "packages/x/c.tsx",
        "README.md",
        "apps/api/src/types.d.ts",
        "docs/d.ts",
      ],
      globs,
    ),
    { unowned: ["packages/x/c.tsx"], ambiguous: ["apps/api/src/a.ts"] },
  );
});

test("every tracked TypeScript file CI lints belongs to exactly one project", () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const listed = spawnSync("git", ["ls-files", "-z", ...LINTED_ROOTS], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(listed.status, 0, listed.stderr);
  assert.deepEqual(projectCoverage(listed.stdout.split("\0").filter(Boolean)), {
    unowned: [],
    ambiguous: [],
  });
});
