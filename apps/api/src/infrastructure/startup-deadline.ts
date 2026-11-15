import { integerSetting } from "./service-settings.ts";

type Options = {
  env: NodeJS.ProcessEnv;
  prefix: "api" | "notification_worker";
  onTimeout(): void;
  log(entry: { level: "error"; event: string; timeoutMs: number; durationMs: number }): void;
};

/** A live process is not a completed bootstrap. Keep this timer referenced so
 * even a driver promise without an active handle cannot silently exit zero.
 * Expiry requests the role's existing bounded teardown, never another startup.
 * Cancel on success or requested stop, before releasing durable resources. */
export function createStartupDeadline({ env, prefix, onTimeout, log }: Options): () => void {
  const timeoutMs = integerSetting(env, "SERVICE_STARTUP_TIMEOUT_MS", 30_000, 100, 120_000);
  const startedAt = performance.now();
  let active = true;
  const timer = setTimeout(() => {
    if (!active) return;
    active = false;
    try {
      log({ level: "error", event: `${prefix}_startup_deadline_reached`, timeoutMs,
        durationMs: Math.max(0, Math.round(performance.now() - startedAt)) });
    } catch { /* an observer cannot keep a wedged bootstrap alive */ }
    onTimeout();
  }, timeoutMs);
  return () => {
    if (!active) return;
    active = false;
    clearTimeout(timer);
  };
}
