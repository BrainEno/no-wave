import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { createDevSupervisor, type DevRole } from "./dev-supervisor.ts";

const env = { PATH: process.env.PATH, NODE_NO_WARNINGS: "1" };
const alive =
  "process.on('SIGTERM',()=>process.exit(0));console.log('started');setInterval(()=>{},1000)";
async function until(predicate: () => boolean): Promise<void> {
  const deadline = performance.now() + 5000;
  while (!predicate() && performance.now() < deadline) await delay(10);
  assert.ok(predicate(), "the real child must reach the expected state");
}
function fixture(
  options: Partial<Parameters<typeof createDevSupervisor>[0]> = {},
) {
  const output: Array<{ role: DevRole; line: string }> = [];
  const messages: string[] = [];
  const supervisor = createDevSupervisor({
    info: (line) => messages.push(line),
    error: (line) => messages.push(line),
    output: (role, line) => {
      output.push({ role, line });
    },
    graceMs: 300,
    forceMs: 1000,
    ...options,
  });
  const launch = (role: DevRole, source = alive) =>
    supervisor.launch({
      role,
      label: role,
      args: ["-e", source],
      cwd: process.cwd(),
      env,
    });
  return { supervisor, output, messages, launch };
}

test("any unexpected exit, including exit zero, stops and reaps all three supervised roles with a failing command status", async () => {
  const f = fixture();
  const api = f.launch("api"),
    web = f.launch("web"),
    worker = f.launch("worker", "setTimeout(()=>process.exit(0),150)");
  try {
    assert.equal(await f.supervisor.stopped, 1);
    assert.equal((await api.exited).code, 0);
    assert.equal((await web.exited).code, 0);
    assert.equal((await worker.exited).code, 0);
    assert.match(f.messages.join("\n"), /worker exited unexpectedly/);
    assert.throws(() => f.launch("worker"), /unexpectedly/);
  } finally {
    await f.supervisor.stop(1);
  }
});

test("Node watch mode cannot hide a crashed application behind a live watcher", async () => {
  const directory = await mkdtemp(join(tmpdir(), "nw-watch-failure-"));
  const entry = join(directory, "crashes.ts");
  await writeFile(
    entry,
    "setTimeout(() => { throw new Error('fixture failure'); }, 80);\n",
  );
  const f = fixture();
  const peer = f.launch("worker");
  const watched = f.supervisor.launch({
    role: "api",
    label: "Watched API",
    cwd: directory,
    args: ["--watch", "--watch-preserve-output", entry],
    env,
  });
  try {
    assert.equal(await f.supervisor.stopped, 1);
    await peer.exited;
    await watched.exited;
    assert.match(f.messages.join("\n"), /stopped behind its watcher/);
    assert.ok(f.output.some((row) => /Failed running/.test(row.line)));
  } finally {
    await f.supervisor.stop(1);
    await rm(directory, { recursive: true, force: true });
  }
});

