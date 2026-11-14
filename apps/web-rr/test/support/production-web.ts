import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";

async function freePort(): Promise<number> {
  const socket = createServer();
  await new Promise<void>((resolve, reject) => {
    socket.once("error", reject);
    socket.listen(0, "0.0.0.0", resolve);
  });
  const address = socket.address();
  await new Promise<void>((resolve, reject) => socket.close((error) => error ? reject(error) : resolve()));
  if (!address || typeof address === "string") throw new Error("No production-test port.");
  return address.port;
}

/** Shared production process: no dev server, fixed port or inherited public API binding. */
export async function startProductionWeb(environment: Record<string, string>) {
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const app = spawn(process.execPath, ["server.ts"], {
    cwd: new URL("../../", import.meta.url),
    env: { ...process.env, NODE_ENV: "production", HOST: "0.0.0.0", PORT: String(port),
      API_SERVICE_URL: "", API_GRAPHQL_URL: "", ...environment },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  const capture = (chunk: Buffer) => { output = (output + chunk.toString()).slice(-128_000); };
  app.stdout?.on("data", capture);
  app.stderr?.on("data", capture);
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
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      if (spawnError) throw new Error("Production test process could not start.");
      if (app.exitCode !== null) throw new Error(`Production test process exited ${app.exitCode}.`);
      try {
        const ready = await fetch(`${origin}/healthz`, { signal: AbortSignal.timeout(1000) });
        await ready.body?.cancel();
        if (ready.ok) return { origin, close, output: () => output, signal: (signal: NodeJS.Signals) => app.kill(signal) };
      } catch { /* Startup probe only; assertions are never retried. */ }
      await delay(50);
    }
    throw new Error("Production test process did not become ready.");
  } catch (error) {
    await close();
    throw error;
  }
}
