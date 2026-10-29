/**
 * `pnpm setup:local [--postgres] [--force] [--print]`
 *
 * Creates `<repository>/.env.local`, the single environment file consumed by
 * both the API and the Web dev server. The point of this script is the JWT
 * secret: the API requires at least 32 bytes and reports a missing or short
 * secret only as `503 SERVICE_UNAVAILABLE` on the authentication routes, which
 * is indistinguishable from a real outage. Generating a valid secret removes
 * that failure mode from the first-run path.
 *
 * The script never overwrites an existing file unless `--force` is passed, and
 * it never writes anything outside the git-ignored `.env.local` path.
 */
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { relative } from "node:path";
import {
  buildLocalEnvFile,
  DEFAULT_API_PORT,
  DEFAULT_POSTGRES_URL,
  localEnvFile,
  repositoryRoot,
} from "./lib/local-dev-config.ts";

type SetupArguments = { postgres: boolean; force: boolean; print: boolean };

export function parseSetupArguments(argv: readonly string[]): { args?: SetupArguments; error?: string } {
  const args: SetupArguments = { postgres: false, force: false, print: false };
  for (const argument of argv) {
    if (argument === "--postgres") args.postgres = true;
    else if (argument === "--force") args.force = true;
    else if (argument === "--print") args.print = true;
    else return { error: `Unknown option "${argument}". Supported: --postgres, --force, --print.` };
  }
  return { args };
}

/** 48 random bytes render as 64 URL-safe characters: well above the 32-byte floor. */
export function generateAuthSecret(): string {
  return randomBytes(48).toString("base64url");
}

function existingKeys(path: string): string[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split(/\r?\n/)
    .map((line) => /^\s*([A-Z][A-Z0-9_]*)\s*=/.exec(line)?.[1])
    .filter((key): key is string => typeof key === "string");
}

function main(): void {
  const parsed = parseSetupArguments(process.argv.slice(2));
  if (!parsed.args) {
    process.stderr.write(`${parsed.error}\n`);
    process.exitCode = 2;
    return;
  }
  const { postgres, force, print } = parsed.args;

  const content = buildLocalEnvFile({
    jwtSecret: generateAuthSecret(),
    provider: postgres ? "postgres" : "sqlite",
    databaseUrl: process.env.DATABASE_URL ?? DEFAULT_POSTGRES_URL,
    testDatabaseUrl: process.env.TEST_DATABASE_URL,
    apiPort: Number(process.env.PORT) || DEFAULT_API_PORT,
  });

  if (print) {
    process.stdout.write(content);
    return;
  }

  if (existsSync(localEnvFile) && !force) {
    process.stdout.write([
      `${relative(repositoryRoot, localEnvFile)} already exists; nothing was written.`,
      `Existing keys: ${existingKeys(localEnvFile).join(", ") || "(none)"}`,
      "",
      "Use `pnpm setup:local --force` to regenerate it, or keep the current file and run `pnpm dev`.",
      "",
    ].join("\n"));
    return;
  }

  writeFileSync(localEnvFile, content, { encoding: "utf8", mode: 0o600 });

  const next = postgres
    ? [
        "Next steps:",
        "  1. pnpm db:up        # start PostgreSQL 17 in Docker (dev + test databases)",
        "  2. pnpm db:migrate   # apply the versioned schema migrations",
        "  3. pnpm dev          # start the API (:4000) and the Web dev server (:3000)",
        "  4. pnpm check:local  # verify database -> API -> Web connectivity",
      ]
    : [
        "Next steps:",
        "  1. pnpm db:migrate   # create the local SQLite schema",
        "  2. pnpm dev          # start the API (:4000) and the Web dev server (:3000)",
        "  3. pnpm check:local  # verify database -> API -> Web connectivity",
      ];

  process.stdout.write([
    `Wrote ${relative(repositoryRoot, localEnvFile)} (provider: ${postgres ? "postgres" : "sqlite"}, mode 0600).`,
    "It is git-ignored and contains a randomly generated development JWT secret.",
    "",
    ...next,
    "",
  ].join("\n"));
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main();
}
