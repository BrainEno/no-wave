/**
 * Shared harness for the Web behaviour suites (`apps/web-rr/test/web*.test.ts`).
 * It starts one production Web server and one mock REST API per suite file;
 * `registerPublicWebApp()` registers that lifecycle. Not a test file: node:test
 * discovers only `*.test.ts`.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { createServer } from "node:net";
import { after, before } from "node:test";
import { MOCK_TOKENS, startMockRestApi } from "../../mocks/rest-api.ts";
import type { MockRestApi } from "../../mocks/rest-api.ts";

export const packageDir = new URL("../..", import.meta.url).pathname;

export const buildEntry = `${packageDir}build/server/index.js`;

export let mockApi: MockRestApi;

export let app: ChildProcess;

export let baseUrl = "";

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (address === null || typeof address === "string") {
        probe.close();
        reject(new Error("Could not reserve a port."));
        return;
      }
      const { port } = address;
      probe.close(() => resolve(port));
    });
  });
}

export async function waitForServer(url: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { redirect: "manual" });
      await response.text();
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error(`The Web server did not become ready at ${url}.`);
}

export type Result = { status: number; headers: Headers; body: string };

export async function get(pathname: string, headers: Record<string, string> = {}): Promise<Result> {
  const response = await fetch(`${baseUrl}${pathname}`, { headers, redirect: "manual" });
  return { status: response.status, headers: response.headers, body: await response.text() };
}

export async function post(pathname: string, body: string, headers: Record<string, string> = {}): Promise<Result> {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: "POST",
    body,
    headers: { "content-type": "application/json", origin: baseUrl, ...headers },
    redirect: "manual",
  });
  return { status: response.status, headers: response.headers, body: await response.text() };
}

export async function patch(pathname: string, body: string, headers: Record<string, string> = {}): Promise<Result> {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: "PATCH",
    body,
    headers: { "content-type": "application/json", origin: baseUrl, ...headers },
    redirect: "manual",
  });
  return { status: response.status, headers: response.headers, body: await response.text() };
}

export async function del(pathname: string, headers: Record<string, string> = {}): Promise<Result> {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: "DELETE",
    headers: { origin: baseUrl, ...headers },
    redirect: "manual",
  });
  return { status: response.status, headers: response.headers, body: await response.text() };
}

/** A write with no body at all, which is what restoring a work is. */
export async function postEmpty(pathname: string, headers: Record<string, string> = {}): Promise<Result> {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: "POST",
    headers: { origin: baseUrl, ...headers },
    redirect: "manual",
  });
  return { status: response.status, headers: response.headers, body: await response.text() };
}

export async function put(pathname: string, body: string, headers: Record<string, string> = {}): Promise<Result> {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: "PUT",
    body,
    headers: { "content-type": "application/json", origin: baseUrl, ...headers },
    redirect: "manual",
  });
  return { status: response.status, headers: response.headers, body: await response.text() };
}

/**
 * Boot the same build on another port with extra environment, run a check, stop.
 *
 * The switches under test are read at request time, so a second process is the
 * only honest way to show the same build behaving differently.
 */
