import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseDockerPort, runSuite, safeEnvironment, testArguments } from "./test-all.ts";
import type { Command, CommandResult, SuiteOptions } from "./test-all.ts";

const require = createRequire(import.meta.url);
const { checkNodeVersion } = require("./preflight.cjs") as {
  checkNodeVersion(version: string): { ok: boolean; message: string };
};
const ok: CommandResult = { code: 0, stdout: "", stderr: "" };

test("preflight runs without dependencies and provides actionable Node instructions", () => {
  for (const version of ["v22.23.4", "v23.9.0", "v25.0.0", "invalid", "24"]) {
    const result = checkNodeVersion(version);
    assert.equal(result.ok, false, version);
    assert.match(result.message, /Node.js 24.x is required/);
    assert.match(result.message, /corepack enable.*pnpm install/);
  }
  for (const version of ["v24.0.0", "24.15.0", "v24.22.1", "v24.0.0-rc.1"]) {
    assert.equal(checkNodeVersion(version).ok, true, version);
  }
  const cli = spawnSync(process.execPath, [new URL("./preflight.cjs", import.meta.url).pathname], { encoding: "utf8" });
  assert.equal(cli.status, 0);
  assert.match(cli.stdout, /satisfies the 24.x requirement/);
});

test("the suite uses the package inventories without loading local env files or interpreting shell", () => {
  assert.deepEqual(testArguments("node --env-file-if-exists=.env.local --test --test-concurrency=1 a.test.ts b.test.ts"), ["--test", "--test-concurrency=1", "a.test.ts", "b.test.ts"]);
  assert.deepEqual(testArguments("node --env-file-if-exists=../../.env --test one.test.ts"), ["--test", "one.test.ts"]);
  for (const unsafe of ["pnpm test", "node one.test.ts", "node --test a.test.ts && rm -rf /", "node --test $(whoami)", "node --test test/*.test.ts"]) {
    assert.throws(() => testArguments(unsafe), /Test script|Unsupported/);
  }
});

test("port parsing only accepts an explicitly loopback-bound valid port", () => {
  assert.equal(parseDockerPort("127.0.0.1:12345\n"), 12345);
  for (const value of ["", "0.0.0.0:5432", "[::]:5432", "127.0.0.1:0", "127.0.0.1:65536", "127.0.0.1:5432\n0.0.0.0:5432", "postgres:5432"]) {
    assert.throws(() => parseDockerPort(value), /loopback/);
  }
});

test("only safe OS and browser environment reaches child test processes", () => {
  const clean = safeEnvironment({
    PATH: "/bin", HOME: "/home/test", PLAYWRIGHT_BROWSERS_PATH: "/browser", CI: "1",
    DATABASE_URL: "postgres://production", TEST_DATABASE_URL: "postgres://prod-tests",
    E2E_WEB_URL: "https://production", MAIL_HOST: "mail", AUTH_JWT_SECRET: "secret", DOCKER_HOST: "host",
  });
  assert.equal(clean.PATH, "/bin");
  assert.equal(clean.PLAYWRIGHT_BROWSERS_PATH, "/browser");
  for (const key of ["DATABASE_URL", "TEST_DATABASE_URL", "E2E_WEB_URL", "MAIL_HOST", "AUTH_JWT_SECRET", "DOCKER_HOST"]) {
    assert.equal(clean[key], undefined, key);
  }
});

type Fixture = {
  options: SuiteOptions;
  calls: Command[];
  logs: string[];
  dispose(): Promise<void>;
};

