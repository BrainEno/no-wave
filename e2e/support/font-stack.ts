import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { isolatedEnvironment } from "../../scripts/e2e-runner.ts";
import { freePort } from "../../scripts/portable-stack.ts";

export type FontStack = { apiBaseUrl: string; webBaseUrl: string; databasePath: string; close(): Promise<void> };

/**
 * Performance fixtures must not depend on which other journeys created related
 * articles first. Use the same real production build/API, but a private SQLite
 * database and ephemeral ports, never a mocked/truncated reader response.
 */
export async function startFontStack(): Promise<FontStack> {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const directory = await mkdtemp(join(tmpdir(), "no-wave-fonts-"));
  const children: ChildProcess[] = [];
  const errors: string[] = [];
  let output = "";
  const apiPort = await freePort();
  let webPort = await freePort();
  while (webPort === apiPort) webPort = await freePort();
  const env = isolatedEnvironment(process.env, { apiPort, webPort,
    databasePath: join(directory, "fonts.sqlite"), secret: randomBytes(32).toString("hex") });
  const apiBaseUrl = `http://127.0.0.1:${apiPort}`;
  const webBaseUrl = `http://127.0.0.1:${webPort}`;

  const stop = (child: ChildProcess) => new Promise<void>((resolve) => {
    if (!child.pid || child.exitCode !== null || child.signalCode !== null) { resolve(); return; }
    const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
    child.once("exit", () => { clearTimeout(timer); resolve(); });
    child.kill("SIGTERM");
  });
  const close = async () => {
    try { await Promise.all(children.map(stop)); }
    finally { await rm(directory, { recursive: true, force: true }); }
  };
  const start = (file: string, cwd: string, settings: NodeJS.ProcessEnv) => {
    const child = spawn(process.execPath, [file], { cwd, env: settings, stdio: ["ignore", "pipe", "pipe"] });
    children.push(child);
    child.on("error", (error) => errors.push(error.message));
    const capture = (chunk: Buffer) => { output = (output + chunk.toString()).slice(-6000); };
    child.stdout?.on("data", capture);
    child.stderr?.on("data", capture);
  };
  const ready = async (url: string) => {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (errors.length || children.some((child) => child.exitCode !== null || child.signalCode !== null)) {
        throw new Error(`Font fixture process exited: ${errors.join("; ")}\n${output}`);
      }
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(1000) });
        await response.text();
        if (response.status === 200) return;
      } catch { /* wait for the disposable process to bind and finish startup */ }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`Font fixture did not become ready: ${url}\n${output}`);
  };
  try {
    await promisify(execFile)(process.execPath, ["apps/api/src/persistence/migrate.ts"], { cwd: root, env, timeout: 30_000 });
    start("apps/api/src/server.ts", root, env);
    start("server.ts", join(root, "apps/web-rr"), { ...env, PORT: String(webPort) });
    await Promise.all([ready(`${apiBaseUrl}/ready`), ready(`${webBaseUrl}/healthz`)]);
    return { apiBaseUrl, webBaseUrl, databasePath: join(directory, "fonts.sqlite"), close };
  } catch (error) { await close(); throw error; }
}
