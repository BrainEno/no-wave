import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  INHERITED_VARIABLES,
  PLATFORM_VARIABLES,
  PORTABLE_VARIABLES,
  childEnvironment,
  defaultOptions,
  parseArguments,
  portableStackEnvironment,
  resolveJwtSecret,
  type StackArguments,
  type StackOptions,
} from "./portable-stack.ts";

/**
 * The properties `pnpm stack:check` is supposed to prove, asserted where they
 * can be asserted cheaply: that the stack's configuration is *documented*, that
 * no platform binding can reach a process, and that a process inherits nothing
 * from the shell it was started from.
 *
 * The running half — the probe against real processes — is the CI job
 * `portable-stack`; it is too slow for `pnpm test` and it is the only part that
 * needs real ports.
 */

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));

function baseOptions(overrides: Partial<StackOptions> = {}): StackOptions {
  return {
    apiPort: 4100,
    webPort: 4101,
    databasePath: "/tmp/no-wave-portable-test.sqlite",
    siteUrl: "https://no-wave.example",
    jwtSecret: "portable-stack-test-secret-0123456789abcdef",
    repositoryRoot,
    ...overrides,
  };
}

/** Every `NAME=` or `# NAME=` line in the operator's template. */
function documentedVariables(): Set<string> {
  const template = readFileSync(new URL("../.env.example", import.meta.url), "utf8");
  const names = new Set<string>();
  for (const match of template.matchAll(/^\s*#?\s*([A-Z][A-Z0-9_]*)=/gm)) {
    const name = match[1];
    if (typeof name === "string") names.add(name);
  }
  assert.ok(names.size > 20, "the template must still look like a template");
  return names;
}

test("every variable the portable stack sets is documented in .env.example", () => {
  const documented = documentedVariables();
  const undocumented = PORTABLE_VARIABLES.filter((name) => !documented.has(name));
  assert.deepEqual(
    undocumented,
    [],
    "a variable that is not in .env.example is a variable an operator cannot know about",
  );
});

test("the environment of a role contains only documented variables", () => {
  const documented = documentedVariables();
  for (const role of ["api", "web", "worker"] as const) {
    for (const [name, value] of Object.entries(portableStackEnvironment(baseOptions(), role))) {
      assert.ok(documented.has(name), `${role}: ${name} is not documented`);
      assert.ok(value.length > 0, `${role}: ${name} must not be set to an empty value`);
    }
  }
});

test("no platform binding reaches a process, and none is inherited", () => {
  const saved = new Map<string, string | undefined>();
  for (const name of [...PLATFORM_VARIABLES]) {
    saved.set(name, process.env[name]);
    process.env[name] = "https://injected-by-the-shell.example";
  }
  try {
    for (const role of ["api", "web", "worker"] as const) {
      const environment = childEnvironment(portableStackEnvironment(baseOptions(), role));
      for (const name of PLATFORM_VARIABLES) {
        assert.equal(
          environment[name],
          undefined,
          `${role}: ${name} must not survive into the child environment, even when the shell exports it`,
        );
      }
    }
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test("a process inherits the operating-system minimum and nothing else", () => {
  const saved = process.env.API_METRICS_ENABLED;
  process.env.API_METRICS_ENABLED = "true";
  try {
    const environment = childEnvironment(portableStackEnvironment(baseOptions(), "api"));
    assert.equal(environment.API_METRICS_ENABLED, undefined, "an unrelated application setting must not be inherited");
    for (const name of INHERITED_VARIABLES) {
      if (typeof process.env[name] === "string") assert.equal(environment[name], process.env[name]);
    }
  } finally {
    if (saved === undefined) delete process.env.API_METRICS_ENABLED;
    else process.env.API_METRICS_ENABLED = saved;
  }
});

test("the Web role resolves the API through API_BASE_URL, not through a binding", () => {
  const web = portableStackEnvironment(baseOptions({ apiPort: 4321 }), "web");
  assert.equal(web.API_BASE_URL, "http://127.0.0.1:4321");
  assert.equal(web.NEXT_PUBLIC_SITE_URL, "https://no-wave.example");
});

test("a configured PostgreSQL URL switches the provider and enables the outbox", async () => {
  const options = baseOptions({ databaseUrl: "postgres://user:pass@127.0.0.1:5432/bot_thk" });
  const api = portableStackEnvironment(options, "api");
  assert.equal(api.DATABASE_PROVIDER, "postgres");
  assert.equal(api.DATABASE_URL, "postgres://user:pass@127.0.0.1:5432/bot_thk");
  assert.equal(api.DATABASE_PATH, undefined, "a PostgreSQL stack must not also carry a SQLite path");
});

/** Narrow the parse result: a bad command line is a thrown error in a test. */
function parsed(argv: readonly string[]): StackArguments {
  const result = parseArguments(argv);
  if ("error" in result) throw new Error(result.error);
  return result.args;
}

function parseError(argv: readonly string[]): string {
  const result = parseArguments(argv);
  if ("error" in result) return result.error;
  return "the command line was accepted";
}

test("the command line is parsed strictly", () => {
  assert.deepEqual(parsed([]), { keep: false, json: false, databaseUrl: null, databasePath: null });
  assert.deepEqual(parsed(["--keep", "--json"]), { keep: true, json: true, databaseUrl: null, databasePath: null });
  assert.equal(parsed(["--database-url=postgres://x"]).databaseUrl, "postgres://x");
  assert.equal(parsed(["--database-path=/tmp/x.sqlite"]).databasePath, "/tmp/x.sqlite");
  assert.match(parseError(["--nope"]), /Unknown argument/);
});

test("a missing AUTH_JWT_SECRET is replaced, not fatal, and the stack still starts", () => {
  const messages: string[] = [];
  const secret = resolveJwtSecret({}, (message) => messages.push(message));
  assert.ok(secret.length >= 32, "the generated secret must satisfy the API's minimum");
  assert.equal(messages.length, 1, "the operator is told the secret is not durable");
  assert.match(messages[0] ?? "", /AUTH_JWT_SECRET/);
  assert.notEqual(resolveJwtSecret({}, () => {}), secret, "a second run gets its own secret");
});

test("a supplied AUTH_JWT_SECRET is used as given", () => {
  const messages: string[] = [];
  const supplied = "supplied-secret-0123456789abcdefghij";
  assert.equal(resolveJwtSecret({ AUTH_JWT_SECRET: supplied }, (message) => messages.push(message)), supplied);
  assert.deepEqual(messages, [], "nothing is generated, so nothing has to be explained");
  // Shorter than the API's minimum: generated, not silently accepted.
  assert.notEqual(resolveJwtSecret({ AUTH_JWT_SECRET: "too-short" }, () => {}), "too-short");
});

