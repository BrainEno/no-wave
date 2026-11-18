import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

export const TEST_GROUPS = ["root", "api-unit", "api-integration", "web"] as const;
export type TestGroup = (typeof TEST_GROUPS)[number];
const excluded = new Set(["node_modules", "build", "dist", "coverage", ".react-router", ".git", ".arena"]);
function walk(root: string, directory: string, files: string[]): void {
  const absolute = join(root, directory);
  if (!existsSync(absolute)) return;
  for (const entry of readdirSync(absolute, { withFileTypes: true })) {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory() && !excluded.has(entry.name)) walk(root, path, files);
    else if (entry.isFile() && entry.name.endsWith(".test.ts")) files.push(path);
  }
}
function apiIntegration(file: string): boolean {
  // Preserve the existing pure persistence unit groups, while provider/store
  // contracts (including old non-*.integration names) default to integration.
  if (/\/persistence\/(?:migrate|provider-migration-(?:journal|transfer)|sqlite-media-store|outbox-(?:drain|metrics|retry-policy))\.test\.ts$/.test(file)) return false;
  return file.startsWith("apps/api/src/persistence/") || file.endsWith(".integration.test.ts") ||
    /\/infrastructure\/(?:worker|api-startup)-process\.test\.ts$/.test(file);
}

export function discoverTests(group: TestGroup, root: string): string[] {
  if (!(TEST_GROUPS as readonly string[]).includes(group)) throw new Error("Unknown test group.");
  const files: string[] = [];
  if (group === "root") for (const directory of ["scripts", "packages/web-http/test", "packages/web-ui/src", "apps/api/src"]) walk(root, directory, files);
  else if (group === "web") walk(root, "apps/web-rr/test", files);
  else {
    walk(root, "apps/api/src", files);
    const selected = files.filter(file => group === "api-integration" ? apiIntegration(file) : !apiIntegration(file));
    if (group === "api-integration") {
      // These intentionally verify a shared real PostgreSQL ledger in two Web
      // processes. They are also in the production Web suite, never unit tests.
      const web: string[] = [];
      walk(root, "apps/web-rr/test", web);
      selected.push(...web.filter(file => /\/refresh-shared(?:\.integration|-web)\.test\.ts$/.test(file)));
      const notifications = "scripts/dev-notifications.test.ts";
      if (existsSync(join(root, notifications))) selected.push(notifications);
    }
    return [...new Set(selected)].sort();
  }
  return [...new Set(files)].sort();
}

/** No shell expansion; the exact same discovery is used locally and by CI. */
export function nodeTestArguments(group: TestGroup, root: string, annotations = true): string[] {
  const files = discoverTests(group, root);
  if (!files.length) throw new Error(`No tests discovered for ${group}.`);
  return ["--test", "--test-concurrency=1", "--test-reporter=spec", ...(annotations
    ? ["--test-reporter-destination=stdout", `--test-reporter=${join(root, "scripts/github-test-reporter.ts")}`, "--test-reporter-destination=stdout"] : []),
    ...files.map(file => join(root, file))];
}
