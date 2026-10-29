/**
 * Shared, dependency-free configuration helpers for the local development
 * tooling (`pnpm setup:local`, `pnpm dev`, `pnpm check:local`).
 *
 * Design boundary: this module never imports application code from `apps/*`.
 * The scripts talk to the running system through its public interfaces (HTTP
 * for the API and the Web dev server, process exit codes for child processes),
 * so the tooling keeps working when an adapter, store or framework changes, and
 * so it cannot silently drift from a production code path it does not own.
 *
 * Everything here is pure so it can be unit tested without Docker, a database,
 * a browser or an HTTP server.
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const thisDirectory = dirname(fileURLToPath(import.meta.url));

export const repositoryRoot = resolve(thisDirectory, "../..");
export const localEnvFile = resolve(repositoryRoot, ".env.local");
export const envTemplateFile = resolve(repositoryRoot, ".env.example");
export const apiPackageDirectory = resolve(repositoryRoot, "apps/api");
export const webPackageDirectory = resolve(repositoryRoot, "apps/web");

/** The runtime range pinned by `package.json#engines` and CI. */
export const MIN_SUPPORTED_NODE_MAJOR = 24;
export const MAX_SUPPORTED_NODE_MAJOR = 24;

/**
 * `apps/api` rejects a shorter JWT secret by throwing during sign-in, which the
 * REST layer reports as `503 SERVICE_UNAVAILABLE` "Identity is not configured."
 * The cause is invisible to a client, so the tooling checks the length up front.
 */
export const MIN_AUTH_SECRET_BYTES = 32;

export const DEFAULT_API_PORT = 4000;
export const DEFAULT_WEB_PORT = 3000;
export const DEFAULT_LISTEN_HOST = "0.0.0.0";
export const DEFAULT_LOOPBACK_HOST = "127.0.0.1";
export const DEFAULT_SQLITE_PATH = "data/no-wave.sqlite";
export const DEFAULT_POSTGRES_URL = "postgres://postgres:postgres@127.0.0.1:5432/bot_thk_dev";
export const DEFAULT_POSTGRES_TEST_URL = "postgres://postgres:postgres@127.0.0.1:5432/bot_thk_test";

export type LocalDevIssue = {
  code: string;
  message: string;
  remedy: string;
};

export type LocalDevConfig = {
  /**
   * `listenBaseUrl` is always this machine's loopback address for the port the
   * API will bind. `baseUrl` honours an explicit API_BASE_URL, which may point
   * at a different (for example containerised or remote) API.
   */
  api: { host: string; port: number; listenBaseUrl: string; baseUrl: string };
  web: { host: string; port: number; listenBaseUrl: string; baseUrl: string };
  persistence: { provider: string; description: string };
  auth: { configuredBytes: number };
  issues: LocalDevIssue[];
};

/**
 * Load `<repository>/.env.local` into `process.env` when it exists.
 *
 * `process.loadEnvFile` never overwrites a variable that is already set, so an
 * explicit shell export keeps precedence over the file. That matches the API's
 * `node --env-file-if-exists` behaviour and the Next.js environment loader.
 */
export function loadLocalEnvFile(path = localEnvFile): boolean {
  if (typeof process.loadEnvFile !== "function") return false;
  try {
    process.loadEnvFile(path);
    return true;
  } catch {
    // A missing file is the normal case in CI and container builds.
    return false;
  }
}

export function parseNodeVersion(version: string): { major: number; minor: number; patch: number } | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

