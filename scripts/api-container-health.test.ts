import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { after, before, test } from "node:test";

/**
 * Exercise the exact command embedded in the image without needing Docker.
 * CI additionally builds the image and waits for Docker's real health status.
 */
let probe: string;
let server: Server;
let port: number;
let nextStatus = 200;
let nextMode: "reply" | "hang" | "reset" = "reply";
let observed: string[] = [];

before(async () => {
  const dockerfile = await readFile(new URL("../apps/api/Dockerfile", import.meta.url), "utf8");
  const match = dockerfile.match(/^\s*CMD node -e "([^"\n]+)"\s*$/m);
  assert.ok(match, "the Docker healthcheck has an executable Node probe");
  probe = match[1]!;
  server = createServer((req, res) => {
    observed.push(`${req.method} ${req.url}`);
    if (nextMode === "reset") {
      req.socket.destroy();
      return;
    }
    if (nextMode === "hang") return;
    res.writeHead(nextStatus, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: nextStatus === 200 ? "ok" : "unavailable" }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  port = address.port;
});

after(async () => {
  server.close();
  server.closeAllConnections();
  await once(server, "close");
});

function runProbe(env: Record<string, string> = {}): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", probe], {
      env: { PATH: process.env.PATH, PORT: String(port), ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

test("a successful readiness response makes the container probe succeed", async () => {
  observed = [];
  nextMode = "reply";
  nextStatus = 200;
  const result = await runProbe();
  assert.equal(result.code, 0);
  assert.equal(result.stdout, "");
  assert.deepEqual(observed, ["GET /ready"]);
});

test("2xx responses are accepted and readiness failures are rejected", async () => {
  nextMode = "reply";
  for (const [status, expected] of [[204, 0], [401, 1], [404, 1], [500, 1], [503, 1]] as const) {
    nextStatus = status;
    observed = [];
    const result = await runProbe();
    assert.equal(result.code, expected, `status ${status}`);
    assert.deepEqual(observed, ["GET /ready"]);
  }
});

test("connection refusal and a reset fail rather than hanging or succeeding", async () => {
  nextMode = "reset";
  nextStatus = 200;
  assert.equal((await runProbe()).code, 1);
  // Reserve and release a port so that no service is listening on it.
  const temporary = createServer();
  temporary.listen(0, "127.0.0.1");
  await once(temporary, "listening");
  const address = temporary.address();
  assert.ok(address && typeof address !== "string");
  temporary.close();
  await once(temporary, "close");
  assert.equal((await runProbe({ PORT: String(address.port) })).code, 1);
});

test("a stalled readiness endpoint is bounded by the probe timeout", async () => {
  nextMode = "hang";
  const started = Date.now();
  const result = await runProbe();
  assert.equal(result.code, 1);
  assert.ok(Date.now() - started < 5000, "a stalled probe must not block health indefinitely");
  nextMode = "reply";
});

test("an invalid port fails closed without exposing environment values", async () => {
  const result = await runProbe({ PORT: "not-a-port", AUTH_JWT_SECRET: "test-private-value" });
  assert.equal(result.code, 1);
  assert.doesNotMatch(result.stdout + result.stderr, /test-private-value/);
});