test(
  "a watched child that ignores termination is force-reaped with its process tree inside the supervisor budget",
  {
    skip:
      process.platform === "win32" &&
      "POSIX group-reaping assertion; Windows uses taskkill /T.",
  },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "nw-watch-hang-"));
    const entry = join(directory, "hangs.ts");
    await writeFile(
      entry,
      "process.on('SIGTERM',()=>{});console.log('started '+process.pid);setInterval(()=>{},1000);\n",
    );
    const f = fixture();
    const item = f.supervisor.launch({
      role: "worker",
      label: "Stuck worker",
      cwd: directory,
      args: ["--watch", "--watch-preserve-output", entry],
      env,
    });
    try {
      await until(() =>
        f.output.some((row) => row.line.startsWith("started ")),
      );
      const applicationPid = Number(
        f.output
          .find((row) => row.line.startsWith("started "))!
          .line.split(" ")[1],
      );
      const began = performance.now();
      assert.equal(await f.supervisor.stop(0), 1);
      assert.ok(performance.now() - began < 1800);
      assert.equal((await item.exited).signal, "SIGKILL");
      await until(() => {
        try {
          process.kill(applicationPid, 0);
          return false;
        } catch {
          return true;
        }
      });
    } finally {
      await f.supervisor.stop(1);
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test("readiness waits are cancelled promptly when the peer process fails", async () => {
  const server = createServer(() => {});
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const f = fixture();
  const api = f.launch("api");
  const waiting = f.supervisor.waitForHttp(
    api,
    `http://127.0.0.1:${address.port}/ready`,
    10_000,
    "ready",
  );
  try {
    await until(() =>
      f.output.some((row) => row.role === "api" && row.line === "started"),
    );
    const began = performance.now();
    f.launch("worker", "process.exit(2)");
    await assert.rejects(waiting, /exited unexpectedly/);
    assert.equal(await f.supervisor.stopped, 1);
    assert.ok(performance.now() - began < 1800);
  } finally {
    await f.supervisor.stop(1);
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  }
});

test("startup errors reap existing peers and explicit stop remains idempotent", async () => {
  const f = fixture({
    processExecutable: join(tmpdir(), "no-wave-does-not-exist-node"),
  });
  f.launch("api");
  assert.equal(await f.supervisor.stopped, 1);
  const first = f.supervisor.stop(1),
    second = f.supervisor.stop(0);
  assert.equal(first, second);
  assert.equal(await first, 1);
  const healthy = fixture();
  const api = healthy.launch("api");
  try {
    assert.throws(() => healthy.launch("api"), /already supervised/);
    await until(() => healthy.output.some((row) => row.line === "started"));
    assert.equal(await healthy.supervisor.stop(), 0);
    assert.equal((await api.exited).code, 0);
  } finally {
    await healthy.supervisor.stop();
  }
});

test("an apparently alive role cannot stay silently unready after startup or hot reload", async () => {
  const server = createServer((_request, response) => {
    response.writeHead(503);
    response.end("private-response-canary");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const f = fixture();
  const api = f.launch("api"),
    worker = f.launch("worker");
  try {
    f.supervisor.monitor(api, `http://127.0.0.1:${address.port}/ready`, {
      intervalMs: 20,
      outageMs: 100,
      requestTimeoutMs: 40,
    });
    assert.equal(await f.supervisor.stopped, 1);
    await worker.exited;
    assert.match(f.messages.join("\n"), /readiness interrupted/);
    assert.match(f.messages.join("\n"), /did not recover/);
    assert.doesNotMatch(f.messages.join("\n"), /private-response-canary/);
  } finally {
    await f.supervisor.stop(1);
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  }
});

test("transient readiness gaps recover without killing a healthy hot-reloading service", async () => {
  let unavailable = true;
  const server = createServer((_request, response) => {
    response.writeHead(unavailable ? 503 : 200, {
      "content-type": "application/json",
    });
    response.end(JSON.stringify({ status: "ready", service: "api" }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const f = fixture();
  const api = f.launch("api");
  try {
    await until(() => f.output.some((row) => row.line === "started"));
    f.supervisor.monitor(api, `http://127.0.0.1:${address.port}/ready`, {
      intervalMs: 20,
      outageMs: 300,
      requestTimeoutMs: 40,
    });
    await until(() =>
      f.messages.some((line) => line.includes("readiness interrupted")),
    );
    unavailable = false;
    await until(() =>
      f.messages.some((line) => line.includes("readiness recovered")),
    );
    assert.equal(f.supervisor.failure, null);
    assert.equal(await f.supervisor.stop(), 0);
  } finally {
    await f.supervisor.stop();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  }
});

test("only explicitly declared CLI signal-exit conventions are accepted during a requested stop", async () => {
  for (const declared of [false, true]) {
    const f = fixture();
    const item = f.supervisor.launch({
      role: "web",
      label: "CLI",
      args: [
        "-e",
        "process.on('SIGTERM',()=>process.exit(143));console.log('started');setInterval(()=>{},1000)",
      ],
      cwd: process.cwd(),
      env,
      ...(declared ? { acceptableStopExitCodes: [143] } : {}),
    });
    try {
      await until(() => f.output.some((row) => row.line === "started"));
      assert.equal(await f.supervisor.stop(), declared ? 0 : 1);
      assert.equal((await item.exited).code, 143);
    } finally {
      await f.supervisor.stop();
    }
  }
});

for (const closeOutput of [false, true]) {
  test(
    `a killed watch shell cannot orphan its real HTTP application (${closeOutput ? "closed" : "inherited"} output pipes)`,
    {
      skip:
        process.platform === "win32" &&
        "POSIX watch-shell/process-group fault injection.",
    },
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "nw-watch-orphan-"));
      const entry = join(directory, "serves.ts");
      await writeFile(
        entry,
        `import {createServer} from 'node:http';
const server=createServer((_request,response)=>response.end('alive'));
server.listen(0,'127.0.0.1',()=>console.log('app-ready '+server.address().port));
process.on('SIGTERM',()=>{});
${closeOutput ? "setTimeout(()=>{process.stdout.end();process.stderr.end();},50);" : ""}\n`,
      );
      const f = fixture();
      const peer = f.launch("api");
      const watcher = f.supervisor.launch({
        role: "worker",
        label: "Watched HTTP worker",
        cwd: directory,
        args: ["--watch", "--watch-preserve-output", entry],
        env,
      });
      let port: number | undefined;
      try {
        await until(() =>
          f.output.some((row) => row.line.startsWith("app-ready ")),
        );
        port = Number(
          f.output
            .find((row) => row.line.startsWith("app-ready "))!
            .line.split(" ")[1],
        );
        assert.equal((await fetch(`http://127.0.0.1:${port}`)).status, 200);
        if (closeOutput) await delay(100);
        watcher.child.kill("SIGKILL");
        const code = await Promise.race([
          f.supervisor.stopped,
          delay(2200, undefined, { ref: false }).then(() => {
            throw new Error(
              "The watch shell exited but the supervisor never stopped its HTTP application.",
            );
          }),
        ]);
        assert.equal(code, 1);
        await peer.exited;
        await watcher.exited;
        await assert.rejects(
          fetch(`http://127.0.0.1:${port}`, {
            signal: AbortSignal.timeout(500),
          }),
        );
        assert.match(f.messages.join("\n"), /exited unexpectedly/);
      } finally {
        await f.supervisor.stop(1);
        // A failed red assertion must not leave the deliberately orphaned group.
        if (watcher.child.pid) {
          try {
            process.kill(-watcher.child.pid, "SIGKILL");
          } catch {
            /* already gone */
          }
        }
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
}
