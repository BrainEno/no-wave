import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { discoverTests, nodeTestArguments } from "./test-discovery.ts";

const root = new URL("../../", import.meta.url).pathname;
test("new nested tests are discovered and executed without editing any package manifest", async () => {
  const directory = await mkdtemp(join(tmpdir(), "nw-test-discovery-"));
  try {
    const folder = join(directory, "packages/web-http/test/nested");
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, "new-feature.test.ts"), 'import test from "node:test"; test("automatic discovery witness", () => {});\n');
    const files = discoverTests("root", directory);
    assert.deepEqual(files, ["packages/web-http/test/nested/new-feature.test.ts"]);
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const result = spawnSync(process.execPath, nodeTestArguments("root", directory, false), { cwd: directory, env, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /automatic discovery witness/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("API unit/integration partition is exhaustive, disjoint and includes intentional cross-Web PostgreSQL journeys", () => {
  const all = discoverTests("root", root).filter(file => file.startsWith("apps/api/src/"));
  const unit = discoverTests("api-unit", root), integration = discoverTests("api-integration", root);
  const combined = [...unit, ...integration].filter(file => file.startsWith("apps/api/src/"));
  assert.deepEqual(combined.sort(), all);
  assert.equal(new Set([...unit, ...integration]).size, unit.length + integration.length);
  assert.ok(integration.includes("apps/web-rr/test/refresh-shared.integration.test.ts"));
  assert.ok(integration.includes("apps/web-rr/test/refresh-shared-web.test.ts"));
  assert.ok(integration.includes("apps/api/src/transport/rest/article-collection.integration.test.ts"));
  assert.ok(unit.includes("apps/api/src/transport/rest/json-encoding.test.ts"));
  for (const group of ["root", "api-unit", "api-integration", "web"] as const) {
    const args = nodeTestArguments(group, root);
    assert.ok(args.includes("--test-concurrency=1"));
    assert.ok(args.includes("--test-reporter=spec"));
    assert.equal(args.filter(value => value === "--test-reporter-destination=stdout").length, 2);
    assert.ok(args.some(value => value.endsWith("/scripts/github-test-reporter.ts")));
  }
});

// Regression snapshot only: adding a new test never requires editing this file.
test("every historical integration and unit journey retains its original group", async () => {
  const baseline = JSON.parse(await readFile(new URL("./test-groups.fixture.json", import.meta.url), "utf8")) as Record<"api-unit" | "api-integration", string[]>;
  for (const group of ["api-unit", "api-integration"] as const) {
    const files = new Set(discoverTests(group, root));
    for (const file of baseline[group]) assert.ok(files.has(file), `${file} lost its intentional ${group} assignment`);
  }
});
