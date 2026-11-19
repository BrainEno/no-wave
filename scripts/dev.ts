/**
 * `pnpm dev` supervises API, notification worker and Web on one configuration.
 * `--api-only` keeps the API-side worker; `--web-only` uses an external API.
 * Node watch mode retains hot reload, while failed watched applications tear
 * down the whole chain instead of leaving an apparently running half-stack.
 */
import { execFile } from "node:child_process";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import {
  apiPackageDirectory,
  evaluateNodeVersion,
  loadLocalEnvFile,
  parseDevArguments,
  repositoryRoot,
  resolveLocalDevConfig,
  webPackageDirectory,
  type LocalDevIssue,
} from "./lib/local-dev-config.ts";
import { formatReport, runLocalChecks } from "./local-dev-check.ts";
import { resolveWebBuildCli } from "./lib/web-build-cli.ts";
import { createDevSupervisor } from "./lib/dev-supervisor.ts";

const executeFile = promisify(execFile);
const READY_TIMEOUT_MS = 90_000;
const info = (message: string) => process.stdout.write(`${message}\n`);
const error = (message: string) => process.stderr.write(`error   ${message}\n`);

function isPortFree(host: string, port: number): Promise<boolean> {
  return new Promise(resolvePromise => {
    const probe = createServer();
    probe.once("error", () => resolvePromise(false));
    probe.once("listening", () => probe.close(() => resolvePromise(true)));
    probe.listen({ host, port });
  });
}

function printIssues(issues: LocalDevIssue[]): void {
  for (const issue of issues) info(`error   ${issue.message}\n        -> ${issue.remedy}`);
}

