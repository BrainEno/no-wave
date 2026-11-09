import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createPostgresClient } from "./postgres.ts";
import { runMigrations } from "./migrate.ts";
import { createSqliteClient, runSqliteMigrations } from "./sqlite.ts";
import {
  ProviderTransferError,
  getTransferTables,
  transferProviderData,
  type ProviderTransferReport,
  type TransferEndpoint,
  type TransferProvider,
  type TransferTableReport,
} from "./provider-migration-transfer.ts";

/**
 * `pnpm --filter @bot-thk/api db:transfer` — copy a database into an empty one.
 *
 * This is the operator-facing half of #247: the journal in this directory can
 * replay changes once a snapshot exists, and nothing produced the snapshot. The
 * transfer itself lives in `provider-migration-transfer.ts` (one transaction, one
 * reconciliation pass); this file is only the part a person types.
 *
 * Deliberate choices:
 *
 * - **Both ends are named explicitly.** A copy where one end is "the environment"
 *   and the other is a flag is a copy that eventually runs against production
 *   because a shell had an old `DATABASE_URL` in it. `--from` and `--to` take
 *   `provider:target`, and a bare provider is accepted only as a shorthand for
 *   that provider's configured database.
 * - **The target is migrated first, never silently.** Writing into a schema that
 *   is behind the code produces a copy that fails on the first missing column;
 *   applying the checked-in migrations first is the only version that can work.
 * - **A dry run touches nothing.** It reads the source, validates every row
 *   through the same allowlist the real run uses, and prints the plan.
 * - **Exit codes mean something to a script.** 0 copied and verified, 1 refused
 *   or failed, 2 bad usage.
 */

export type TransferEndpointSpec =
  | { provider: "sqlite"; path: string }
  | { provider: "postgres"; url: string };

export type TransferArgs = {
  from: TransferEndpointSpec;
  to: TransferEndpointSpec;
  dryRun: boolean;
  json: boolean;
  pageSize?: number;
  migrate: boolean;
  help: boolean;
};

const DEFAULT_SQLITE_PATH = "./data/no-wave.sqlite";

/** Strip the credentials a connection string carries before it is printed. */
export function redactTarget(target: string): string {
  if (!/:\/\//.test(target)) return target;
  try {
    const url = new URL(target);
    if (url.password) url.password = "***";
    return url.toString();
  } catch {
    return "<unparseable>";
  }
}

export function describeEndpoint(spec: TransferEndpointSpec): string {
  return spec.provider === "sqlite" ? `sqlite:${spec.path}` : `postgres:${redactTarget(spec.url)}`;
}

function parseEndpoint(value: string, flag: string, env: NodeJS.ProcessEnv): TransferEndpointSpec {
  const separator = value.indexOf(":");
  const provider = (separator === -1 ? value : value.slice(0, separator)) as TransferProvider;
  const target = separator === -1 ? "" : value.slice(separator + 1);
  if (provider === "sqlite") {
    const path = target || env.DATABASE_PATH || DEFAULT_SQLITE_PATH;
    if (!path.trim()) throw new Error(`${flag} needs a SQLite file path.`);
    return { provider: "sqlite", path: resolve(path) };
  }
  if (provider === "postgres") {
    const url = target || env.DATABASE_URL || "";
    if (!url.trim()) throw new Error(`${flag} needs a PostgreSQL connection string or DATABASE_URL.`);
    return { provider: "postgres", url };
  }
  throw new Error(`${flag} must be sqlite:<path> or postgres:<url>.`);
}

const USAGE = `Copy a whole no-wave database into an empty one.

Usage
  pnpm --filter @bot-thk/api db:transfer --from <source> --to <target> [options]

Endpoints
  sqlite:<path>     a SQLite file
  postgres:<url>    a PostgreSQL connection string
  sqlite | postgres on its own uses DATABASE_PATH / DATABASE_URL

Options
  --dry-run          read and validate the source, write nothing
  --no-migrate       do not apply pending migrations to the target first
  --page-size <n>    rows read per page (default 500, maximum 5000)
  --json             print the reconciliation report as JSON
  --help             this text

The source is read inside one snapshot and the target is written inside one
transaction, so the copy is consistent and all-or-nothing. The target must be
empty. Media bytes are not copied: the rows reference objects in the configured
storage, which must be the same backend or synchronised separately.

Tables copied (in foreign-key order)
  ${getTransferTables().entities.join(", ")}
  ${getTransferTables().associations.join(", ")} (written with its translation)
`;

export function parseTransferArgs(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): TransferArgs {
  let from: TransferEndpointSpec | null = null;
  let to: TransferEndpointSpec | null = null;
  let dryRun = false;
  let json = false;
  let migrate = true;
  let help = false;
  let pageSize: number | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    const [flag, inline] = argument.includes("=") ? [argument.slice(0, argument.indexOf("=")), argument.slice(argument.indexOf("=") + 1)] : [argument, undefined];
    const value = (): string => {
      const found = inline ?? argv[index + 1];
      if (found === undefined || found.startsWith("--")) throw new Error(`${flag} needs a value.`);
      if (inline === undefined) index += 1;
      return found;
    };
    switch (flag) {
      case "--from": from = parseEndpoint(value(), "--from", env); break;
      case "--to": to = parseEndpoint(value(), "--to", env); break;
      case "--dry-run": dryRun = true; break;
      case "--json": json = true; break;
      case "--no-migrate": migrate = false; break;
      case "--page-size": {
        const parsed = Number(value());
        if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error("--page-size must be a positive integer.");
        pageSize = parsed;
        break;
      }
      case "--help":
      case "-h": help = true; break;
      default: throw new Error(`Unknown option: ${argument}`);
    }
  }
  if (help) {
    // Endpoints are required for a real run only, so `--help` works on its own.
    return {
      from: from ?? { provider: "sqlite", path: DEFAULT_SQLITE_PATH },
      to: to ?? { provider: "postgres", url: "" },
      dryRun, json, pageSize, migrate, help,
    };
  }
  if (!from) throw new Error("--from is required.");
  if (!to) throw new Error("--to is required.");
  if (from.provider === "sqlite" && to.provider === "sqlite" && from.path === to.path) {
    throw new Error("The source and the target are the same SQLite file.");
  }
  if (from.provider === "postgres" && to.provider === "postgres" && from.url === to.url) {
    throw new Error("The source and the target are the same PostgreSQL database.");
  }
  return { from, to, dryRun, json, pageSize, migrate, help };
}