async function fixture(handler?: (command: Command) => CommandResult | Promise<CommandResult>): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "nw-test-all-test-"));
  await mkdir(join(root, "node_modules"));
  await writeFile(join(root, "node_modules/.modules.yaml"), "installed");
  const chromiumPath = join(root, "chromium");
  await writeFile(chromiumPath, "browser");
  const calls: Command[] = [];
  const logs: string[] = [];
  const execute = async (command: Command): Promise<CommandResult> => {
    calls.push(command);
    if (handler) return handler(command);
    if (command.executable === "docker" && command.args[0] === "port") return { ...ok, stdout: "127.0.0.1:45678\n" };
    return ok;
  };
  const options: SuiteOptions = {
    root, node: "/node", pnpmCli: "/pnpm/cli.js", chromiumPath,
    env: { PATH: "/bin", DATABASE_URL: "postgres://production", TEST_DATABASE_URL: "postgres://production-test", E2E_WEB_URL: "https://production", DOCKER_HOST: "unix:///custom/docker.sock" },
    rootTest: "node --env-file-if-exists=.env.local --test --test-concurrency=1 root.test.ts",
    integrationTest: "node --env-file-if-exists=../../.env --test pg.test.ts",
    webTests: ["test/web.test.ts", "test/server.test.ts"],
    containerName: "no-wave-test-unique", password: "temporary-password",
    execute, cleanup: execute, pause: async () => {}, log: (line) => logs.push(line),
  };
  return { options, calls, logs, dispose: () => rm(root, { recursive: true, force: true }) };
}

test("all layers run in order against a private disposable database and clean up", async () => {
  const f = await fixture();
  try {
    await runSuite(f.options);
    const describe = f.calls.map((call) => `${call.executable} ${call.args.join(" ")}`);
    assert.match(describe[0]!, /^docker info/);
    assert.match(describe[1]!, /^\/node --test /);
    assert.match(describe[2]!, /\/pnpm\/cli.js --filter @bot-thk\/web-rr build/);
    assert.match(describe[3]!, /--test test\/web.test.ts test\/server.test.ts/);
    assert.match(describe[4]!, /^docker run --detach --rm --name no-wave-test-unique/);
    assert.match(describe[4]!, /127\.0\.0\.1::5432/);
    assert.match(describe[5]!, /^docker port /);
    assert.match(describe[6]!, /^docker exec .* pg_isready/);
    assert.match(describe[7]!, /^\/node --test pg.test.ts/);
    assert.match(describe[8]!, /^docker rm -f no-wave-test-unique/);
    assert.match(describe[9]!, /scripts\/e2e-runner.ts/);
    assert.equal(f.calls[7]!.env.TEST_DATABASE_URL, "postgres://postgres:temporary-password@127.0.0.1:45678/no_wave_test");
    for (const [index, call] of f.calls.entries()) {
      assert.equal(call.env.DATABASE_URL, undefined, `command ${index}`);
      assert.equal(call.env.E2E_WEB_URL, undefined, `command ${index}`);
      if (index !== 7) assert.equal(call.env.TEST_DATABASE_URL, undefined, `command ${index}`);
      if (call.executable !== "docker") assert.equal(call.env.DOCKER_HOST, undefined, `command ${index}`);
    }
    assert.match(f.logs.at(-1)!, /All layers passed/);
    assert.ok(!f.logs.join("\n").includes("temporary-password"));
  } finally { await f.dispose(); }
});

test("missing dependencies and browser fail before Docker or test processes start", async () => {
  const f = await fixture();
  try {
    await rm(join(f.options.root, "node_modules/.modules.yaml"));
    await assert.rejects(runSuite(f.options), /pnpm install/);
    assert.equal(f.calls.length, 0);
    await writeFile(join(f.options.root, "node_modules/.modules.yaml"), "installed");
    await rm(f.options.chromiumPath);
    await assert.rejects(runSuite(f.options), /pnpm test:e2e:install/);
    assert.equal(f.calls.length, 0);
  } finally { await f.dispose(); }
});

test("Docker errors fail preflight before running tests", async () => {
  const f = await fixture(() => ({ code: 1, stdout: "", stderr: "daemon unavailable" }));
  try {
    await assert.rejects(runSuite(f.options), /Docker is unavailable/);
    assert.equal(f.calls.length, 1);
  } finally { await f.dispose(); }
});

