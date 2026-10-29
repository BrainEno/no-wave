/**
 * `pnpm dev` — start the local development chain with one command.
 *
 *   pnpm dev             API (:4000, `node --watch`) + Web dev server (:3000)
 *   pnpm dev --api-only  API only
 *   pnpm dev --web-only  Web only (e.g. when the API runs in a container)
 *   pnpm dev --check     run `pnpm check:local` once both processes are ready
 *   pnpm dev --check --exit  stop after the probe; exit 0 only if every step passed
 *
 * Why an orchestrator instead of two terminals:
 *   - one source of truth for API_BASE_URL, so the Web process cannot silently
 *     fall back to its fixture registry;
 *   - readiness gates, so "the page is blank" is never caused by a race;
 *   - the two documented failure modes (short AUTH_JWT_SECRET, occupied port)
 *     are reported before any child process starts;
 *   - one Ctrl+C stops both processes and their watchers.
 *
 * The orchestrator spawns Node directly (no nested package manager) so signals
 * reach the real processes on every platform, including Windows.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { createInterface } from "node:readline";
import { join } from "node:path";
import {
  apiPackageDirectory,
  DEFAULT_LISTEN_HOST,
  evaluateNodeVersion,
  loadLocalEnvFile,
  parseDevArguments,
  resolveLocalDevConfig,
  webPackageDirectory,
  type LocalDevIssue,
} from "./lib/local-dev-config.ts";
import { formatReport, runLocalChecks } from "./local-dev-check.ts";

type Role = "api" | "web";

const READY_TIMEOUT_MS = 90_000;

function prefixed(role: Role, line: string): string {
  return `${role.padEnd(3)} | ${line}`;
}

function pipeOutput(child: ChildProcess, role: Role, onLine?: (line: string) => void): void {
  for (const stream of [child.stdout, child.stderr]) {
    if (!stream) continue;
    createInterface({ input: stream }).on("line", (line) => {
      process.stdout.write(`${prefixed(role, line)}\n`);
      onLine?.(line);
    });
  }
}

function isPortFree(host: string, port: number): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const probeHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
    const probe = createServer();
    probe.once("error", () => resolvePromise(false));
    probe.once("listening", () => probe.close(() => resolvePromise(true)));
    probe.listen({ host: probeHost, port });
  });
}

async function waitForHttp(
  url: string,
  timeoutMs: number,
  child: ChildProcess | null,
  isAborted: () => boolean = () => false,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child && child.exitCode !== null) return false;
    if (isAborted()) return false;
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(5_000), redirect: "manual" });
      if (response.status === 200) return true;
    } catch {
      // Still starting.
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 400));
  }
  return false;
}

function printIssues(issues: LocalDevIssue[]): void {
  for (const issue of issues) {
    process.stdout.write(`error   ${issue.message}\n        -> ${issue.remedy}\n`);
  }
}

async function main(): Promise<void> {
  const loaded = loadLocalEnvFile();
  const parsed = parseDevArguments(process.argv.slice(2));
  if (!parsed.args) {
    process.stderr.write(`${parsed.error}\n`);
    process.exitCode = 2;
    return;
  }
  const { apiOnly, webOnly, check, exit } = parsed.args;
  const config = resolveLocalDevConfig(process.env);
  const startApi = !webOnly;
  const startWeb = !apiOnly;

  process.stdout.write("No Wave local development\n=========================\n");
  process.stdout.write(`environment  ${loaded ? ".env.local loaded" : "no .env.local (using process env and defaults)"}\n`);
  process.stdout.write(`persistence  ${config.persistence.description}\n`);

  const node = evaluateNodeVersion(process.version);
  if (!node.supported) {
    process.stdout.write(`warn   ${node.message} Use Node.js 24.x, the runtime pinned by package.json and CI.\n`);
  }

  const blocking = config.issues.filter((issue) => startApi || issue.code === "INVALID_PORT");
  if (blocking.length > 0) {
    printIssues(blocking);
    process.stdout.write("\nNothing was started. Fix the errors above and run `pnpm dev` again.\n");
    process.exitCode = 1;
    return;
  }

  if (startApi) {
    process.stdout.write(`api    ${config.api.listenBaseUrl} (listening on ${config.api.host}:${config.api.port})\n`);
    if (config.api.baseUrl !== config.api.listenBaseUrl) {
      process.stdout.write(`warn   API_BASE_URL is ${config.api.baseUrl}; readiness is checked on ${config.api.listenBaseUrl}.\n`);
    }
  }
  if (startWeb) {
    process.stdout.write(`web    ${config.web.listenBaseUrl} (listening on ${config.web.host}:${config.web.port})\n`);
    const webApiOrigin = process.env.API_BASE_URL ?? config.api.listenBaseUrl;
    if (startApi && webApiOrigin !== config.api.listenBaseUrl) {
      process.stdout.write(`warn   The Web app will call ${webApiOrigin}, not the API started here (${config.api.listenBaseUrl}).\n`);
      process.stdout.write("        -> Unset API_BASE_URL to let `pnpm dev` wire the two processes together.\n");
    }
  }

  if (startApi && !(await isPortFree(config.api.host, config.api.port))) {
    process.stdout.write(`error   Port ${config.api.port} is already in use.\n        -> Stop the other process, or set PORT to another port in .env.local.\n`);
    process.exitCode = 1;
    return;
  }
  if (startWeb && !(await isPortFree(config.web.host, config.web.port))) {
    process.stdout.write(`error   Port ${config.web.port} is already in use.\n        -> Stop the other process, or set WEB_PORT to another port in .env.local.\n`);
    process.exitCode = 1;
    return;
  }

  const children: ChildProcess[] = [];
  let shuttingDown = false;
  let exitCode = 0;

  const sleep = (ms: number) => new Promise<void>((resolvePromise) => setTimeout(resolvePromise, ms));
  /** Give the children a moment to exit so Ctrl+C never leaves orphans behind. */
  const waitForShutdown = async (limitMs = 6_000): Promise<void> => {
    const deadline = Date.now() + limitMs;
    while (Date.now() < deadline) {
      const alive = children.filter((child) => child.exitCode === null && child.signalCode === null);
      if (alive.length === 0) return;
      await sleep(100);
    }
  };

  const shutdown = (code: number): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    exitCode = code;
    // Set the exit code immediately: several failure paths return before the
    // final `process.exitCode = exitCode` assignment below.
    process.exitCode = code;
    for (const child of children) {
      if (child.exitCode === null) child.kill("SIGTERM");
    }
    const forced = setTimeout(() => {
      for (const child of children) {
        if (child.exitCode === null) child.kill("SIGKILL");
      }
    }, 5_000);
    forced.unref();
  };

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      process.stdout.write(`\n${signal} received; stopping local processes.\n`);
      shutdown(0);
    });
  }

  const track = (child: ChildProcess, role: Role): void => {
    children.push(child);
    child.once("exit", (code, signal) => {
      if (shuttingDown) return;
      const normalStop = code === 0 || signal === "SIGTERM" || signal === "SIGINT";
      process.stdout.write(`${prefixed(role, `exited (code=${code ?? "null"}, signal=${signal ?? "none"})`)}\n`);
      if (!normalStop) {
        if (role === "api") {
          process.stdout.write(
            "hint    The API stopped during startup. A PostgreSQL run needs `pnpm db:up` and `pnpm db:migrate`; a SQLite run needs `pnpm db:migrate` once.\n",
          );
        }
        shutdown(code ?? 1);
      } else {
        shutdown(0);
      }
    });
  };

  let apiChild: ChildProcess | null = null;
  if (startApi) {
    apiChild = spawn(process.execPath, ["--watch", "src/server.ts"], {
      cwd: apiPackageDirectory,
      env: {
        ...process.env,
        PORT: String(config.api.port),
        HOST: config.api.host || DEFAULT_LISTEN_HOST,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    // `node --watch` keeps the process alive after a failed startup, so the
    // readiness wait has to fail fast on the structured startup-failure event.
    let startupFailed = false;
    pipeOutput(apiChild, "api", (line) => {
      if (line.includes("api_startup_failed")) startupFailed = true;
    });
    track(apiChild, "api");

    const ready = await waitForHttp(`${config.api.listenBaseUrl}/ready`, READY_TIMEOUT_MS, apiChild, () => startupFailed || shuttingDown);
    if (!ready) {
      if (!shuttingDown) {
        process.stdout.write(startupFailed
          ? "error   The API failed during startup (see the `api |` line above).\n"
          : `error   The API did not become ready at ${config.api.listenBaseUrl}/ready within ${READY_TIMEOUT_MS / 1000}s.\n`);
        process.stdout.write("        -> First run: `pnpm db:migrate`. PostgreSQL: `pnpm db:up` and check DATABASE_URL.\n");
        process.stdout.write("        -> After that: check AUTH_JWT_SECRET (>=32 bytes) and that the schema is current.\n");
        shutdown(1);
        await waitForShutdown();
      }
      return;
    }
    process.stdout.write(`api    ready (${config.api.listenBaseUrl}/ready)\n`);
  }

  if (startWeb) {
    const webChild = spawn(
      process.execPath,
      [join(webPackageDirectory, "node_modules/next/dist/bin/next"), "dev", "--port", String(config.web.port), "--hostname", config.web.host],
      {
        cwd: webPackageDirectory,
        env: { ...process.env, API_BASE_URL: process.env.API_BASE_URL ?? config.api.listenBaseUrl },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    pipeOutput(webChild, "web");
    track(webChild, "web");

    const ready = await waitForHttp(`${config.web.listenBaseUrl}/`, READY_TIMEOUT_MS, webChild, () => shuttingDown);
    if (!ready) {
      if (!shuttingDown) {
        process.stdout.write(`error   The Web dev server did not answer at ${config.web.listenBaseUrl}/ within ${READY_TIMEOUT_MS / 1000}s.\n`);
        process.stdout.write("        -> Check the `web |` lines above; the first start compiles the app.\n");
        shutdown(1);
        await waitForShutdown();
      }
      return;
    }
    process.stdout.write(`web    ready (${config.web.listenBaseUrl}/)\n`);
  }

  process.stdout.write("\nReady.\n");
  if (startWeb) process.stdout.write(`  open       ${config.web.listenBaseUrl}\n`);
  if (startApi) process.stdout.write(`  API        ${config.api.listenBaseUrl}/api/v1/health\n`);
  if (startApi) process.stdout.write(`  readiness  ${config.api.listenBaseUrl}/ready\n`);
  process.stdout.write(`  diagnose   pnpm check:local${apiOnly ? " --api-only" : ""}\n`);
  process.stdout.write("  stop       Ctrl+C\n\n");

  if (check) {
    const { results, failed } = await runLocalChecks({
      apiBaseUrl: process.env.API_BASE_URL ?? config.api.listenBaseUrl,
      webBaseUrl: config.web.listenBaseUrl,
      apiOnly,
      readOnly: false,
      timeoutMs: 15_000,
    });
    process.stdout.write(`${formatReport(results, {
      apiBaseUrl: process.env.API_BASE_URL ?? config.api.listenBaseUrl,
      webBaseUrl: apiOnly ? undefined : config.web.listenBaseUrl,
      apiOnly,
    })}\n`);
    if (failed > 0) {
      process.stdout.write("`pnpm dev --check` reported failures; the processes stay up so you can inspect them.\n");
    }
    if (exit) {
      // One-shot verification (CI, scripts): stop both processes and report the
      // probe result as the command's exit code.
      shutdown(failed > 0 ? 1 : 0);
    }
  }

  if (shuttingDown) {
    await waitForShutdown();
    process.exitCode = exitCode;
    return;
  }

  // Keep the event loop alive while the children run.
  while (!shuttingDown) await sleep(250);
  await waitForShutdown();
  process.exitCode = exitCode;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch((error: unknown) => {
    process.stderr.write(`pnpm dev failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
