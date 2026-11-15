import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { safeErrorClass } from "../application/background-tasks.ts";
import { shutdownSettings } from "./service-settings.ts";

type ResourceName = "persistence" | "media" | "readiness" | "metrics";
type Resource = { name: ResourceName; close: () => unknown };
type OperationalLog = { level: "info" | "warn" | "error"; event: string; [key: string]: string | number | boolean };
export type ShutdownReport = {
  forced: boolean;
  cleanupSucceeded: boolean;
  cleanupTimedOut: boolean;
  activeAtStop: number;
  durationMs: number;
  exitCode: 0 | 1;
};

/** An absolute stop budget includes both draining clients and closing durable
 * resources. It is never spent entirely on an unfinished body or an idle peer.
 * The caller decides process exit; embedded servers get the same honest report. */
export function createHttpLifecycle(server: Server | null, {
  env = process.env, prefix = "api", log = () => {}, now = performance.now.bind(performance),
}: { env?: NodeJS.ProcessEnv; prefix?: "api" | "notification_worker"; log?: (entry: OperationalLog) => void; now?: () => number } = {}) {
  const settings = shutdownSettings(env);
  const sockets = new Set<Socket>();
  let active = 0;
  let draining = false;
  let stopped = false;
  let stopPromise: Promise<ShutdownReport> | null = null;
  server?.on("connection", (socket: Socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    if (draining) socket.destroy();
  });

  server?.on("listening", () => {
    if (draining || stopped) {
      server?.close();
      server?.closeIdleConnections();
    }
  });

  function emit(level: OperationalLog["level"], event: string, fields: Omit<OperationalLog, "level" | "event"> = {}): void {
    try { log({ ...fields, level, event: `${prefix}_${event}` }); } catch { /* observers cannot interrupt cleanup */ }
  }

  function admit(request: IncomingMessage, response: ServerResponse): boolean {
    if (draining || stopped) {
      const body = JSON.stringify({ error: { code: "SERVICE_UNAVAILABLE", message: "The service is shutting down." } });
      response.writeHead(503, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store",
        "x-content-type-options": "nosniff", "retry-after": "1", connection: "close", "content-length": Buffer.byteLength(body) });
      response.end(request.method === "HEAD" ? undefined : body);
      return false;
    }
    active += 1;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      active = Math.max(0, active - 1);
      response.off("finish", release);
      response.off("close", release);
      if (draining) server?.closeIdleConnections();
    };
    response.once("finish", release);
    response.once("close", release);
    return true;
  }

  async function waitWithin(promise: Promise<unknown>, budgetMs: number): Promise<boolean> {
    if (budgetMs <= 0) return false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        promise.then(() => true),
        new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), Math.ceil(budgetMs)); }),
      ]);
    } finally { if (timer) clearTimeout(timer); }
  }

  function forceClients(): void {
    server?.closeAllConnections();
    for (const socket of sockets) socket.destroy();
    if (server?.listening) {
      try { server.close(); }
      catch (error) { emit("error", "listener_force_close_failed", { errorName: safeErrorClass(error) }); }
    }
  }

  function stop(resources: readonly Resource[] = [], signal = "requested", drain: () => unknown = () => {}): Promise<ShutdownReport> {
    if (stopPromise) return stopPromise;
    draining = true;
    const started = now();
    const activeAtStop = active;
    emit("info", "shutdown_started", { signal, activeRequests: activeAtStop, deadlineMs: settings.deadlineMs });
    stopPromise = (async () => {
      let httpClosed = server === null;
      let listenerFailed = false;
      const closed = new Promise<void>(resolve => {
        if (!server) { resolve(); return; }
        try {
          server.close(error => {
            if (error && (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING") {
              listenerFailed = true;
              emit("error", "listener_close_failed", { errorName: safeErrorClass(error) });
            } else httpClosed = true;
            resolve();
          });
          server.closeIdleConnections();
        } catch (error) {
          listenerFailed = true;
          emit("error", "listener_close_failed", { errorName: safeErrorClass(error) });
          resolve();
        }
      });
      let backgroundDrained = false;
      let drainFailed = false;
      const background = Promise.resolve().then(drain).then(() => { backgroundDrained = true; }).catch(error => {
        drainFailed = true;
        emit("error", "background_drain_failed", { errorName: safeErrorClass(error) });
      });
      await waitWithin(Promise.all([closed, background]), settings.deadlineMs - settings.cleanupMs - (now() - started));
      const forced = !httpClosed || !backgroundDrained;
      if (forced) {
        emit("warn", "drain_deadline_reached", { activeRequests: active, openConnections: sockets.size });
        forceClients();
      }
      let cleanupFailed = false;
      const unique = new Set<ResourceName>();
      const cleanup = Promise.all(resources.map(async resource => {
        if (unique.has(resource.name)) { cleanupFailed = true; emit("error", "duplicate_cleanup_resource", { resource: resource.name }); return; }
        unique.add(resource.name);
        try {
          await resource.close();
          emit("info", `${resource.name}_closed`);
        } catch (error) {
          cleanupFailed = true;
          emit("error", "cleanup_failed", { resource: resource.name, errorName: safeErrorClass(error) });
        }
      }));
      const remaining = Math.max(0, settings.deadlineMs - (now() - started));
      const cleanupFinished = await waitWithin(cleanup, Math.min(settings.cleanupMs, remaining));
      if (!cleanupFinished) emit("error", "cleanup_deadline_reached", { resourceCount: resources.length });
      stopped = true;
      forceClients();
      const report: ShutdownReport = { forced, cleanupSucceeded: cleanupFinished && !cleanupFailed,
        cleanupTimedOut: !cleanupFinished, activeAtStop, durationMs: Math.round(Math.max(0, now() - started)),
        exitCode: cleanupFinished && !cleanupFailed && !listenerFailed && !drainFailed && backgroundDrained ? 0 : 1 };
      emit(report.exitCode === 0 ? "info" : "error", "shutdown_complete", report);
      return report;
    })();
    return stopPromise;
  }

  return Object.freeze({ admit, stop, isDraining: () => draining, activeRequests: () => active });
}