export function evaluateNodeVersion(version: string): { supported: boolean; message: string } {
  const parsed = parseNodeVersion(version);
  if (!parsed) {
    return {
      supported: false,
      message: `Unable to parse the Node.js version "${version}". Expected ${MIN_SUPPORTED_NODE_MAJOR}.x.`,
    };
  }
  if (parsed.major >= MIN_SUPPORTED_NODE_MAJOR && parsed.major <= MAX_SUPPORTED_NODE_MAJOR) {
    if (parsed.major === 24 && parsed.minor >= 15) {
      return {
        supported: true,
        message: `Node.js ${version} is supported; node:sqlite is a Release Candidate API on this minor.`,
      };
    }
    return {
      supported: true,
      message: `Node.js ${version} is supported; Node.js 24.15.0 or newer is recommended for the SQLite provider.`,
    };
  }
  if (parsed.major < MIN_SUPPORTED_NODE_MAJOR) {
    return {
      supported: false,
      message: `Node.js ${version} is older than the supported ${MIN_SUPPORTED_NODE_MAJOR}.x line.`,
    };
  }
  return {
    supported: false,
    message: `Node.js ${version} is newer than the supported ${MIN_SUPPORTED_NODE_MAJOR}.x line.`,
  };
}

export function evaluateAuthSecret(secret: string | undefined): { ok: boolean; bytes: number; issue?: LocalDevIssue } {
  if (typeof secret !== "string" || secret.length === 0) {
    return {
      ok: false,
      bytes: 0,
      issue: {
        code: "AUTH_SECRET_MISSING",
        message: "AUTH_JWT_SECRET is not set.",
        remedy: "Run `pnpm setup:local` to generate .env.local, or export a secret of at least 32 bytes.",
      },
    };
  }
  const bytes = Buffer.byteLength(secret, "utf8");
  if (bytes < MIN_AUTH_SECRET_BYTES) {
    return {
      ok: false,
      bytes,
      issue: {
        code: "AUTH_SECRET_TOO_SHORT",
        message: `AUTH_JWT_SECRET is ${bytes} bytes; the API requires at least ${MIN_AUTH_SECRET_BYTES}.`,
        remedy: "Run `pnpm setup:local --force` to regenerate .env.local, or export a longer secret.",
      },
    };
  }
  return { ok: true, bytes };
}

export function parsePort(
  value: string | undefined,
  fallback: number,
  name: string,
): { port: number; issue?: LocalDevIssue } {
  if (value === undefined || value.trim() === "") return { port: fallback };
  const trimmed = value.trim();
  if (!/^\d{1,5}$/.test(trimmed)) {
    return {
      port: fallback,
      issue: { code: "INVALID_PORT", message: `${name}="${value}" is not a port number.`, remedy: `Set ${name} to an integer between 1 and 65535.` },
    };
  }
  const port = Number(trimmed);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    return {
      port: fallback,
      issue: { code: "INVALID_PORT", message: `${name}="${value}" is outside 1-65535.`, remedy: `Set ${name} to an integer between 1 and 65535.` },
    };
  }
  return { port };
}

function nonEmpty(value: string | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Build the origin used by *this machine* to reach a local process. Loopback is
 * spelled `127.0.0.1` rather than `localhost` on purpose: `localhost` may
 * resolve to `::1` while the server listens on IPv4 only, which produces an
 * `ECONNREFUSED` that looks like "the API is not running".
 */
export function loopbackBaseUrl(port: number): string {
  return `http://${DEFAULT_LOOPBACK_HOST}:${port}`;
}

/** Strip credentials from a connection URL so it is safe to print. */
export function redactDatabaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "<unparseable DATABASE_URL>";
  }
  if (url.password) url.password = "***";
  return url.toString();
}

