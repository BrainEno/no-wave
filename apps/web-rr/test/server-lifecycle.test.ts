import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer } from "node:net";
import { after, before, test } from "node:test";

/**
 * What a host does to this process, asserted over real HTTP and real signals.
 *
 * These are the Phase 6 properties that need a server rather than a build:
 * a cheap health-check target, one structured log line per event with no token
 * in it, and a SIGTERM that lets an accepted request finish instead of cutting
 * it off. They run against the production build with `node server.ts`, which is
 * the exact command the container image runs.
 */

const packageDir = new URL("..", import.meta.url).pathname;
const buildEntry = `${packageDir}build/server/index.js`;

type ServerHandle = {
  child: ChildProcess;
  port: number;
  baseUrl: string;
  /** Every log line the process has written, in order. */
  lines(): string[];
  records(): Record<string, unknown>[];
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function freePort(): Promise<number> {
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

async function waitForReady(baseUrl: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/healthz`);
      if (response.status === 200) return;
    } catch {
      // The socket is not up yet.
    }
    await sleep(50);
  }
  throw new Error("The server did not become ready.");
}

/** Start the production server the way the image does: `node server.ts`. */
async function startServer(extraEnv: Record<string, string> = {}): Promise<ServerHandle> {
  const port = await freePort();
  const child = spawn(process.execPath, ["server.ts"], {
    cwd: packageDir,
    env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", NODE_ENV: "production", ...extraEnv },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let buffer = "";
  const collect = (chunk: Buffer | string): void => {
    buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
  };
  child.stdout?.on("data", collect);
  child.stderr?.on("data", collect);
  const handle: ServerHandle = {
    child,
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    lines: () => buffer.split("\n").filter((line) => line.trim().length > 0),
    records: () =>
      buffer
        .split("\n")
        .filter((line) => line.trim().startsWith("{"))
        .map((line) => JSON.parse(line) as Record<string, unknown>),
  };
  await waitForReady(handle.baseUrl);
  return handle;
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<number | null> {
  return new Promise((resolve) => {
    if (child.exitCode !== null) {
      resolve(child.exitCode);
      return;
    }
    const timer = setTimeout(() => resolve(null), timeoutMs);
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

let server: ServerHandle;

before(async () => {
  assert.ok(
    existsSync(buildEntry),
    "The production build is missing. Run `pnpm --filter @bot-thk/web-rr build` first — `pnpm test:prototype` does it.",
  );
  server = await startServer();
});

after(async () => {
  if (server?.child.exitCode === null && server.child.signalCode === null) {
    server.child.kill("SIGKILL");
    await waitForExit(server.child, 5_000);
  }
});

test("the server logs one structured line when it starts listening", () => {
  const listening = server.records().filter((record) => record.event === "server_listening");
  assert.equal(listening.length, 1, `expected exactly one startup record, got ${listening.length}`);
  const record = listening[0] as Record<string, unknown>;
  assert.equal(record.component, "web-rr");
  assert.equal(record.level, "info");
  assert.equal(record.port, server.port);
  assert.equal(typeof record.pid, "number");
  assert.equal(typeof record.timestamp, "string");
  // Every line is JSON: a host collects stdout line by line and must never have
  // to guess where a record starts.
  for (const line of server.lines()) {
    assert.doesNotThrow(() => JSON.parse(line), `not a JSON log line: ${line}`);
  }
});

test("a cheap health-check target answers without rendering a page", async () => {
  const response = await fetch(`${server.baseUrl}/healthz`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  // A health check is not a page, and must not become a search result.
  assert.equal(response.headers.get("x-robots-tag"), "noindex");
  assert.deepEqual((await response.json()) as { status: string }, { status: "ok" });
});

test("every request is logged once, with its path and status", async () => {
  const before = server.records().length;
  // A 404 is the cheapest request that reaches the framework: no upstream call,
  // no rendering, and a status worth asserting.
  const response = await fetch(`${server.baseUrl}/definitely-missing`, { redirect: "manual" });
  assert.equal(response.status, 404);
  await response.text();
  await sleep(200);
  const created = server.records().slice(before);
  const completed = created.filter((record) => record.event === "http_request_completed");
  assert.equal(completed.length, 1, `expected one request record, got ${completed.length}`);
  const record = completed[0] as Record<string, unknown>;
  assert.equal(record.method, "GET");
  assert.equal(record.path, "/definitely-missing");
  assert.equal(record.status, 404);
  assert.equal(typeof record.durationMs, "number");
});

test("a token in the query string never reaches a log line", async () => {
  const token = "lifecycle-test-reset-token-abcdef";
  const response = await fetch(`${server.baseUrl}/reset-password?token=${token}`, { redirect: "manual" });
  await response.text();
  await sleep(200);
  const paths = server
    .records()
    .filter((record) => record.event === "http_request_completed")
    .map((record) => String(record.path));
  assert.ok(
    paths.includes("/reset-password"),
    `expected the path to be logged without its query string, saw ${paths.join(", ")}`,
  );
  for (const line of server.lines()) {
    assert.equal(line.includes(token), false, "a reset token reached the log");
  }
});

test("SIGTERM lets an accepted request finish and then exits cleanly", async () => {
  // An upstream that takes its time, so the Web tier has a request genuinely in
  // flight: accepted, proxied, not answered yet. That is the state a host
  // interrupts when it sends SIGTERM to a process it wants to replace.
  const upstreamPort = await freePort();
  const upstream = createHttpServer((_request, response) => {
    setTimeout(() => {
      response.writeHead(201, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: { id: "slow-upstream" } }));
    }, 700);
  });
  await new Promise<void>((resolve) => upstream.listen(upstreamPort, "127.0.0.1", () => resolve()));

  const handle = await startServer({ API_BASE_URL: `http://127.0.0.1:${upstreamPort}` });
  const inFlightRequest = fetch(`${handle.baseUrl}/api/authoring/articles`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: handle.baseUrl },
    body: '{"title":"x"}',
  });
  await sleep(300);

  const startedAt = Date.now();
  handle.child.kill("SIGTERM");
  await sleep(100);

  const started = handle.records().find((record) => record.event === "server_shutdown_started");
  assert.ok(started, "shutdown did not log that it started");
  assert.equal(
    Number(started.inFlight) >= 1,
    true,
    `the in-flight request was not counted: inFlight=${String(started.inFlight)}`,
  );

  // The request that was already accepted is allowed to finish.
  const response = await inFlightRequest;
  assert.equal(response.status, 201, "the in-flight request was cut instead of completed");

  const exitCode = await waitForExit(handle.child, 10_000);
  const elapsed = Date.now() - startedAt;
  assert.equal(exitCode, 0, "a graceful stop exits 0");
  assert.ok(elapsed < 8_000, `shutdown took ${elapsed} ms, past the grace window`);

  const complete = handle.records().find((record) => record.event === "server_shutdown_complete");
  assert.ok(complete, "shutdown did not log that it finished");
  assert.equal(complete.signal, "SIGTERM");
  assert.equal(complete.forced, false, "the in-flight request should not have had to be cut");
  assert.equal(complete.inFlight, 0);

  upstream.close();
});
