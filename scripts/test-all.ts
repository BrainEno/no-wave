/**
 * Run the complete local test stack against a uniquely named disposable Docker
 * PostgreSQL and the existing isolated E2E runner. Never use the developer's
 * TEST_DATABASE_URL, compose volume, or external E2E endpoints.
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { INHERITED_VARIABLES } from "./portable-stack.ts";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
export type CommandResult = { code: number; stdout: string; stderr: string };
export type Command = { executable: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv; capture?: boolean };
export type Execute = (command: Command) => Promise<CommandResult>;

/** Avoid accidental production credentials, external databases and live URLs. */
export function safeEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const allowed = [...INHERITED_VARIABLES, "PLAYWRIGHT_BROWSERS_PATH", "LD_LIBRARY_PATH", "CI"];
  const env: NodeJS.ProcessEnv = {};
  for (const name of allowed) if (source[name] !== undefined) env[name] = source[name];
  return env;
}

/**
 * Use the same inventory as the package scripts but omit their env-file flags:
 * a local .env must not silently direct this destructive suite at a real DB.
 * Reject unexpected syntax rather than trying to interpret shell commands.
 */
export function testArguments(script: string): string[] {
  const tokens = script.trim().split(/\s+/);
  if (tokens.shift() !== "node") throw new Error("Test script must start with node.");
  const args = tokens.filter((token) => !token.startsWith("--env-file-if-exists="));
  if (!args.includes("--test") || args.some((token) => /[;&|`$<>*]/.test(token))) {
    throw new Error("Unsupported test script syntax; update test-all's safe inventory parser.");
  }
  return args;
}

/** Docker publishes a random loopback port to avoid conflicts and remote access. */
export function parseDockerPort(output: string): number {
  const match = /^127\.0\.0\.1:(\d+)\s*$/.exec(output.trim());
  const port = Number(match?.[1]);
  if (!match || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("Docker did not report a loopback PostgreSQL port.");
  }
  return port;
}

export function makeExecute(signal: AbortSignal): Execute {
  return async ({ executable, args, cwd, env, capture }) => new Promise((resolvePromise, reject) => {
    const child = spawn(executable, args, {
      cwd, env, signal, stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
      windowsHide: true,
    });
    let stdout = "", stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.once("error", reject);
    child.once("close", (code) => resolvePromise({ code: code ?? 1, stdout, stderr }));
  });
}

export type SuiteOptions = {
  root: string;
  env: NodeJS.ProcessEnv;
  node: string;
  pnpmCli: string;
  rootTest: string;
  integrationTest: string;
  webTests: string[];
  chromiumPath: string;
  containerName: string;
  password: string;
  execute: Execute;
  cleanup: Execute;
  pause: (ms: number) => Promise<void>;
  log: (message: string) => void;
};

async function requireSuccess(execute: Execute, command: Command, message: string): Promise<CommandResult> {
  let result: CommandResult;
  try { result = await execute(command); }
  catch (error) {
    throw new Error(`${message}: ${error instanceof Error ? error.message : "unable to start"}`);
  }
  if (result.code !== 0) throw new Error(`${message} (exit ${result.code}).`);
  return result;
}

/** Separated from CLI for deterministic tests of failures and cleanup. */
export async function runSuite(options: SuiteOptions): Promise<void> {
  const { root: cwd, node, pnpmCli, execute, cleanup, pause, log } = options;
  const base = safeEnvironment(options.env);
  const dockerEnv = { ...base };
  for (const key of ["DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_CONFIG", "DOCKER_TLS_VERIFY", "DOCKER_CERT_PATH"]) {
    if (options.env[key] !== undefined) dockerEnv[key] = options.env[key];
  }
  const capture = (executable: string, args: string[]): Command => ({ executable, args, cwd, env: dockerEnv, capture: true });
  const run = (executable: string, args: string[], env: NodeJS.ProcessEnv = base): Command => ({ executable, args, cwd, env });
  if (!existsSync(join(cwd, "node_modules", ".modules.yaml"))) {
    throw new Error("Dependencies are missing. Run: corepack enable && pnpm install --frozen-lockfile");
  }
  if (!existsSync(options.chromiumPath)) {
    throw new Error("Playwright Chromium is missing. Run: pnpm test:e2e:install");
  }
  await requireSuccess(execute, capture("docker", ["info"]), "Docker is unavailable; start Docker Desktop/Engine and retry");

  // No user-configured database or URL is ever passed to a test process.
  log("Running root tests without an external PostgreSQL database.");
  await requireSuccess(execute, run(node, testArguments(options.rootTest)), "Root tests failed");
  log("Building and testing the production Web server.");
  await requireSuccess(execute, run(node, [pnpmCli, "--filter", "@bot-thk/web-rr", "build"]), "Web build failed");
  if (!options.webTests.length) throw new Error("No Web tests found.");
  await requireSuccess(execute, { ...run(node, ["--test", ...options.webTests]), cwd: join(cwd, "apps/web-rr") }, "Web behavior tests failed");

  const name = options.containerName;
  let attemptedStart = false;
  let primaryFailure: unknown;
  try {
    log("Starting an isolated PostgreSQL container (no persistent volume).");
    // The container name is a random, invocation-owned identifier; no user
    // resource is stopped or removed. Docker cleans its writable layer on rm.
    attemptedStart = true;
    await requireSuccess(execute, capture("docker", [
      "run", "--detach", "--rm", "--name", name,
      "-e", "POSTGRES_USER=postgres", "-e", `POSTGRES_PASSWORD=${options.password}`,
      "-e", "POSTGRES_DB=no_wave_test", "-p", "127.0.0.1::5432", "postgres:17-alpine",
    ]), "Unable to start disposable PostgreSQL (check Docker and image access)");
    const port = parseDockerPort((await requireSuccess(execute, capture("docker", ["port", name, "5432/tcp"]), "Unable to inspect PostgreSQL port")).stdout);
    let ready = false;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const check = await execute(capture("docker", ["exec", name, "pg_isready", "-h", "127.0.0.1", "-U", "postgres", "-d", "no_wave_test"]));
      if (check.code === 0) { ready = true; break; }
      await pause(1000);
    }
    if (!ready) throw new Error("Disposable PostgreSQL did not become ready within 60 seconds.");
    const testUrl = `postgres://postgres:${options.password}@127.0.0.1:${port}/no_wave_test`;
    log("Running PostgreSQL integration tests on the disposable database.");
    await requireSuccess(execute, {
      ...run(node, testArguments(options.integrationTest), { ...base, TEST_DATABASE_URL: testUrl }),
      cwd: join(cwd, "apps/api"),
    }, "PostgreSQL integration tests failed");
  } catch (error) {
    primaryFailure = error;
  } finally {
    if (attemptedStart) {
      try {
        await requireSuccess(cleanup, capture("docker", ["rm", "-f", name]), "Unable to remove disposable PostgreSQL container");
      } catch (error) {
        // A failed `docker run` may not have created the container. Inspect to
        // distinguish that case from an actual cleanup failure.
        const inspect = await cleanup(capture("docker", ["inspect", name])).catch(() => ({ code: 0, stdout: "", stderr: "" }));
        const definitelyAbsent = inspect.code !== 0 && /no such (?:object|container)/i.test(inspect.stderr);
        if (!definitelyAbsent && !primaryFailure) primaryFailure = error;
        else if (!definitelyAbsent) log(`Cleanup failed for ${name}; remove it with docker rm -f ${name}.`);
      }
    }
  }
  if (primaryFailure) throw primaryFailure;
  log("Running isolated SQLite browser shards.");
  await requireSuccess(execute, run(node, [join(cwd, "scripts/e2e-runner.ts")]), "Browser tests failed");
  log("All layers passed: root, production Web, PostgreSQL integration and browser E2E.");
}

async function main(): Promise<void> {
  const major = Number(process.versions.node.split(".")[0]);
  if (major !== 24) throw new Error("Node.js 24.x is required. Run: node scripts/preflight.cjs");
  const pnpmCli = process.env.npm_execpath;
  if (!pnpmCli || !existsSync(pnpmCli)) throw new Error("Run this command through pnpm: pnpm test:all");
  if (!existsSync(join(root, "node_modules", ".modules.yaml"))) throw new Error("Dependencies are missing. Run: pnpm install --frozen-lockfile");
  const { chromium } = await import("@playwright/test");
  const rootPackage = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as { scripts: { test: string } };
  const apiPackage = JSON.parse(await readFile(join(root, "apps/api/package.json"), "utf8")) as { scripts: { "test:integration": string } };
  const webTests = (await readdir(join(root, "apps/web-rr/test"))).filter((name) => name.endsWith(".test.ts")).sort().map((name) => `test/${name}`);
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  try {
    await runSuite({
      root, env: process.env, node: process.execPath, pnpmCli,
      rootTest: rootPackage.scripts.test, integrationTest: apiPackage.scripts["test:integration"], webTests,
      chromiumPath: chromium.executablePath(), containerName: `no-wave-test-${randomBytes(12).toString("hex")}`,
      password: randomBytes(24).toString("hex"), execute: makeExecute(controller.signal),
      cleanup: makeExecute(new AbortController().signal), pause: (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms)),
      log: (message) => process.stdout.write(`\n${message}\n`),
    });
  } finally {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    process.stderr.write(`Full test suite: ${error instanceof Error ? error.message : "unknown failure"}\n`);
    process.exitCode = 1;
  });
}
