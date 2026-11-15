import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { probeDevService } from "./dev-service-probe.ts";

export type DevRole = "api" | "worker" | "web";
export type DevChild = {
  role: DevRole;
  label: string;
  child: ChildProcess;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  result: { code: number | null; signal: NodeJS.Signals | null } | null;
};
type Launch = { role: DevRole; label: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv; acceptableStopExitCodes?: readonly number[] };
type Options = {
  info(message: string): void;
  error(message: string): void;
  output?(role: DevRole, line: string): void;
  processExecutable?: string;
  graceMs?: number;
  forceMs?: number;
};

/** Own every child from spawn through reap. Startup failures use exactly the
 * same stop path as a crashed ready process; no detached watcher survives. */
export function createDevSupervisor({ info, error, output = (role, line) => info(`${role.padEnd(6)} | ${line}`), processExecutable = process.execPath, graceMs = 9000, forceMs = 1000 }: Options) {
  const children: DevChild[] = [];
  const closedChildren = new Set<DevChild>();
  const monitors = new Map<DevRole, Promise<void>>();
  const abort = new AbortController();
  let failure: Error | null = null;
  let requestedCode = 0;
  let stopPromise: Promise<number> | null = null;
  let resolveStopped!: (code: number) => void;
  const stopped = new Promise<number>(resolve => { resolveStopped = resolve; });
  const childAlive = (item: DevChild) => item.result === null;

  function rememberFailure(message: string): void {
    if (failure) return;
    failure = new Error(message);
    error(message);
    requestedCode = 1;
    abort.abort();
    void stop(1);
  }
  function launch(config: Launch): DevChild {
    if (abort.signal.aborted) throw failure ?? new Error("Local development is stopping.");
    if (children.some(item => item.role === config.role)) throw new Error(`The ${config.role} process is already supervised.`);
    const child = spawn(processExecutable, config.args, { cwd: config.cwd, env: config.env,
      stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32", windowsHide: true });
    let resolveExit!: (value: NonNullable<DevChild["result"]>) => void;
    const exited = new Promise<NonNullable<DevChild["result"]>>(resolve => { resolveExit = resolve; });
    const item: DevChild = { role: config.role, label: config.label, child, exited, result: null };
    children.push(item);
    const completed = (code: number | null, signal: NodeJS.Signals | null) => {
      if (item.result !== null) return;
      item.result = { code, signal };
      if (!abort.signal.aborted) rememberFailure(`${item.label} exited unexpectedly (${signal ?? `exit ${code ?? "unknown"}`}); stopping every local service.`);
      else if ((code !== null && code !== 0 && !config.acceptableStopExitCodes?.includes(code))
        || (signal !== null && signal !== "SIGTERM" && signal !== "SIGINT")) {
        requestedCode = 1;
        error(`${item.label} reported unsuccessful cleanup (${signal ?? `exit ${code}`}).`);
      }
    };
    child.once("error", () => {
      completed(1, null);
      if (!failure) rememberFailure(`${item.label} could not be started.`);
    });
    // `close` can be delayed indefinitely by a grandchild's inherited pipes.
    // Detect the leader's death at `exit`, but still reap its streams and tree.
    child.once("exit", completed);
    child.once("close", (code, signal) => {
      completed(code, signal);
      closedChildren.add(item);
      resolveExit(item.result!);
    });
    for (const stream of [child.stdout, child.stderr]) {
      if (!stream) continue;
      createInterface({ input: stream }).on("line", line => {
        output(item.role, line);
        if (abort.signal.aborted) return;
        let startupFailed = false;
        try {
          const entry = JSON.parse(line) as { event?: unknown };
          startupFailed = ["api_startup_failed", "worker_failed_to_start", "service_startup_failed", "api_process_failure", "notification_worker_process_failure"].includes(String(entry.event));
        } catch { /* Node's watcher output is plain text. */ }
        // Node --watch remains alive when its application crashes or finishes.
        // Keep hot reload on edits, but never call a crashed watch shell ready.
        if (startupFailed || /^(?:Failed|Completed) running ['"]/.test(line.replace(/\u001b\[[0-9;]*m/g, ""))) {
          rememberFailure(`${item.label} stopped behind its watcher; stopping every local service.`);
        }
      });
    }
    return item;
  }
  function treeAlive(item: DevChild): boolean {
    if (process.platform === "win32") return !closedChildren.has(item);
    if (!item.child.pid) return false;
    try { process.kill(-item.child.pid, 0); return true; }
    catch (cause) { return (cause as NodeJS.ErrnoException).code !== "ESRCH"; }
  }
  async function settledWithin(work: Promise<unknown>, milliseconds: number): Promise<boolean> {
    let reaped = false;
    void work.then(() => { reaped = true; });
    const deadline = performance.now() + milliseconds;
    while (performance.now() < deadline) {
      if (reaped && !children.some(treeAlive)) return true;
      await delay(Math.max(1, Math.min(25, deadline - performance.now())));
    }
    return reaped && !children.some(treeAlive);
  }
  function signalAll(signal: NodeJS.Signals): void {
    for (const item of [...children].reverse()) {
      if (!treeAlive(item)) continue;
      try {
        // A dead watch leader may still own a live process group, even after
        // every inherited output pipe closed. Never gate this on leader liveness.
        if (process.platform !== "win32" && item.child.pid) process.kill(-item.child.pid, signal);
        else if (signal === "SIGKILL" && item.child.pid) {
          const killer = spawn("taskkill", ["/PID", String(item.child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
          killer.once("error", () => { requestedCode = 1; error(`${item.label} could not be force-stopped as a process tree.`); });
          killer.once("exit", code => { if (code !== 0 && !closedChildren.has(item)) requestedCode = 1; });
        } else item.child.kill(signal);
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== "ESRCH") { error(`${item.label} could not receive ${signal}.`); requestedCode = 1; }
      }
    }
  }
  function stop(code = 0): Promise<number> {
    requestedCode = Math.max(requestedCode, code);
    if (stopPromise) return stopPromise;
    abort.abort();
    stopPromise = (async () => {
      if (children.some(childAlive)) info("Stopping API, notification worker and web together…");
      signalAll("SIGTERM");
      const reaped = Promise.all([...children.map(item => item.exited), ...monitors.values()]);
      if (!await settledWithin(reaped, graceMs)) {
        error("A local service exceeded its shutdown budget; forcing remaining children to exit.");
        requestedCode = 1;
        signalAll("SIGKILL");
        if (!await settledWithin(reaped, forceMs)) error("A local child did not confirm exit after SIGKILL.");
      }
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
      resolveStopped(requestedCode);
      return requestedCode;
    })();
    return stopPromise;
  }
  function onSignal(): void { void stop(0); }
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  async function waitForHttp(item: DevChild, url: string, timeoutMs: number, description: string): Promise<void> {
    const deadline = performance.now() + timeoutMs;
    while (performance.now() < deadline) {
      assertRunning();
      if (!childAlive(item)) throw failure ?? new Error(`${item.label} exited before ${description}.`);
      const remaining = Math.max(1, Math.min(1000, deadline - performance.now()));
      const probe = await probeDevService(item.role, url, abort.signal, remaining);
      assertRunning();
      if (probe.ready) return;
      try { await delay(120, undefined, { signal: abort.signal }); }
      catch { assertRunning(); }
    }
    throw new Error(`${item.label} did not become ${description} within ${Math.round(timeoutMs / 1000)}s.`);
  }
  function monitor(item: DevChild, url: string, {
    intervalMs = 1000, outageMs = 15_000, requestTimeoutMs = 1000,
  }: { intervalMs?: number; outageMs?: number; requestTimeoutMs?: number } = {}): void {
    assertRunning();
    if (!children.includes(item)) throw new TypeError("Only a supervised child can be monitored.");
    if (monitors.has(item.role)) throw new Error(`The ${item.role} readiness monitor is already running.`);
    for (const value of [intervalMs, outageMs, requestTimeoutMs]) {
      if (!Number.isSafeInteger(value) || value <= 0 || value > 120_000) throw new RangeError("Invalid dev readiness monitor budget.");
    }
    if (intervalMs > outageMs) throw new RangeError("A dev readiness interval must not exceed the recovery budget.");
    const run = async () => {
      let failedSince: number | null = null;
      let failures = 0;
      while (!abort.signal.aborted && childAlive(item)) {
        try { await delay(intervalMs, undefined, { signal: abort.signal }); }
        catch { return; }
        if (abort.signal.aborted) return;
        const probe = await probeDevService(item.role, url, abort.signal, requestTimeoutMs);
        if (abort.signal.aborted) return;
        if (probe.ready) {
          if (failedSince !== null) {
            info(`${item.label} readiness recovered after ${Math.round(performance.now() - failedSince)}ms (${failures} failed probes).`);
          }
          failedSince = null;
          failures = 0;
          continue;
        }
        failures += 1;
        const current = performance.now();
        if (failedSince === null) {
          failedSince = current;
          info(`${item.label} readiness interrupted (${probe.reason}); allowing ${outageMs}ms for hot reload or transient recovery.`);
        }
        if (current - failedSince >= outageMs) {
          rememberFailure(`${item.label} did not recover readiness within ${outageMs}ms; stopping every local service.`);
          return;
        }
      }
    };
    const completed = run().catch(() => {
      if (!abort.signal.aborted) rememberFailure(`${item.label} readiness supervision failed; stopping every local service.`);
    });
    monitors.set(item.role, completed);
  }

  function assertRunning(): void {
    if (failure) throw failure;
    if (abort.signal.aborted) throw new Error("Local development was stopped.");
  }
  return Object.freeze({ launch, waitForHttp, monitor, stop, assertRunning, stopped, signal: abort.signal,
    get exitCode() { return requestedCode; }, get failure() { return failure; } });
}
