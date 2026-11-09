/**
 * `pnpm notion:seed` — import a Notion database as ordinary articles.
 *
 *   pnpm notion:seed --bundle notion-bundle.json              # dry run: what would happen
 *   pnpm notion:seed --bundle notion-bundle.json --apply      # do it
 *   pnpm notion:seed --notion-database <id> --apply           # fetch, then do it
 *   pnpm notion:seed --notion-database <id> --write-bundle notions.json
 *
 * Input is a **bundle**: one database's pages and blocks in Notion's own shape.
 * `--notion-database` fetches it with `NOTION_TOKEN`; `--bundle` reads one that
 * was captured earlier (by this script or by any other client). Both paths feed
 * the same parser, so a bundle is a portable artifact — and the same document is
 * what a user's own import will post to the API in a later phase.
 *
 * What the run guarantees, in plain words:
 *
 *   - **Nothing is written without `--apply`.** The default prints the plan.
 *   - **`Published: false` becomes a draft** — visible in the author's desk and
 *     nowhere else, exactly as if it had been saved there.
 *   - **Re-running is safe.** Creates carry a per-page `Idempotency-Key` the API
 *     stores (ADR 0019); the state file's digest turns an unchanged page into a
 *     `skip` instead of a rewrite.
 *   - **Losses are printed.** Every block or property the mapping could not carry
 *     is counted by issue code at the end.
 *
 * The mechanics live in `scripts/lib/notion-seed-run.ts` (talking to the API) and
 * `scripts/lib/notion-bundle.ts` (deciding what to write); this file is flags and
 * a report.
 */
import { runNotionSeed, type SeedArgs, type SeedOutcome } from "./lib/notion-seed-run.ts";

const DEFAULT_API = "http://127.0.0.1:3000";
const DEFAULT_STATE = ".notion-seed-state.json";

const HELP = `notion:seed — import a Notion database as ordinary articles

  --bundle <file>        read a captured bundle (pages + blocks)
  --notion-database <id> fetch the database with NOTION_TOKEN instead
  --write-bundle <file>  save the fetched bundle, so the next run can reuse it
  --api <url>            API base URL (default $API_BASE_URL or ${DEFAULT_API})
  --email / --password   author account (default $NOTION_SEED_EMAIL / $NOTION_SEED_PASSWORD)
  --state <file>         import state (default ${DEFAULT_STATE})
  --apply                actually write; without it this is a dry run
  --json                 machine-readable report

The author account must already exist and have a filled-in profile: the web app
hides articles whose author has none (see scripts/verify-publish.ts).`;

function parseArgs(argv: readonly string[], env: NodeJS.ProcessEnv): SeedArgs | null {
  const args: SeedArgs = {
    bundle: null,
    notionDatabase: env.NOTION_DATABASE_ID ?? null,
    notionToken: env.NOTION_TOKEN ?? null,
    api: env.API_BASE_URL ?? DEFAULT_API,
    email: env.NOTION_SEED_EMAIL ?? null,
    password: env.NOTION_SEED_PASSWORD ?? null,
    state: DEFAULT_STATE,
    writeBundle: null,
    apply: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]!;
    const value = (): string => {
      const next = argv[index + 1];
      if (next === undefined) throw new Error(`${flag} needs a value.`);
      index += 1;
      return next;
    };
    switch (flag) {
      case "--bundle": args.bundle = value(); break;
      case "--notion-database": args.notionDatabase = value(); break;
      case "--notion-token": args.notionToken = value(); break;
      case "--api": args.api = value(); break;
      case "--email": args.email = value(); break;
      case "--password": args.password = value(); break;
      case "--state": args.state = value(); break;
      case "--write-bundle": args.writeBundle = value(); break;
      case "--apply": args.apply = true; break;
      case "--json": return args;
      case "--help":
      case "-h":
        console.log(HELP);
        return null;
      default:
        throw new Error(`Unknown option ${flag}. Run with --help.`);
    }
  }
  return args;
}

function issueHistogram(outcomes: readonly SeedOutcome[]): [string, number][] {
  const counts = new Map<string, number>();
  for (const outcome of outcomes) {
    for (const issue of outcome.issues) counts.set(issue.code, (counts.get(issue.code) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

function printReport(outcomes: readonly SeedOutcome[], applied: boolean): void {
  const width = Math.max(4, ...outcomes.map((outcome) => outcome.title.length));
  for (const outcome of outcomes) {
    const locale = outcome.locale.length > 0 ? `[${outcome.locale}] ` : "";
    const slug = outcome.slug.length > 0 ? ` /${outcome.slug}` : "";
    console.log(`  ${outcome.action.padEnd(7)} ${locale}${outcome.title.padEnd(width)}${slug}  ${outcome.detail}`);
  }
  const tally = (action: SeedOutcome["action"]): number => outcomes.filter((outcome) => outcome.action === action).length;
  console.log("");
  console.log(`  ${applied ? "written" : "dry run (no writes)"}: ${tally("create")} create, ${tally("update")} update, ${tally("skip")} skip, ${tally("refused")} refused, ${tally("failed")} failed`);
  const histogram = issueHistogram(outcomes);
  if (histogram.length > 0) {
    console.log("  what could not be carried:");
    for (const [code, count] of histogram) console.log(`    ${String(count).padStart(4)}  ${code}`);
  }
  if (!applied) console.log("\n  nothing was written. Re-run with --apply.");
}

async function main(): Promise<void> {
  const json = process.argv.includes("--json");
  const args = parseArgs(process.argv.slice(2), process.env);
  if (args === null) return;
  const run = await runNotionSeed(args);
  if (json) {
    console.log(JSON.stringify({ applied: run.applied, outcomes: run.outcomes }, null, 2));
  } else {
    console.log(`\nNotion seed → ${args.api}\n`);
    printReport(run.outcomes, run.applied);
  }
  if (run.outcomes.some((outcome) => outcome.action === "failed")) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
