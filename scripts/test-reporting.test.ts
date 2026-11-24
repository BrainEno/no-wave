import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { testArguments } from "./test-all.ts";

const root = new URL("../", import.meta.url);

test("root and integration scripts retain readable output plus GitHub failure annotations in test:all", async () => {
  for (const [file, name] of [
    ["package.json", "test"],
    ["apps/api/package.json", "test:integration"],
  ] as const) {
    const manifest = JSON.parse(
      await readFile(new URL(file, root), "utf8"),
    ) as { scripts: Record<string, string> };
    const args = testArguments(manifest.scripts[name]!);
    assert.ok(args.includes("--test-reporter=spec"));
    assert.ok(
      args.some((arg) => arg.endsWith("/scripts/github-test-reporter.ts")),
    );
    assert.equal(
      args.filter((arg) => arg === "--test-reporter-destination=stdout").length,
      2,
    );
    assert.ok(args.includes("--test-concurrency=1"));
    assert.ok(args.some((arg) => arg.endsWith(".test.ts")));
  }
});

test("a failing Node test still exits nonzero and emits its actual name and assertion for check annotations", async () => {
  const directory = await mkdtemp(join(tmpdir(), "nw-test-reporting-"));
  try {
    const file = join(directory, "failure.test.ts");
    await writeFile(
      file,
      'import test from "node:test"; import assert from "node:assert/strict"; test("visible failure witness", () => assert.equal("observed", "required"));\n',
    );
    const env: NodeJS.ProcessEnv = { ...process.env, GITHUB_ACTIONS: "true" };
    delete env.NODE_TEST_CONTEXT;
    const result = spawnSync(
      process.execPath,
      [
        "--test",
        "--test-reporter=spec",
        "--test-reporter-destination=stdout",
        `--test-reporter=${new URL("github-test-reporter.ts", import.meta.url).pathname}`,
        "--test-reporter-destination=stdout",
        file,
      ],
      { encoding: "utf8", env },
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stdout, /visible failure witness/);
    assert.match(result.stdout, /::error/);
    assert.match(result.stdout, /observed/);
    assert.match(result.stdout, /required/);
    assert.match(result.stdout, /fail 1/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