export async function withEnvServer(extra: Record<string, string>, run: (url: string) => Promise<void>): Promise<void> {
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["server.ts"], {
    cwd: packageDir,
    env: {
      ...process.env,
      NODE_ENV: "production",
      PORT: String(port),
      HOST: "127.0.0.1",
      API_BASE_URL: mockApi.url,
      API_SERVICE_URL: "",
      SITE_URL: "https://no-wave.example",
      ...extra,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    await waitForServer(`${url}/`);
    await run(url);
  } finally {
    await new Promise<void>((resolve) => {
      if (child.exitCode !== null) { resolve(); return; }
      child.once("exit", () => resolve());
      child.kill("SIGTERM");
    });
  }
}

/**
 * Boot the same build on another port with `MAIL_ENABLED=true`.
 *
 * The switch is read at request time, so flipping it must not require a rebuild
 * — and this is the assertion that says so, over HTTP, against the production
 * build. The suite's own server runs without the variable, which is the default.
 */
export async function withMailEnabledServer(run: (url: string) => Promise<void>): Promise<void> {
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["server.ts"], {
    cwd: packageDir,
    env: {
      ...process.env,
      NODE_ENV: "production",
      PORT: String(port),
      HOST: "127.0.0.1",
      API_BASE_URL: mockApi.url,
      API_SERVICE_URL: "",
      SITE_URL: "https://no-wave.example",
      MAIL_ENABLED: "true",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    await waitForServer(`${url}/`);
    await run(url);
  } finally {
    await new Promise<void>((resolve) => {
      if (child.exitCode !== null) { resolve(); return; }
      child.once("exit", () => resolve());
      child.kill("SIGTERM");
    });
  }
}

/**
 * Public SSR routes migrated in Phase 3: archive, author, category index/detail
 * and search.
 *
 * The assertions are the migration contract, not markup snapshots:
 *
 *   1. server-rendered (the content is in the first response, no JS required);
 *   2. localized by path, with canonical/hreflang metadata;
 *   3. unknown entities are hard 404s;
 *   4. shared caching is allowed only where the HTML is public;
 *   5. each page costs at most **two** API calls — the budget that keeps a
 *      0.1-CPU, cold-starting instance responsive.
 */

export async function upstreamCalls(pathname: string): Promise<string[]> {
  mockApi.resetRequests();
  await get(pathname);
  return mockApi.requests().filter((entry) => entry.includes("/api/v1/"));
}

/**
 * The home page is the one page allowed three calls, and it is worth saying
 * why: its shelves (the editor's pick, the newest, the most saved) are three
 * different upstream queries that cannot be folded into each other — "most
 * saved" is a server-side ordering over every work ever saved, not something
 * the page can derive from the newest. The genre columns (ADR 0054) are drawn
 * from the same newest window as the "latest" row, so they cost nothing extra.
 * The calls are issued together, so the page pays the slowest of them, not the
 * sum.
 *
 * Search is allowed three, for the same reason in miniature: it is three tabs,
 * each fed by the endpoint that owns its domain — works, authors, categories —
 * and none of them can be derived from another. That used to be two because the
 * author tab was a by-product of the works; finding a writer by name costs the
 * call it always should have.
 *
 * Every other page is two, and the directory is one.
 */
export const API_CALL_BUDGET: ReadonlyArray<readonly [string, number]> = [
  ["/", 3],
  ["/articles", 2],
  ["/articles?q=抵抗", 2],
  ["/authors", 1],
  ["/authors?q=林可行", 1],
  ["/authors/writer", 2],
  ["/categories", 1],
  ["/categories/essays", 2],
  ["/search?q=portable", 3],
];

/**
 * The writing desk (Phase 4b).
 *
 * `AuthoringWorkspace` is a shared client component, so the desk renders in both
 * frameworks — what it needs from the framework is the API it calls. These tests
 * drive that API over real HTTP against the production build: a signed-out desk
 * must be told it is signed out, a signed-in one must be able to read its own
 * work, and writing twice must update one article rather than create two.
 */
export const DESK_COOKIE = `nw_access=${MOCK_TOKENS.accessToken}`;

export function editorStateOf(text: string): unknown {
  return {
    root: {
      children: [
        {
          children: [{ detail: 0, format: 0, mode: "normal", style: "", text, type: "text", version: 1 }],
          direction: "ltr",
          format: "",
          indent: 0,
          type: "paragraph",
          version: 1,
        },
      ],
      direction: "ltr",
      format: "",
      indent: 0,
      type: "root",
      version: 1,
    },
  };
}

export function articleBody(title: string, publish = false): string {
  return JSON.stringify({
    title,
    summary: "",
    locale: "zh-CN",
    workType: "other",
    editorState: editorStateOf(`${title} 的第一段，用来验证保存链路。`),
    contentBlocksVersion: 1,
    publish,
  });
}

/** Raw responses are needed here: fetch transparently inflates encoded bodies. */
export function wire(path: string, headers: Record<string, string> = {}, method = "GET"): Promise<{ status: number; headers: import("node:http").IncomingHttpHeaders; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(new URL(path, baseUrl), { method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end();
  });
}

export function registerPublicWebApp(): void {
  before(async () => {
    assert.ok(
      existsSync(buildEntry),
      "The Web application must be built before its tests run: pnpm --filter @bot-thk/web-rr build",
    );
    mockApi = await startMockRestApi();
    const port = await freePort();
    baseUrl = `http://127.0.0.1:${port}`;
    app = spawn(process.execPath, ["server.ts"], {
      cwd: packageDir,
      env: {
        ...process.env,
        NODE_ENV: "production",
        PORT: String(port),
        HOST: "127.0.0.1",
        API_BASE_URL: mockApi.url,
        // Prove the Vercel-only binding is not required for a working deployment.
        API_SERVICE_URL: "",
        // Short enough for the stalled-upstream test to finish quickly, long
        // enough that every ordinary mock answer stays inside the budget.
        API_TIMEOUT_MS: "1200",
        SITE_URL: "https://no-wave.example",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const errors: string[] = [];
    app.stderr?.on("data", (chunk: Buffer) => errors.push(chunk.toString()));
    app.once("exit", (code) => {
      if (code !== 0 && errors.length > 0) process.stderr.write(`web-rr exited ${code}:\n${errors.join("")}`);
    });
    await waitForServer(`${baseUrl}/`);
  });

  after(async () => {
    await new Promise<void>((resolve) => {
      if (!app || app.exitCode !== null) {
        resolve();
        return;
      }
      app.once("exit", () => resolve());
      app.kill("SIGTERM");
    });
    await mockApi?.close();
  });
}
