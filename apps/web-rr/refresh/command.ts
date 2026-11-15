import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { PostgresRefreshStore } from "./postgres-store.ts";
import { RefreshResultCodec } from "./result-codec.ts";
import { resolveRefreshSettings } from "./settings.ts";

export async function runRefreshCommand(args: readonly string[], env: NodeJS.ProcessEnv): Promise<Readonly<Record<string, unknown>>> {
  const command = args[0];
  if (args.length !== 1 || !["migrate", "check", "status", "sweep"].includes(command ?? "")) {
    throw new Error("Usage: pnpm web:refresh migrate|check|status|sweep");
  }
  const settings = resolveRefreshSettings(env);
  if (settings.mode !== "postgres") throw new Error("This command requires the postgres Web refresh coordinator.");
  const codec = new RefreshResultCodec(settings.encryptionKey);
  const store = new PostgresRefreshStore(settings, codec.fingerprint);
  try {
    if (command === "migrate") {
      await store.migrate();
      return { event: "web_refresh_schema_ready", protocol: 1 };
    }
    await store.verify();
    if (command === "check") return { event: "web_refresh_coordination_checked", ready: true };
    if (command === "status") return { event: "web_refresh_coordination_status", ...await store.inspect() };
    let removed = 0;
    let passes = 0;
    for (; passes < 20; passes++) {
      const count = await store.sweep(256); removed += count;
      if (count === 0) return { event: "web_refresh_sweep_completed", removed, passes: passes + 1, converged: true };
    }
    return { event: "web_refresh_sweep_completed", removed, passes, converged: false };
  } finally {
    codec.dispose();
    if (!await store.close()) throw new Error("Web refresh command could not close its database work cleanly.");
  }
}

async function main(): Promise<void> {
  for (const relative of ["../../../.env.local", "../../../.env"]) {
    const path = fileURLToPath(new URL(relative, import.meta.url));
    if (existsSync(path)) process.loadEnvFile(path);
  }
  try { process.stdout.write(JSON.stringify(await runRefreshCommand(process.argv.slice(2), process.env)) + "\n"); }
  catch { process.stderr.write("Web refresh command failed. Check the command, shared policy, migration and database availability.\n"); process.exitCode = 1; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