export function resolveLocalDevConfig(env: NodeJS.ProcessEnv = process.env): LocalDevConfig {
  const issues: LocalDevIssue[] = [];

  const apiPort = parsePort(nonEmpty(env.API_PORT) ?? nonEmpty(env.PORT), DEFAULT_API_PORT, "PORT");
  if (apiPort.issue) issues.push(apiPort.issue);
  const webPort = parsePort(nonEmpty(env.WEB_PORT), DEFAULT_WEB_PORT, "WEB_PORT");
  if (webPort.issue) issues.push(webPort.issue);

  const apiHost = nonEmpty(env.HOST) ?? DEFAULT_LISTEN_HOST;
  const webHost = nonEmpty(env.WEB_HOST) ?? DEFAULT_LISTEN_HOST;
  const configuredApiBaseUrl = nonEmpty(env.API_BASE_URL);
  const configuredWebBaseUrl = nonEmpty(env.WEB_BASE_URL);

  const auth = evaluateAuthSecret(env.AUTH_JWT_SECRET);
  if (auth.issue) issues.push(auth.issue);

  const provider = nonEmpty(env.DATABASE_PROVIDER) ?? (nonEmpty(env.DATABASE_URL) ? "postgres" : "sqlite");
  let description: string;
  if (provider === "sqlite") {
    const configuredPath = nonEmpty(env.DATABASE_PATH) ?? DEFAULT_SQLITE_PATH;
    const absolutePath = configuredPath === ":memory:" ? configuredPath : resolve(apiPackageDirectory, configuredPath);
    description = `SQLite (${absolutePath})`;
  } else if (provider === "postgres") {
    const url = nonEmpty(env.DATABASE_URL);
    description = url ? `PostgreSQL (${redactDatabaseUrl(url)})` : "PostgreSQL (DATABASE_URL is not set)";
  } else {
    description = `${provider} (no adapter is registered for this provider)`;
  }

  return {
    api: {
      host: apiHost,
      port: apiPort.port,
      listenBaseUrl: loopbackBaseUrl(apiPort.port),
      baseUrl: configuredApiBaseUrl ?? loopbackBaseUrl(apiPort.port),
    },
    web: {
      host: webHost,
      port: webPort.port,
      listenBaseUrl: loopbackBaseUrl(webPort.port),
      baseUrl: configuredWebBaseUrl ?? loopbackBaseUrl(webPort.port),
    },
    persistence: { provider, description },
    auth: { configuredBytes: auth.bytes },
    issues,
  };
}

export type LocalEnvFileOptions = {
  jwtSecret: string;
  provider: "sqlite" | "postgres";
  databaseUrl?: string;
  testDatabaseUrl?: string;
  apiPort?: number;
  webPort?: number;
};

/**
 * Render a `.env.local` for local development only. Kept pure so the generated
 * contract is asserted by tests instead of by a manual copy of the template.
 */
export function buildLocalEnvFile(options: LocalEnvFileOptions): string {
  const apiPort = options.apiPort ?? DEFAULT_API_PORT;
  const webPort = options.webPort ?? DEFAULT_WEB_PORT;
  const persistence = options.provider === "postgres"
    ? [
        "DATABASE_PROVIDER=postgres",
        `DATABASE_URL=${options.databaseUrl ?? DEFAULT_POSTGRES_URL}`,
        "# `pnpm --filter @bot-thk/api migrate` uses DATABASE_URL_UNPOOLED first when set.",
        "# DATABASE_URL_UNPOOLED=",
        "# Uncomment after `pnpm db:up` if you also want the PostgreSQL integration tests",
        "# to run as part of `pnpm test`:",
        `# TEST_DATABASE_URL=${options.testDatabaseUrl ?? DEFAULT_POSTGRES_TEST_URL}`,
      ]
    : [
        "DATABASE_PROVIDER=sqlite",
        `DATABASE_PATH=${DEFAULT_SQLITE_PATH}`,
        "# Optional: apply SQLite migrations at API startup (local/test convenience only).",
        "# DATABASE_AUTO_MIGRATE=true",
      ];

  return [
    "# Generated by `pnpm setup:local` for local development only.",
    "# This file is git-ignored. Never put shared, staging or production",
    "# credentials in it, and never point it at a database you cannot destroy.",
    "# Full option reference: .env.example",
    "",
    "# --- Persistence -----------------------------------------------------------",
    ...persistence,
    "",
    "# --- API process -----------------------------------------------------------",
    `HOST=${DEFAULT_LISTEN_HOST}`,
    `PORT=${apiPort}`,
    `AUTH_JWT_SECRET=${options.jwtSecret}`,
    "AUTH_JWT_ISSUER=http://localhost:4000",
    "AUTH_JWT_AUDIENCE=no-wave",
    "AUTH_JWT_MAX_TTL_SECONDS=900",
    "",
    "# --- Web dev server --------------------------------------------------------",
    "# Read by apps/web/next.config.ts, so one root file configures both processes.",
    `API_BASE_URL=${loopbackBaseUrl(apiPort)}`,
    `WEB_PORT=${webPort}`,
    "",
  ].join("\n");
}

