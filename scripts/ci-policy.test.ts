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
  for (const job of ["verify", "postgres-integration", "local-dev-chain", "react-router-prototype", "portable-stack", "container-image", "e2e", "full-local-suite"]) {
    assert.match(workflow, new RegExp(`^  ${job}:`, "m"), `missing job ${job}`);
    const gate = workflow.slice(workflow.indexOf("  required-checks:"));
    assert.match(gate, new RegExp(`^      - ${job}$`, "m"), `gate must depend on ${job}`);
  }
});

test("the required verify job audits all locked dependencies at high severity", () => {
  const verify = workflow.slice(workflow.indexOf("  verify:"), workflow.indexOf("  postgres-integration:"));
  const install = verify.indexOf("pnpm install --frozen-lockfile");
  const audit = verify.indexOf("pnpm audit --audit-level high");
  assert.ok(install >= 0 && audit > install);
  const line = verify.split("\n").find((entry) => entry.includes("pnpm audit")) ?? "";
  assert.doesNotMatch(line, /--prod|--no-optional|\|\||continue-on-error/);
  const gate = workflow.slice(workflow.indexOf("  required-checks:"));
  assert.match(gate, /needs\.verify\.result/);
  assert.match(gate, /\"\$VERIFY_RESULT\"/);
});

test("CodeQL runs on PRs and main with explicit minimal permissions", () => {
  const codeql = readFileSync(new URL(".github/workflows/codeql.yml", root), "utf8");
  assert.match(codeql, /pull_request:\s*\n\s*branches: \["main"\]/);
  assert.match(codeql, /push:\s*\n\s*branches: \["main"\]/);
  assert.match(codeql, /contents: read/);
  assert.match(codeql, /security-events: write/);
  assert.match(codeql, /github\/codeql-action\/init@v4/);
  assert.match(codeql, /github\/codeql-action\/analyze@v4/);
  assert.match(codeql, /languages: javascript-typescript/);
  assert.doesNotMatch(codeql, /pull_request_target|continue-on-error/);
});

test("Dependabot groups weekly workspace and action updates", () => {
  const config = readFileSync(new URL(".github/dependabot.yml", root), "utf8");
  assert.match(config, /package-ecosystem: npm/);
  assert.match(config, /package-ecosystem: github-actions/);
  assert.equal((config.match(/interval: weekly/g) ?? []).length, 2);
  assert.equal((config.match(/patterns:\s*\n\s*- "\*"/g) ?? []).length, 2);
});

test("the security policy does not invite public vulnerability disclosure", () => {
  const policy = readFileSync(new URL("SECURITY.md", root), "utf8");
  assert.match(policy, /do not put exploit details/i);
  assert.match(policy, /private vulnerability reporting/i);
  assert.match(policy, /does not enable it/i);
  assert.match(policy, /No response or remediation timeline is promised/i);
});

test("repository publishes the Apache 2.0 license and links it from both READMEs", () => {
  const license = readFileSync(new URL("LICENSE", root), "utf8");
  assert.match(license, /Apache License\s+Version 2\.0, January 2004/);
  assert.match(license, /TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION/);
  assert.match(license, /END OF TERMS AND CONDITIONS/);
  for (const name of ["README.md", "README.zh-CN.md"]) {
    const readme = readFileSync(new URL(name, root), "utf8");
    assert.match(readme, /\]\(LICENSE\)/, `${name} must link to the repository license`);
    assert.match(readme, /Apache License(?:, Version)? 2\.0/);
  }
});

test("security reporting guidance is reachable from the main README", () => {
  const readme = readFileSync(new URL("README.md", root), "utf8");
  const policy = readFileSync(new URL("SECURITY.md", root), "utf8");
  assert.match(readme, /\]\(SECURITY\.md\)/);
  assert.match(policy, /security\/advisories\/new/);
  assert.match(policy, /do not publish the\s+vulnerability/i);
});