test("root, build and web failures stop before creating a database", async () => {
  for (const failingIndex of [1, 2, 3]) {
    let count = 0;
    const f = await fixture(() => count++ === failingIndex ? { ...ok, code: 2 } : ok);
    try {
      await assert.rejects(runSuite(f.options), /failed/);
      assert.equal(f.calls.some((call) => call.executable === "docker" && call.args[0] === "run"), false);
      assert.equal(f.calls.some((call) => call.args.includes("pg.test.ts")), false);
    } finally { await f.dispose(); }
  }
});

test("failed PostgreSQL tests clean only the owned container and do not run E2E", async () => {
  const f = await fixture((command) => {
    if (command.args[0] === "port") return { ...ok, stdout: "127.0.0.1:1234" };
    if (command.args.includes("pg.test.ts")) return { ...ok, code: 4 };
    return ok;
  });
  try {
    await assert.rejects(runSuite(f.options), /PostgreSQL integration tests failed/);
    assert.deepEqual(f.calls.at(-1)!.args, ["rm", "-f", "no-wave-test-unique"]);
    assert.ok(!f.calls.some((call) => call.args.some((arg) => arg.endsWith("e2e-runner.ts"))));
  } finally { await f.dispose(); }
});

test("the readiness wait retries and fails closed after its bound", async () => {
  const f = await fixture((command) => {
    if (command.args[0] === "port") return { ...ok, stdout: "127.0.0.1:1234" };
    if (command.args[0] === "exec") return { ...ok, code: 1 };
    return ok;
  });
  try {
    await assert.rejects(runSuite(f.options), /did not become ready/);
    assert.equal(f.calls.filter((call) => call.args[0] === "exec").length, 60);
    assert.deepEqual(f.calls.at(-1)!.args, ["rm", "-f", "no-wave-test-unique"]);
  } finally { await f.dispose(); }
});

test("malformed or non-loopback Docker port output triggers cleanup before integration", async () => {
  const f = await fixture((command) => command.args[0] === "port" ? { ...ok, stdout: "0.0.0.0:5432" } : ok);
  try {
    await assert.rejects(runSuite(f.options), /loopback/);
    assert.deepEqual(f.calls.at(-1)!.args, ["rm", "-f", "no-wave-test-unique"]);
    assert.ok(!f.calls.some((call) => call.args.includes("pg.test.ts")));
  } finally { await f.dispose(); }
});

test("failed cleanup cannot be mistaken for a successful full run", async () => {
  const f = await fixture((command) => {
    if (command.args[0] === "port") return { ...ok, stdout: "127.0.0.1:1234" };
    if (command.args[0] === "rm") return { ...ok, code: 1 };
    return ok;
  });
  try {
    await assert.rejects(runSuite(f.options), /Unable to remove disposable PostgreSQL/);
    assert.equal(f.calls.at(-1)!.args[0], "inspect");
  } finally { await f.dispose(); }
});

test("an absent container after failed start is not a cleanup failure", async () => {
  const f = await fixture((command) => {
    if (command.args[0] === "run") return { ...ok, code: 1 };
    if (command.args[0] === "rm" || command.args[0] === "inspect") return { code: 1, stdout: "", stderr: "Error: No such container" };
    return ok;
  });
  try {
    await assert.rejects(runSuite(f.options), /Unable to start disposable PostgreSQL/);
    assert.equal(f.calls.at(-1)!.args[0], "inspect");
    assert.ok(!f.logs.some((line) => line.includes("Cleanup failed")));
  } finally { await f.dispose(); }
});

test("a failed browser suite is reported after the database has been removed", async () => {
  const f = await fixture((command) => {
    if (command.args[0] === "port") return { ...ok, stdout: "127.0.0.1:1234" };
    if (command.args.some((arg) => arg.endsWith("e2e-runner.ts"))) return { ...ok, code: 1 };
    return ok;
  });
  try {
    await assert.rejects(runSuite(f.options), /Browser tests failed/);
    assert.equal(f.calls.at(-2)!.args[0], "rm");
    assert.ok(!f.logs.some((line) => line.includes("All layers passed")));
  } finally { await f.dispose(); }
});
