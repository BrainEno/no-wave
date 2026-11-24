import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import test from "node:test";

test("the Web image's exact health command uses its configured port, fails closed on redirects, refused/reset connections and a stalled response", async () => {
  const dockerfile = await readFile(
    new URL("../apps/web-rr/Dockerfile", import.meta.url),
    "utf8",
  );
  const command = dockerfile.match(/^\s*CMD node -e "([^"\n]+)"\s*$/m)?.[1];
  assert.ok(command);
  let mode: "ready" | "redirect" | "error" | "hang" | "reset" = "ready";
  const paths: string[] = [];
  const server = createServer((request, response) => {
    paths.push(request.url!);
    if (mode === "hang") return;
    if (mode === "reset") {
      request.socket.destroy();
      return;
    }
    response.writeHead(
      mode === "ready" ? 200 : mode === "redirect" ? 302 : 503,
      { location: "/other" },
    );
    response.end("private-health-body-canary");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const run = async (port = String(address.port)) => {
    const child = spawn(process.execPath, ["-e", command], {
      env: {
        PATH: process.env.PATH,
        PORT: port,
        AUTH_JWT_SECRET: "private-env-canary",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (data) => {
      output += String(data);
    });
    child.stderr.on("data", (data) => {
      output += String(data);
    });
    const [code] = await once(child, "close");
    assert.doesNotMatch(output, /private-/);
    return code;
  };
  try {
    assert.equal(await run(), 0);
    for (const next of ["redirect", "error", "reset", "hang"] as const) {
      mode = next;
      const began = performance.now();
      assert.equal(await run(), 1, next);
      assert.ok(performance.now() - began < 4500);
    }
    assert.ok(paths.every((path) => path === "/healthz"));
    assert.equal(await run("invalid-port"), 1);
  } finally {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  }
  assert.equal(
    await run(),
    1,
    "the stopped listener must be a failed healthcheck",
  );
});