export async function runDev(): Promise<void> {
  const loaded = loadLocalEnvFile();
  const parsed = parseDevArguments(process.argv.slice(2));
  if (!parsed.args) { error(parsed.error!); process.exitCode = 2; return; }
  const { apiOnly, webOnly, check, exit } = parsed.args;
  const config = resolveLocalDevConfig(process.env);
  const startApi = !webOnly;
  const startWeb = !apiOnly;

  info("No Wave local development\n=========================");
  info(`environment  ${loaded ? ".env.local loaded" : "no .env.local (using process env and defaults)"}`);
  info(`persistence  ${config.persistence.description}`);
  if (startApi && config.persistence.external) {
    info("warn   The configured PostgreSQL host is external; API and worker will both write to that database.");
    info("        -> Use SQLite or `pnpm db:up`; `pnpm setup:local --force` generates local-only configuration.");
  }
  const node = evaluateNodeVersion(process.version);
  if (!node.supported) info(`warn   ${node.message} Use Node.js 24.x, the runtime pinned by package.json and CI.`);
  const blocking = config.issues.filter(issue => startApi || issue.code === "INVALID_PORT" || issue.code === "INVALID_DEV_RECOVERY_TIMEOUT");
  if (blocking.length) {
    printIssues(blocking);
    info("Nothing was started. Fix the errors above and run `pnpm dev` again.");
    process.exitCode = 1;
    return;
  }

  const listeners = [
    ...(startApi ? [
      { name: "API", variable: "PORT", ...config.api },
      { name: "notification worker", variable: "OUTBOX_HEALTH_PORT", ...config.worker },
    ] : []),
    ...(startWeb ? [{ name: "Web", variable: "WEB_PORT", ...config.web }] : []),
  ];
  const assigned = new Set<number>();
  for (const listener of listeners) {
    if (assigned.has(listener.port)) {
      error(`Port ${listener.port} is assigned to more than one service; set distinct PORT, WEB_PORT and OUTBOX_HEALTH_PORT values.`);
      process.exitCode = 1;
      return;
    }
    assigned.add(listener.port);
    if (!await isPortFree(listener.host, listener.port)) {
      error(`Port ${listener.port} for ${listener.name} is unavailable; stop the other listener or change ${listener.variable}.`);
      process.exitCode = 1;
      return;
    }
    info(`${listener.name.padEnd(20)} ${listener.listenBaseUrl}`);
  }
  const webApiOrigin = process.env.API_BASE_URL ?? config.api.listenBaseUrl;
  if (startApi && startWeb && webApiOrigin !== config.api.listenBaseUrl) {
    info(`warn   Web will use API_BASE_URL (${webApiOrigin}), not the API started at ${config.api.listenBaseUrl}.`);
    info("        -> Unset API_BASE_URL to wire the local processes together.");
  }

  const configuredGrace = Number(process.env.SHUTDOWN_GRACE_MS ?? 8000);
  const graceMs = Number.isInteger(configuredGrace) && configuredGrace >= 100 && configuredGrace <= 60_000 ? configuredGrace + 1500 : 9500;
  const supervisor = createDevSupervisor({ info, error, graceMs });
  try {
    if (startWeb) {
      info("Preparing first-party fonts before service startup (a cold checkout may take several minutes).");
      // Cold subsetting is a bounded, cancellable preflight, not Web readiness.
      // Start no API/worker/Web role until it succeeds; keep their 90s bound.
      const { stdout, stderr } = await executeFile(process.execPath, [resolve(repositoryRoot, "scripts/fonts/generate.ts"), "--prepare"], {
        cwd: repositoryRoot, env: process.env, signal: supervisor.signal, timeout: 300_000, windowsHide: true,
      });
      if (stdout) process.stdout.write(stdout);
      if (stderr) process.stderr.write(stderr);
    }
    if (startApi) {
      // Same cwd and persistence variables: a relative SQLite filename must
      // identify one durable database, never two role-specific local files.
      const shared = { ...process.env, PORT: String(config.api.port), HOST: config.api.host };
      const api = supervisor.launch({ role: "api", label: "API", cwd: apiPackageDirectory,
        args: ["--watch", "--watch-preserve-output", "src/service.ts"], env: { ...shared, SERVICE_ROLE: "api" } });
      const worker = supervisor.launch({ role: "worker", label: "Notification worker", cwd: apiPackageDirectory,
        args: ["--watch", "--watch-preserve-output", "src/service.ts"], env: { ...shared, SERVICE_ROLE: "notification-worker",
          OUTBOX_HEALTH_PORT: String(config.worker.port), OUTBOX_HEALTH_HOST: config.worker.host } });
      // Launch the consumer before waiting for API readiness: an old backlog is
      // a reason to start delivery, not a circular startup dependency.
      await Promise.all([
        supervisor.waitForHttp(api, `${config.api.listenBaseUrl}/ready`, READY_TIMEOUT_MS, "ready (check migrations and AUTH_JWT_SECRET)"),
        supervisor.waitForHttp(worker, `${config.worker.listenBaseUrl}/ready`, READY_TIMEOUT_MS, "ready (check persistence and worker settings)"),
      ]);
      supervisor.monitor(api, `${config.api.listenBaseUrl}/ready`, { outageMs: config.supervision.recoveryTimeoutMs });
      supervisor.monitor(worker, `${config.worker.listenBaseUrl}/ready`, { outageMs: config.supervision.recoveryTimeoutMs });
      info("api + worker ready");
    }
    supervisor.assertRunning();
    if (startWeb) {
      // Vite finishes its own SIGTERM cleanup with 128 + 15, unlike our API
      // and worker processes, whose unsuccessful cleanup must remain an error.
      const web = supervisor.launch({ role: "web", label: "Web dev server", cwd: webPackageDirectory, acceptableStopExitCodes: [143],
        args: [resolveWebBuildCli(repositoryRoot), "dev", "--port", String(config.web.port), "--host", config.web.host],
        env: { ...process.env, PORT: String(config.web.port), API_BASE_URL: webApiOrigin } });
      await supervisor.waitForHttp(web, `${config.web.listenBaseUrl}/`, READY_TIMEOUT_MS, "ready");
      supervisor.monitor(web, `${config.web.listenBaseUrl}/`, { outageMs: config.supervision.recoveryTimeoutMs });
    }
    supervisor.assertRunning();
    info("\nReady.");
    if (startWeb) info(`  open       ${config.web.listenBaseUrl}`);
    if (startApi) {
      info(`  API        ${config.api.listenBaseUrl}/api/v1/health`);
      info(`  readiness  ${config.api.listenBaseUrl}/ready`);
      info(`  worker     ${config.worker.listenBaseUrl}/ready`);
    }
    info(`  diagnose   pnpm check:local${apiOnly ? " --api-only" : ""}`);
    info("  stop       Ctrl+C\n");
    if (check) {
      const outcome = await Promise.race([
        runLocalChecks({ apiBaseUrl: webApiOrigin, webBaseUrl: config.web.listenBaseUrl, apiOnly, readOnly: false, timeoutMs: 15_000 }),
        supervisor.stopped.then(() => null),
      ]);
      if (outcome) {
        info(formatReport(outcome.results, { apiBaseUrl: webApiOrigin, webBaseUrl: apiOnly ? undefined : config.web.listenBaseUrl, apiOnly }));
        if (outcome.failed > 0 && !exit) info("The connectivity probe failed; services remain supervised for diagnosis.");
        if (exit) await supervisor.stop(outcome.failed > 0 ? 1 : 0);
      }
    }
    process.exitCode = await supervisor.stopped;
  } catch (cause) {
    if (!supervisor.signal.aborted || supervisor.failure) {
      if (!supervisor.failure) error(cause instanceof Error ? cause.message : "Local startup failed.");
      await supervisor.stop(1);
    } else await supervisor.stop(0);
    process.exitCode = supervisor.exitCode;
  } finally {
    await supervisor.stop(supervisor.exitCode);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runDev().catch(() => { error("Local development could not be started."); process.exitCode = 1; });
}
