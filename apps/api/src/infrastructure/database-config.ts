import { resolve } from "node:path";

export type DatabaseProvider = "sqlite" | "postgres" | "mongodb";

export function resolveDatabaseProvider({
  provider,
  env = process.env,
}: {
  provider?: string;
  env?: NodeJS.ProcessEnv;
} = {}): string {
  // A pre-existing DATABASE_URL without DATABASE_PROVIDER keeps using Postgres
  // rather than risking an accidental connection to an empty SQLite database.
  // Fresh installs with no legacy Postgres URL prefer SQLite.
  const selected = provider ?? env.DATABASE_PROVIDER ?? (env.DATABASE_URL ? "postgres" : "sqlite");
  if (typeof selected !== "string" || selected.trim() !== selected || selected.length === 0) {
    throw new TypeError("DATABASE_PROVIDER must be a non-empty provider name.");
  }
  return selected;
}

export function resolveSqliteDatabasePath({
  env = process.env,
  cwd = process.cwd(),
}: {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
} = {}): string {
  const configured = env.DATABASE_PATH ?? "data/no-wave.sqlite";
  if (typeof configured !== "string" || configured.trim() !== configured || configured.length === 0) {
    throw new TypeError("DATABASE_PATH must be a non-empty path without surrounding whitespace.");
  }
  if (configured === ":memory:") return configured;
  return resolve(cwd, configured);
}
