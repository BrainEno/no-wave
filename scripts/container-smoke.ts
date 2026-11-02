/**
 * One container smoke contract for GitHub Actions and GitLab CI.
 *
 * The CI files own Docker (building images, starting them, stopping them). This
 * script owns only the observable HTTP contract, so the copy that used to drift
 * between `.github/workflows/ci.yml` and `.gitlab-ci.yml` has one home.
 *
 * It deliberately imports nothing from the workspace: GitLab copies this file
 * into the Web container, whose runtime image has Node 24 but not the scripts'
 * dev dependencies. Node's built-in `fetch` is enough.
 *
 * Environment:
 *   SMOKE_WEB_URL            Web origin (default http://127.0.0.1:3100).
 *   SMOKE_API_URL            Optional API origin; when set, /health and /ready
 *                            must answer 200 before the Web probes.
 *   SMOKE_EXPECT_FIXTURES    "true" asserts the local fixture article; the
 *                            GitHub Actions image pair runs against a real,
 *                            freshly migrated API and leaves it false.
 *   SMOKE_TIMEOUT_MS         Readiness timeout (default 60000).
 */
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";

const webUrl = normalizeBase(process.env.SMOKE_WEB_URL ?? "http://127.0.0.1:3100");
const apiUrlValue = process.env.SMOKE_API_URL?.trim();
const apiUrl = apiUrlValue ? normalizeBase(apiUrlValue) : null;
const expectFixtures = process.env.SMOKE_EXPECT_FIXTURES === "true";
const timeoutMs = positiveInteger(process.env.SMOKE_TIMEOUT_MS, 60_000);
const requestTimeoutMs = 5_000;
const retryDelayMs = 250;

function normalizeBase(value: string): string {
  return value.replace(/\/+$/, "");
}

function positiveInteger(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

async function request(url: string, expectedStatus?: number): Promise<string> {
  const response = await fetch(url, {
    redirect: "manual",
    signal: AbortSignal.timeout(requestTimeoutMs),
  });
  if (expectedStatus !== undefined) {
    assert.equal(response.status, expectedStatus, `${url} should answer ${expectedStatus}`);
  }
  return response.text();
}

async function waitForStatus(url: string, status: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastStatus: number | null = null;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, {
        redirect: "manual",
        signal: AbortSignal.timeout(requestTimeoutMs),
      });
      lastStatus = response.status;
      await response.arrayBuffer().catch(() => {});
      if (response.status === status) return;
    } catch (error: unknown) {
      lastError = error;
    }
    await delay(retryDelayMs);
  }
  const reason = lastError instanceof Error ? lastError.message : String(lastError ?? "");
  throw new Error(
    `${url} did not answer ${status} within ${timeoutMs} ms` +
      (lastStatus === null ? "" : ` (last status ${lastStatus})`) +
      (reason ? `: ${reason}` : ""),
  );
}

async function run(): Promise<void> {
  if (apiUrl) {
    await waitForStatus(`${apiUrl}/health`, 200);
    await waitForStatus(`${apiUrl}/ready`, 200);
  }
  await waitForStatus(`${webUrl}/healthz`, 200);

  const home = await request(`${webUrl}/`, 200);
  assert.match(home, /lang="zh-CN"/, "the default home must declare Simplified Chinese");
  assert.match(home, /文学作品的数字出版空间/, "the default home must render its current copy");
  assert.match(home, /class="nw-pill"/, "the server-rendered site chrome is missing");
  assert.match(home, /class="nw-footer"/, "the server-rendered footer is missing");

  const english = await request(`${webUrl}/en`, 200);
  assert.match(english, /lang="en"/, "the English home must declare its language");

  await request(`${webUrl}/definitely-missing`, 404);

  // A malformed percent escape is a bad request, never a 500 from the static
  // asset handler, and the process must still answer health checks afterwards.
  await request(`${webUrl}/%E0%A4%A.js`, 400);
  await request(`${webUrl}/assets/%c0%af.js`, 400);
  await request(`${webUrl}/healthz`, 200);

  if (expectFixtures) {
    const article = await request(`${webUrl}/articles/portable-web-foundation`, 200);
    assert.match(article, /rel="canonical"/, "the fixture article should render canonical metadata");
    await request(`${webUrl}/articles/does-not-exist`, 404);
  }

  console.log(JSON.stringify({
    event: "container_smoke_passed",
    webUrl,
    apiUrl: apiUrl ?? null,
    expectFixtures,
  }));
}

try {
  await run();
} catch (error: unknown) {
  const errorName = error instanceof Error && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(error.name)
    ? error.name
    : "Error";
  const errorMessage = error instanceof Error ? error.message.slice(0, 500) : "Unknown error";
  console.error(JSON.stringify({ event: "container_smoke_failed", errorName, errorMessage }));
  process.exitCode = 1;
}
