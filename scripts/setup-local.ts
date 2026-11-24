/**
 * `pnpm setup:local [--postgres] [--force] [--print] [--migrate] [--all]`
 *
 * Creates `<repository>/.env.local`, the single environment file consumed by
 * both the API and the Web dev server. The point of this script is the JWT
 * secret: the API requires at least 32 bytes and reports a missing or short
 * secret only as `503 SERVICE_UNAVAILABLE` on the authentication routes, which
 * is indistinguishable from a real outage. Generating a valid secret removes
 * that failure mode from the first-run path.
 *
 * Options:
 *   --postgres   Configure for local PostgreSQL (docker compose) instead of SQLite.
 *   --force, -f  Overwrite .env.local if it already exists.
 *   --print      Print the generated .env.local content to stdout without writing.
 *   --migrate    Apply database schema migrations immediately.
 *   --all, -a    One-stop full setup: write .env.local, apply migrations, and prepare fonts.
 *
 * The script never overwrites an existing file unless `--force` is passed, and
 * it never writes anything outside the git-ignored `.env.local` path.
 */
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import {
  buildLocalEnvFile,
  DEFAULT_API_PORT,
  DEFAULT_SQLITE_PATH,
  isLocalDatabaseUrl,
  localEnvFile,
  repositoryRoot,
} from "./lib/local-dev-config.ts";

export type SetupArguments = {
  postgres: boolean;
  force: boolean;
  print: boolean;
  migrate: boolean;
  all: boolean;
};

export function parseSetupArguments(argv: readonly string[]): {
  args?: SetupArguments;
  error?: string;
} {
  const args: SetupArguments = {
    postgres: false,
    force: false,
    print: false,
    migrate: false,
    all: false,
  };
  for (const argument of argv) {
    if (argument === "--postgres") args.postgres = true;
    else if (argument === "--force" || argument === "-f") args.force = true;
    else if (argument === "--print") args.print = true;
    else if (argument === "--migrate" || argument === "-m") args.migrate = true;
    else if (argument === "--all" || argument === "-a") {
      args.all = true;
      args.migrate = true;
    } else
      return {
        error: `Unknown option "${argument}". Supported: --postgres, --force, --print, --migrate, --all.`,
      };
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

async function applyMigrations(postgres: boolean): Promise<void> {
  if (!postgres) {
    process.stdout.write("Applying SQLite schema migrations...\n");
    const { createSqliteClient, runSqliteMigrations } =
      await import("../apps/api/src/persistence/sqlite.ts");
    const dbPath = resolve(repositoryRoot, DEFAULT_SQLITE_PATH);
    await mkdir(dirname(dbPath), { recursive: true });
    const db = createSqliteClient({ filename: dbPath });
    try {
      const applied = await runSqliteMigrations(db);
      process.stdout.write(
        `SQLite schema up to date (${applied.length} migration(s) applied).\n`,
      );
    } finally {
      db.close();
    }
  } else {
    process.stdout.write(
      "For PostgreSQL, ensure the container is running ('pnpm db:up') then run 'pnpm db:migrate'.\n",
    );
  }
}

async function prepareFonts(): Promise<void> {
  process.stdout.write("Preparing first-party fonts...\n");
  const { execFileSync } = await import("node:child_process");
  execFileSync(
    process.execPath,
    [resolve(repositoryRoot, "scripts/fonts/generate.ts"), "--prepare"],
    {
      cwd: repositoryRoot,
      stdio: "inherit",
      env: process.env,
    },
  );
}

async function main(): Promise<void> {
  const parsed = parseSetupArguments(process.argv.slice(2));
  if (!parsed.args) {
    process.stderr.write(`${parsed.error}\n`);
    process.exitCode = 2;
    return;
  }
  const { postgres, force, print, migrate, all } = parsed.args;
  const requestedDatabaseUrl = process.env.DATABASE_URL;
  const databaseUrl = isLocalDatabaseUrl(requestedDatabaseUrl)
    ? requestedDatabaseUrl
    : undefined;
  const ignoredExternalDatabaseUrl =
    Boolean(requestedDatabaseUrl?.trim()) && databaseUrl === undefined;

  const content = buildLocalEnvFile({
    jwtSecret: generateAuthSecret(),
    provider: postgres ? "postgres" : "sqlite",
    databaseUrl,
    testDatabaseUrl: process.env.TEST_DATABASE_URL,
    apiPort: Number(process.env.PORT) || DEFAULT_API_PORT,
  });

  if (print) {
    if (postgres && ignoredExternalDatabaseUrl) {
      process.stderr.write(
        "note   Ignored an external DATABASE_URL from the shell; local PostgreSQL uses compose.yaml, not Neon.\n",
      );
    }
    process.stdout.write(content);
    return;
  }

  const envExists = existsSync(localEnvFile);
  if (envExists && !force) {
    process.stdout.write(
      [
        `${relative(repositoryRoot, localEnvFile)} already exists; nothing was written.`,
        `Existing keys: ${existingKeys(localEnvFile).join(", ") || "(none)"}`,
        "",
      ].join("\n"),
    );
  } else {
    writeFileSync(localEnvFile, content, { encoding: "utf8", mode: 0o600 });
    process.stdout.write(
      [
        `Wrote ${relative(repositoryRoot, localEnvFile)} (provider: ${postgres ? "postgres" : "sqlite"}, mode 0600).`,
        "It is git-ignored and contains a randomly generated development JWT secret.",
        ...(postgres && ignoredExternalDatabaseUrl
          ? [
              "note   Ignored an external DATABASE_URL from the shell; local PostgreSQL uses compose.yaml, not Neon.",
            ]
          : []),
        "",
      ].join("\n"),
    );
  }

  if (migrate || all) {
    await applyMigrations(postgres);
  }

  if (all) {
    await prepareFonts();
  }

  if (all) {
    process.stdout.write(
      "\nAll-in-one setup complete! You can now run:\n  pnpm dev\n\n",
    );
    return;
  }

  const next = postgres
    ? [
        "Next steps:",
        "  1. pnpm db:up        # start the local PostgreSQL 17 container (not Neon)",
        "  2. pnpm db:migrate   # apply the versioned schema migrations",
        "  3. pnpm dev          # start the API (:4000) and the Web dev server (:3000)",
        "  4. pnpm check:local  # verify database -> API -> Web connectivity",
      ]
    : [
        "Next steps:",
        ...(migrate
          ? []
          : ["  1. pnpm db:migrate   # create the local SQLite schema"]),
        `  ${migrate ? "1" : "2"}. pnpm dev          # start the API (:4000) and the Web dev server (:3000)`,
        `  ${migrate ? "2" : "3"}. pnpm check:local  # verify database -> API -> Web connectivity`,
      ];

  process.stdout.write([...next, ""].join("\n"));
}

if (
  process.argv[1] &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href
) {
  await main();
}