/**
 * Extract `KEY` names from an env template. A commented placeholder such as
 * `# DATABASE_URL=...` documents an optional variable, so it counts.
 */
export function extractEnvTemplateKeys(template: string): string[] {
  const keys: string[] = [];
  for (const line of template.split(/\r?\n/)) {
    const match = /^(?:#\s*)?(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=/.exec(line.trim());
    if (match && !keys.includes(match[1])) keys.push(match[1]);
  }
  return keys;
}

/** Extract the active `KEY` names from a rendered `.env` document. */
export function extractEnvFileKeys(document: string): string[] {
  const keys: string[] = [];
  for (const line of document.split(/\r?\n/)) {
    const match = /^(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=/.exec(line.trim());
    if (match && !keys.includes(match[1])) keys.push(match[1]);
  }
  return keys;
}

export type DevArguments = { apiOnly: boolean; webOnly: boolean; check: boolean; exit: boolean };

export function parseDevArguments(argv: readonly string[]): { args?: DevArguments; error?: string } {
  const args: DevArguments = { apiOnly: false, webOnly: false, check: false, exit: false };
  for (const argument of argv) {
    if (argument === "--api-only") args.apiOnly = true;
    else if (argument === "--web-only") args.webOnly = true;
    else if (argument === "--check") args.check = true;
    else if (argument === "--exit") args.exit = true;
    else return { error: `Unknown option "${argument}". Supported: --api-only, --web-only, --check, --exit.` };
  }
  if (args.apiOnly && args.webOnly) {
    return { error: "--api-only and --web-only cannot be combined." };
  }
  if (args.exit && !args.check) {
    return { error: "--exit requires --check: it stops the processes after the connectivity probe." };
  }
  return { args };
}

export type CheckArguments = {
  apiOnly: boolean;
  readOnly: boolean;
  apiBaseUrl?: string;
  webBaseUrl?: string;
  timeoutMs?: number;
};

export function parseCheckArguments(argv: readonly string[]): { args?: CheckArguments; error?: string } {
  const args: CheckArguments = { apiOnly: false, readOnly: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--api-only") args.apiOnly = true;
    else if (argument === "--read-only") args.readOnly = true;
    else if (argument === "--api-url" || argument === "--web-url" || argument === "--timeout") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        return { error: `Option "${argument}" requires a value.` };
      }
      index += 1;
      if (argument === "--api-url") args.apiBaseUrl = value;
      if (argument === "--web-url") args.webBaseUrl = value;
      if (argument === "--timeout") {
        const parsed = Number(value);
        if (!Number.isSafeInteger(parsed) || parsed <= 0) {
          return { error: `Option "--timeout" expects a positive integer number of milliseconds.` };
        }
        args.timeoutMs = parsed;
      }
    } else {
      return {
        error: `Unknown option "${argument}". Supported: --api-only, --read-only, --api-url <url>, --web-url <url>, --timeout <ms>.`,
      };
    }
  }
  return { args };
}

/**
 * Disposable identity for the write probes. The API rate-limits registration by
 * IP (20 per hour) and by email (5 per hour), so each run uses a fresh email.
 */
export function buildProbeIdentity(now: Date = new Date(), random: () => number = Math.random): {
  email: string;
  password: string;
  slug: string;
  title: string;
} {
  const stamp = now.toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  const suffix = Math.floor(random() * 36 ** 6).toString(36).padStart(6, "0");
  const token = `${stamp}${suffix}`.toLowerCase();
  return {
    email: `local-check-${token}@example.test`,
    password: "local-dev-check-password",
    slug: `local-dev-check-${stamp}-${suffix}`,
    title: `本地联调探针 ${stamp}`,
  };
}

/** Normalize a base URL to its origin so request `Origin` headers can match. */
export function originOf(baseUrl: string): string {
  const url = new URL(baseUrl);
  return url.origin;
}
