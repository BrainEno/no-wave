import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

/**
 * `vercel.json` names four files by path (audit F-25).
 *
 * A deployment configuration is the one checked-in file nothing runs: CI builds
 * the two container images, but it builds them from `apps/<name>/Dockerfile`, not by
 * reading this manifest. So a renamed Dockerfile, a moved worker script or a
 * rewrite that points at a service nobody declared would break the first real
 * deploy and nothing earlier. These are path assertions on the file Vercel would
 * read, not a deploy.
 */

const REPOSITORY_ROOT = new URL("..", import.meta.url).pathname;
const CONFIG_FILE = join(REPOSITORY_ROOT, "vercel.json");

type VercelConfig = {
  services?: Record<string, { root?: string; runtime?: string; entrypoint?: string; bindings?: unknown[] }>;
  daemons?: Record<string, { root?: string; entrypoint?: string; command?: string[] }>;
  rewrites?: { source: string; destination: { service: string } | string }[];
};

function readConfig(): VercelConfig {
  return JSON.parse(readFileSync(CONFIG_FILE, "utf8")) as VercelConfig;
}

function exists(relativePath: string): boolean {
  return existsSync(join(REPOSITORY_ROOT, relativePath));
}

/** Path check for services and daemons; `exists` is injected so tests can damage a copy. */
export function checkDeclarations(config: VercelConfig, exists: (path: string) => boolean): string[] {
  const problems: string[] = [];

  const services = Object.entries(config.services ?? {});
  assert.ok(services.length > 0, "vercel.json declares no services");
  for (const [name, service] of services) {
    if (!service.entrypoint) problems.push(`service "${name}" has no entrypoint`);
    else if (!exists(service.entrypoint)) problems.push(`service "${name}" entrypoint ${service.entrypoint} does not exist`);
    if (service.root && !exists(service.root)) problems.push(`service "${name}" root ${service.root} does not exist`);
    if (service.runtime === "container" && service.entrypoint && !service.entrypoint.toLowerCase().includes("dockerfile")) {
      problems.push(`service "${name}" is a container but its entrypoint is not a Dockerfile`);
    }
  }

  for (const [name, daemon] of Object.entries(config.daemons ?? {})) {
    if (!daemon.entrypoint) problems.push(`daemon "${name}" has no entrypoint`);
    else if (!exists(daemon.entrypoint)) problems.push(`daemon "${name}" entrypoint ${daemon.entrypoint} does not exist`);
    const command = daemon.command ?? [];
    if (command.length === 0) problems.push(`daemon "${name}" has no command`);
    // The command names the script to run; it must be a file, not a guessed path.
    const script = command.find((argument) => argument.endsWith(".ts") || argument.endsWith(".js") || argument.endsWith(".mjs"));
    if (script && !exists(script)) problems.push(`daemon "${name}" command runs ${script}, which does not exist`);
  }

  return problems;
}

/** Routing check: every destination names a declared service, and both prefixes are covered. */
export function checkRewrites(config: VercelConfig): string[] {
  const declared = new Set(Object.keys(config.services ?? {}));
  const problems: string[] = [];

  for (const rewrite of config.rewrites ?? []) {
    const service = typeof rewrite.destination === "string" ? undefined : rewrite.destination.service;
    if (!service) problems.push(`rewrite ${rewrite.source} has no service destination`);
    else if (!declared.has(service)) problems.push(`rewrite ${rewrite.source} points at undeclared service "${service}"`);
  }

  const api = (config.rewrites ?? []).find((rewrite) => rewrite.source.startsWith("/api/v1/"));
  const rest = (config.rewrites ?? []).find((rewrite) => rewrite.source === "/(.*)");
  if (!api) problems.push("nothing routes /api/v1/* to the API service");
  if (!rest) problems.push("nothing routes the public paths to the Web service");

  return problems;
}

test("every service and daemon in vercel.json names a file that exists", () => {
  const problems = checkDeclarations(readConfig(), exists);
  assert.deepEqual(problems, [], problems.join("\n"));
});

test("every rewrite points at a declared service, and the public routes still split API from Web", () => {
  const problems = checkRewrites(readConfig());
  assert.deepEqual(problems, [], problems.join("\n"));
});

test("the guard rejects a renamed entrypoint, a missing worker script and an undeclared rewrite target", () => {
  const config = readConfig();
  const renamed: VercelConfig = {
    ...config,
    services: { ...config.services, web: { ...config.services?.web, entrypoint: "apps/web-rr/Dockerfile.gone" } },
    daemons: {
      ...config.daemons,
      notifications: { ...config.daemons?.notifications, command: ["node", "apps/api/src/persistence/woker.ts"] },
    },
  };
  const problems = checkDeclarations(renamed, exists);
  assert.ok(problems.some((problem) => problem.includes("apps/web-rr/Dockerfile.gone does not exist")), problems.join("\n"));
  assert.ok(problems.some((problem) => problem.includes("woker.ts, which does not exist")), problems.join("\n"));

  const rerouted: VercelConfig = {
    ...config,
    rewrites: [{ source: "/(.*)", destination: { service: "worker" } }],
  };
  const routing = checkRewrites(rerouted);
  assert.ok(routing.some((problem) => problem.includes('undeclared service "worker"')), routing.join("\n"));
  assert.ok(routing.some((problem) => problem.includes("nothing routes /api/v1/*")), routing.join("\n"));
});