/**
 * A report a person can read without a JSON parser.
 *
 * Each table is one line, aligned so a mismatch stands out, and the last line is
 * the answer to the only question that matters: did it work, and what is not in
 * the copy.
 */
export function formatReport(report: ProviderTransferReport): string {
  const rows = report.tables.map((table: TransferTableReport) => {
    // A dry run compares nothing, so it must not print "MISMATCH" next to a
    // table that was never written — the status column says nothing instead.
    const status = report.applied ? (table.matched ? "ok" : "MISMATCH") : "";
    const target = report.applied ? String(table.targetRows) : "-";
    return `  ${table.table.padEnd(26)} ${String(table.sourceRows).padStart(7)} -> ${target.padStart(7)}  ${status}`.trimEnd();
  });
  const lines = [
    `source: ${report.source}`,
    `target: ${report.target}`,
    report.applied ? "mode:   copy" : "mode:   dry run (nothing written)",
    "",
    `  ${"table".padEnd(26)} ${"rows".padStart(7)}    ${"target".padStart(7)}`,
    ...rows,
    "",
    `  ${String(report.totalRows).padStart(7)} rows in ${report.tables.length} tables`,
    `  ${report.mediaAssets} media assets (the rows only — storage objects are not copied)`,
    "",
  ];
  if (!report.applied) {
    lines.push("  Source validated. Nothing was written; run again without --dry-run to copy.");
  } else if (report.ok) {
    lines.push("  Copied and reconciled: every table matches the source.");
  } else {
    lines.push("  The copy did NOT reconcile and was rolled back.");
  }
  return lines.join("\n");
}

async function openEndpoint(spec: TransferEndpointSpec): Promise<TransferEndpoint> {
  if (spec.provider === "sqlite") {
    return { provider: "sqlite", db: createSqliteClient({ filename: spec.path }) };
  }
  const sql = await createPostgresClient({ connectionString: spec.url, max: 2 });
  return { provider: "postgres", sql };
}

async function ensureSchema(endpoint: TransferEndpoint): Promise<void> {
  if (endpoint.provider === "sqlite") await runSqliteMigrations(endpoint.db);
  else await runMigrations(endpoint.sql);
}

async function closeEndpoint(endpoint: TransferEndpoint): Promise<void> {
  if (endpoint.provider === "sqlite") endpoint.db.close();
  else await endpoint.sql.end({ timeout: 5 });
}

export async function main(
  argv: readonly string[],
  io: { out: (line: string) => void; err: (line: string) => void } = {
    out: (line) => console.log(line),
    err: (line) => console.error(line),
  },
): Promise<number> {
  let args: TransferArgs;
  try {
    args = parseTransferArgs(argv);
  } catch (error) {
    io.err(`db:transfer: ${(error as Error).message}`);
    io.err("");
    io.err(USAGE);
    return 2;
  }
  if (args.help) {
    io.out(USAGE);
    return 0;
  }

  io.out(`db:transfer: ${describeEndpoint(args.from)} -> ${describeEndpoint(args.to)}`);
  let source: TransferEndpoint | null = null;
  let target: TransferEndpoint | null = null;
  try {
    source = await openEndpoint(args.from);
    target = await openEndpoint(args.to);
    if (!args.dryRun && args.migrate) {
      // Migrate before writing: a target schema that is behind the code fails on
      // the first missing column, and a partial copy is rolled back but the
      // operator learns nothing useful from the error.
      await ensureSchema(target);
      io.out("db:transfer: target schema is current");
    }
    const report = await transferProviderData({
      source,
      target,
      pageSize: args.pageSize,
      dryRun: args.dryRun,
      // Progress goes to stderr so `--json` output and the final table stay
      // machine-readable when the command is piped.
      onTable: args.json ? undefined : (table) => {
        const verdict = table.matched ? "ok" : args.dryRun ? "" : "mismatch";
        io.err(`  ${table.table.padEnd(26)} ${String(table.sourceRows).padStart(7)} rows ${verdict}`.trimEnd());
      },
    });
    if (args.json) io.out(JSON.stringify(report, null, 2));
    else io.out("");
    if (!args.json) io.out(formatReport(report));
    return report.ok ? 0 : 1;
  } catch (error) {
    const known = error instanceof ProviderTransferError ? `${error.code}: ${error.message}` : (error as Error).message;
    io.err(`db:transfer: ${known}`);
    return 1;
  } finally {
    if (source) await closeEndpoint(source).catch(() => {});
    if (target) await closeEndpoint(target).catch(() => {});
  }
}

const invokedDirectly = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (invokedDirectly) {
  // `import.meta.url` and argv agree only when this file is the entry point, so
  // importing it from a test does not start a transfer.
  process.exitCode = await main(process.argv.slice(2));
}
