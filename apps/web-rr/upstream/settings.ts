import type { AdmissionLimits } from "@no-wave/web-http";

export function webIntegerSetting(env: Readonly<Record<string, string | undefined>>, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name];
  if (raw === undefined) return fallback;
  if (!/^[0-9]+$/.test(raw)) throw new Error(`${name} must be a bounded whole number.`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${name} must be between ${min} and ${max}.`);
  return value;
}

/** One validated, process-owned capacity budget; no domain or database settings. */
export function resolveWebUpstreamSettings(env: Readonly<Record<string, string | undefined>>): AdmissionLimits {
  return {
    concurrency: webIntegerSetting(env, "WEB_UPSTREAM_CONCURRENCY", 8, 1, 32),
    queue: webIntegerSetting(env, "WEB_UPSTREAM_QUEUE", 32, 0, 128),
    queueTimeoutMs: webIntegerSetting(env, "WEB_UPSTREAM_QUEUE_TIMEOUT_MS", 250, 1, 5000),
  };
}
