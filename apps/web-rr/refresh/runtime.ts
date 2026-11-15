import { InMemoryRefreshCoordinator, type RefreshCoordinator } from "@bot-thk/web-http";
import { withRefreshCoordinator } from "@bot-thk/web-http/refresh-runtime";
import { PostgresRefreshCoordinator } from "./coordinator.ts";
import { observeRefresh, RefreshCoordinationError, type RefreshObserver } from "./errors.ts";
import { PostgresRefreshStore } from "./postgres-store.ts";
import { RefreshResultCodec } from "./result-codec.ts";
import { RefreshTelemetry } from "./telemetry.ts";
import { resolveRefreshSettings } from "./settings.ts";

export type WebRefreshRuntime = {
  mode: "memory" | "postgres";
  run<Value>(work: () => Value): Value;
  readiness(): { ready: boolean; mode: "memory" | "postgres"; status: "ready" | "unavailable" | "stopping" };
  close(): Promise<boolean>;
  metrics(): string;
};

/** Eager initialization: no listener can advertise readiness on a broken mode. */
export async function createWebRefreshRuntime(env: NodeJS.ProcessEnv, observer?: RefreshObserver): Promise<WebRefreshRuntime> {
  const settings = resolveRefreshSettings(env);
  const telemetry = new RefreshTelemetry();
  const observed: RefreshObserver = sample => { telemetry.observe(sample); observeRefresh(observer, sample); };
  let coordinator: RefreshCoordinator;
  let shared: PostgresRefreshCoordinator | undefined;
  let store: PostgresRefreshStore | undefined;
  let healthy = settings.mode === "memory";
  let lastHealthyAt = healthy ? performance.now() : -Infinity;
  let probing = false;
  let stopped = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let closing: Promise<boolean> | undefined;

  if (settings.mode === "postgres") {
    const codec = new RefreshResultCodec(settings.encryptionKey);
    store = new PostgresRefreshStore(settings, codec.fingerprint);
    shared = new PostgresRefreshCoordinator({ settings, codec, store, observer: observed });
    try {
      await shared.start();
      telemetry.sampled(await store.inspect());
      healthy = true; lastHealthyAt = performance.now();
    } catch {
      await shared.close();
      throw new RefreshCoordinationError("database");
    }
    coordinator = shared;
    const ownedStore = store;
    timer = setInterval(() => {
      if (stopped || probing) return;
      probing = true;
      void ownedStore.inspect().then(snapshot => {
        if (!stopped) { healthy = true; lastHealthyAt = performance.now(); telemetry.sampled(snapshot); }
      }, () => {
        if (!stopped) {
          healthy = false;
          telemetry.sampleFailed();
          observed({ event: "rejected", reason: "database" });
        }
      }).finally(() => { probing = false; });
    }, 5000);
    timer.unref();
  } else coordinator = new InMemoryRefreshCoordinator();

  return {
    mode: settings.mode,
    run: work => withRefreshCoordinator(coordinator, work),
    readiness() {
      const fresh = settings.mode === "memory" || performance.now() - lastHealthyAt < 10_000;
      const ready = !stopped && healthy && fresh;
      return { ready, mode: settings.mode, status: stopped ? "stopping" : ready ? "ready" : "unavailable" };
    },
    metrics() {
      const fresh = settings.mode === "memory" || performance.now() - lastHealthyAt < 10_000;
      const progress = shared?.snapshot();
      return telemetry.render({ mode: settings.mode, ready: !stopped && healthy && fresh,
        pending: progress?.pending ?? 0, callbacks: progress?.callbacks ?? 0, waiters: progress?.waiters ?? 0,
        waitingKeys: progress?.waitingKeys ?? 0, database: store?.snapshot() });
    },
    close() {
      if (closing) return closing;
      stopped = true;
      clearInterval(timer);
      closing = shared ? shared.close() : Promise.resolve(true);
      return closing;
    },
  };
}
