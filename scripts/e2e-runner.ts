/**
 * Run the complete browser suite against three independent disposable stacks.
 * Article creation is deliberately limited to 30/IP/hour in the real API, so
 * sharing one SQLite file would exhaust the production limit. Explicit CLI
 * arguments or external E2E URLs keep the ordinary Playwright behavior.
 */
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { INHERITED_VARIABLES } from "./portable-stack.ts";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const playwrightCli = fileURLToPath(import.meta.resolve("@playwright/test/cli"));

export function shouldRunIsolated(args: readonly string[], env: NodeJS.ProcessEnv): boolean {
  return args.length === 0 && !env.E2E_WEB_URL && !env.E2E_API_BASE_URL;
}

type IsolatedOptions = { databasePath: string; apiPort: number; webPort: number; secret: string };

export function isolatedEnvironment(base: NodeJS.ProcessEnv, options: IsolatedOptions): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  // Do not inherit external databases, mail, object storage, platform bindings,
  // or developer ports. Keep only OS essentials and browser-discovery settings.
  for (const name of [...INHERITED_VARIABLES, "PLAYWRIGHT_BROWSERS_PATH", "LD_LIBRARY_PATH", "CI"]) {
    if (base[name] !== undefined) env[name] = base[name];
  }
  const api = `http://127.0.0.1:${options.apiPort}`;
  const web = `http://127.0.0.1:${options.webPort}`;
  return {
    ...env,
    DATABASE_PROVIDER: "sqlite",
    DATABASE_PATH: options.databasePath,
    AUTH_JWT_SECRET: options.secret,
    AUTH_JWT_ISSUER: api,
    AUTH_JWT_AUDIENCE: "no-wave-e2e",
    // Independent multi-account safety journeys can register 64 users in one
    // shard. This finite fixture budget matches CI, not the API default (20).
    AUTH_REGISTER_IP_LIMIT: "80",
    API_BASE_URL: api,
    E2E_API_BASE_URL: api,
    E2E_WEB_URL: web,
    E2E_ISOLATED_STACK: "1",
    PORT: String(options.apiPort),
    HOST: "0.0.0.0",
    SITE_URL: web,
  };
}

function reservePort(): Promise<Server> {
  const server = createServer();
  return new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "0.0.0.0", () => resolvePromise(server));
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolvePromise, reject) => server.close((error) => error ? reject(error) : resolvePromise()));
}

async function unusedPorts(): Promise<[number, number]> {
  const api = await reservePort();
  try {
    // Hold the first socket until the second has been allocated, so the OS
    // cannot hand us the same port twice. Playwright must still fail if another
    // process takes a port in the short gap before its servers start.
    const web = await reservePort();
    try {
      const apiAddress = api.address();
      const webAddress = web.address();
      if (!apiAddress || typeof apiAddress === "string" || !webAddress || typeof webAddress === "string") {
        throw new Error("Unable to allocate browser-test ports.");
      }
      return [apiAddress.port, webAddress.port];
    } finally { await close(web); }
  } finally { await close(api); }
}

function runNode(args: readonly string[], env: NodeJS.ProcessEnv): number {
  const result = spawnSync(process.execPath, [...args], { cwd: root, env, stdio: "inherit" });
  if (result.error) process.stderr.write(`Unable to start browser-test process: ${result.error.message}\n`);
  return result.status ?? 1;
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  if (!shouldRunIsolated(args, process.env)) return runNode([playwrightCli, "test", ...args], process.env);

  const directory = await mkdtemp(join(tmpdir(), "no-wave-e2e-"));
  try {
    for (let shard = 1; shard <= 3; shard += 1) {
      const [apiPort, webPort] = await unusedPorts();
      const env = isolatedEnvironment(process.env, {
        databasePath: join(directory, `shard-${shard}.sqlite`),
        apiPort,
        webPort,
        secret: randomBytes(32).toString("hex"),
      });
      process.stdout.write(`\nBrowser suite: isolated shard ${shard}/3\n`);
      const migration = runNode([join(root, "apps/api/src/persistence/migrate.ts")], env);
      if (migration !== 0) return migration;
      const tests = runNode([playwrightCli, "test", `--shard=${shard}/3`], env);
      if (tests !== 0) return tests;
    }
    return 0;
  } finally {
    // The directory was created by this invocation, never supplied by a user.
    await rm(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((status) => { process.exitCode = status; }).catch((error: unknown) => {
    process.stderr.write(`Browser suite could not start: ${error instanceof Error ? error.message : "unknown error"}\n`);
    process.exitCode = 1;
  });
}
