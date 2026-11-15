export function integerSetting(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  if (!/^\d+$/.test(raw)) throw new RangeError(`${name} must be an integer between ${min} and ${max}.`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new RangeError(`${name} must be an integer between ${min} and ${max}.`);
  }
  return value;
}

export function shutdownSettings(env: NodeJS.ProcessEnv) {
  const deadlineMs = integerSetting(env, "SHUTDOWN_GRACE_MS", 8000, 100, 60_000);
  const cleanupMs = integerSetting(env, "SHUTDOWN_CLEANUP_MS", Math.min(2000, Math.floor(deadlineMs / 4)), 1, 15_000);
  if (cleanupMs >= deadlineMs) throw new RangeError("SHUTDOWN_CLEANUP_MS must be smaller than SHUTDOWN_GRACE_MS.");
  return Object.freeze({ deadlineMs, cleanupMs });
}

export function apiHttpSettings(env: NodeJS.ProcessEnv) {
  const headersTimeout = integerSetting(env, "API_HEADERS_TIMEOUT_MS", 15_000, 100, 120_000);
  const requestTimeout = integerSetting(env, "API_REQUEST_TIMEOUT_MS", 60_000, 100, 600_000);
  const keepAliveTimeout = integerSetting(env, "API_KEEP_ALIVE_TIMEOUT_MS", 5000, 100, 30_000);
  if (headersTimeout > requestTimeout) throw new RangeError("API_HEADERS_TIMEOUT_MS must not exceed API_REQUEST_TIMEOUT_MS.");
  return Object.freeze({ headersTimeout, requestTimeout, keepAliveTimeout });
}

export type ServiceRole = "api" | "notification-worker";
export function serviceRole(env: NodeJS.ProcessEnv): ServiceRole {
  const role = env.SERVICE_ROLE ?? "api";
  if (role !== "api" && role !== "notification-worker") throw new RangeError("SERVICE_ROLE must be api or notification-worker.");
  return role;
}

export function workerHealthSettings(env: NodeJS.ProcessEnv) {
  const enabled = env.OUTBOX_HEALTH_PORT !== undefined || env.SERVICE_ROLE === "notification-worker";
  const port = integerSetting(env, "OUTBOX_HEALTH_PORT", 4001, 0, 65535);
  const host = env.OUTBOX_HEALTH_HOST ?? "127.0.0.1";
  if (!host || /[\s/\\?#]/.test(host)) throw new RangeError("OUTBOX_HEALTH_HOST must be a listen address.");
  return Object.freeze({ enabled, port, host });
}

export function readinessSettings(env: NodeJS.ProcessEnv) {
  const timeoutMs = integerSetting(env, "API_READINESS_TIMEOUT_MS", 500, 10, 5000);
  const cacheMs = integerSetting(env, "API_READINESS_CACHE_MS", 1000, 0, 30_000);
  const maxPendingAgeMs = integerSetting(env, "API_OUTBOX_MAX_PENDING_AGE_MS", 120_000, 1000, 86_400_000);
  return Object.freeze({ timeoutMs, cacheMs, maxPendingAgeMs });
}
