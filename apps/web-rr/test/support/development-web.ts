import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { resolveWebBuildCli } from "../../../../scripts/lib/web-build-cli.ts";

/** Boot the real Vite/React Router CLI: no mocked middleware or SSR module loader. */
export async function startDevelopmentWeb(environment: Record<string, string>) {
  const reserved = createServer();
  await new Promise<void>((resolve, reject) => { reserved.once("error", reject); reserved.listen(0, "0.0.0.0", resolve); });
  const address = reserved.address();
  await new Promise<void>((resolve) => reserved.close(() => resolve()));
  if (!address || typeof address === "string") throw new Error("No development-test port.");
  const origin = `http://127.0.0.1:${address.port}`;
  const cli = resolveWebBuildCli(fileURLToPath(new URL("../../../../", import.meta.url)));
  const app = spawn(process.execPath, [cli, "dev", "--strictPort"], {
    cwd: new URL("../../", import.meta.url),
    env: { ...process.env, NODE_ENV: "development", HOST: "0.0.0.0", PORT: String(address.port),
      API_SERVICE_URL: "", API_GRAPHQL_URL: "", WEB_DEV_ALLOWED_ORIGINS: "", ...environment },
    stdio: "ignore",
  });
  let spawnError: Error | undefined;
  app.once("error", (error) => { spawnError = error; });
  const close = async () => {
    if (app.exitCode !== null || app.signalCode !== null || spawnError) return;
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => app.kill("SIGKILL"), 3000);
      app.once("exit", () => { clearTimeout(timeout); resolve(); });
      app.kill("SIGTERM");
    });
  };
  try {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (spawnError) throw new Error("Development test process could not start.");
      if (app.exitCode !== null) throw new Error(`Development test process exited ${app.exitCode}.`);
      try {
        const ready = await fetch(`${origin}/@vite/client`, { signal: AbortSignal.timeout(1000) });
        await ready.body?.cancel();
        if (ready.ok) return { origin, close };
      } catch { /* Readiness only; actual assertions do not retry. */ }
      await delay(50);
    }
    throw new Error("Development test process did not become ready.");
  } catch (error) { await close(); throw error; }
}
