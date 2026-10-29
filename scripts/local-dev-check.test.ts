import assert from "node:assert/strict";
import test from "node:test";
import { formatReport, runLocalChecks } from "./local-dev-check.ts";

// `--api-only` is used by CI and by container workflows that probe a running API
// with no Web server at all. It regressed once: the Web auth proxy step still ran
// and failed with ECONNREFUSED, which broke every `--api-only` run.

const unreachable = "http://127.0.0.1:1";

test("--api-only never probes the Web origin", async () => {
  const { results } = await runLocalChecks({
    apiBaseUrl: unreachable,
    webBaseUrl: unreachable,
    apiOnly: true,
    readOnly: false,
    timeoutMs: 2_000,
  });

  const webSteps = results.filter((result) => result.id.startsWith("web-"));
  assert.deepEqual(webSteps.map((result) => result.id), ["web-auth-proxy", "web-render", "web-comment-proxy"]);
  for (const step of webSteps) {
    assert.equal(step.status, "skip", `${step.id} must be skipped in --api-only mode`);
  }
});

test("--read-only skips every write probe but keeps the Web reads", async () => {
  const { results } = await runLocalChecks({
    apiBaseUrl: unreachable,
    webBaseUrl: unreachable,
    apiOnly: false,
    readOnly: true,
    timeoutMs: 2_000,
  });

  const byId = new Map(results.map((result) => [result.id, result]));
  for (const id of ["auth-register", "profile-write", "article-publish", "web-auth-proxy"]) {
    assert.equal(byId.get(id)?.status, "skip", `${id} must be skipped in --read-only mode`);
  }
  assert.equal(byId.has("web-render"), true);
  assert.equal(byId.has("web-comment-proxy"), true);
});

test("a failed layer is reported, counted, and ordered below the healthy layers", async () => {
  const { results, failed } = await runLocalChecks({
    apiBaseUrl: unreachable,
    webBaseUrl: unreachable,
    apiOnly: true,
    readOnly: false,
    timeoutMs: 1_000,
  });

  assert.ok(failed > 0);
  assert.equal(results[0]?.id, "api-health");
  assert.equal(results[0]?.status, "fail");
  assert.match(formatReport(results, { apiOnly: true }), /Fix the \[FAIL\] entries first/);
});

test("the summary names the layers that were actually checked", async () => {
  const apiOnlyReport = formatReport(
    [{ id: "api-health", title: "API liveness", status: "pass", detail: "200 OK", durationMs: 1 }],
    { apiOnly: true, apiBaseUrl: "http://127.0.0.1:4000" },
  );
  assert.match(apiOnlyReport, /database -> API\./);
  assert.doesNotMatch(apiOnlyReport, /Web/);

  const fullReport = formatReport(
    [{ id: "api-health", title: "API liveness", status: "pass", detail: "200 OK", durationMs: 1 }],
    { apiBaseUrl: "http://127.0.0.1:4000", webBaseUrl: "http://127.0.0.1:3000" },
  );
  assert.match(fullReport, /database -> API -> Web -> browser-facing proxy\./);
  assert.match(fullReport, /web {2}http:\/\/127\.0\.0\.1:3000/);
});
