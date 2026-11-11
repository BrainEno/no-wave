import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const root = new URL("..", import.meta.url);
const workflow = readFileSync(new URL(".github/workflows/ci.yml", root), "utf8");

test("CI avoids duplicate branch pushes but covers PRs and main", () => {
  const triggers = workflow.slice(workflow.indexOf("on:"), workflow.indexOf("concurrency:"));
  assert.match(triggers, /push:\s*\n\s*branches: \["main"\]/);
  assert.match(triggers, /pull_request:\s*\n\s*branches: \["main"\]/);
  assert.doesNotMatch(triggers, /\*\*/);
});

test("PR runs cancel only older runs in their own PR group", () => {
  const concurrency = workflow.slice(workflow.indexOf("concurrency:"), workflow.indexOf("permissions:"));
  assert.match(concurrency, /group: \$\{\{ github\.workflow \}\}-\$\{\{ github\.event\.pull_request\.number \|\| github\.ref \}\}/);
  assert.match(concurrency, /cancel-in-progress: \$\{\{ github\.event_name == 'pull_request' \}\}/);
});

test("there is one documented required CI gate, not an incomplete second pipeline", () => {
  assert.equal(existsSync(new URL(".gitlab-ci.yml", root)), false);
  const readme = readFileSync(new URL("README.md", root), "utf8");
  assert.match(readme, /only supported CI pipeline/);
  for (const job of ["verify", "postgres-integration", "local-dev-chain", "react-router-prototype", "portable-stack", "container-image", "e2e"]) {
    assert.match(workflow, new RegExp(`^  ${job}:`, "m"), `missing job ${job}`);
    const gate = workflow.slice(workflow.indexOf("  required-checks:"));
    assert.match(gate, new RegExp(`^      - ${job}$`, "m"), `gate must depend on ${job}`);
  }
});
