export const REFRESH_REUSE_MS = 5_000;
export const REFRESH_TRANSIENT_MS = 250;
// Longer than any refresh credential this API can issue, including clock skew.
export const REFRESH_UNCERTAIN_RETENTION_MS = (30 * 24 * 60 * 60 + 60) * 1000;

export type RefreshSettings = Readonly<{
  mode: "memory" | "postgres";
  instanceCount: number;
  databaseUrl: string;
  encryptionKey: Buffer;
  namespace: string;
  maxEntries: number;
  maxPending: number;
  maxWaiters: number;
  maxWaitersPerKey: number;
  databaseConcurrency: number;
  driverTimeoutMs: number;
  rotationTimeoutMs: number;
  waitTimeoutMs: number;
  sweepIntervalMs: number;
}>;

function invalid(name: string): never {
  throw new Error(`${name} is invalid for Web refresh coordination.`);
}

function integer(env: NodeJS.ProcessEnv, name: string, fallback: number, minimum: number, maximum: number): number {
  const raw = env[name];
  if (raw === undefined) return fallback;
  if (!/^[1-9]\d*$/.test(raw)) return invalid(name);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) return invalid(name);
  return value;
}

/** Keep driver options from overriding the coordinator's resource/safety budgets. */
function refreshDatabaseUrl(value: string): string {
  const bad = () => invalid("WEB_REFRESH_DATABASE_URL");
  let address: URL;
  try { address = new URL(value); } catch { return bad(); }
  if (!["postgres:", "postgresql:"].includes(address.protocol) || !address.hostname || address.hash || address.port === "0") return bad();
  let username: string, database: string;
  try { username = decodeURIComponent(address.username); database = decodeURIComponent(address.pathname.slice(1)); }
  catch { return bad(); }
  if (!username || !database || address.pathname.slice(1).includes("/") ||
      /[\u0000-\u001f\u007f]/.test(username + database) || Buffer.byteLength(username, "utf8") > 63 || Buffer.byteLength(database, "utf8") > 63) return bad();
  const options = new Map<string, string>();
  for (const [name, option] of address.searchParams) {
    if (options.has(name)) return bad();
    switch (name) {
      case "sslmode":
        if (!["disable", "require", "verify-full"].includes(option)) return bad();
        break;
      case "sslrootcert":
        if (option !== "system") return bad();
        break;
      case "channel_binding":
        if (!["disable", "prefer", "require"].includes(option)) return bad();
        break;
      case "target_session_attrs":
        if (!["read-write", "primary"].includes(option)) return bad();
        break;
      case "search_path": {
        if (!/^[a-z_][a-z0-9_]{0,62}(?:,public)?$/.test(option)) return bad();
        const names = option.split(",");
        if (new Set(names).size !== names.length || names.some(name => name.startsWith("pg_"))) return bad();
        break;
      }
      default: return bad();
    }
    options.set(name, option);
  }
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(address.hostname);
  // Remote plaintext/TLS policy must be explicit. Certificate file paths and
  // startup `options` are deliberately not accepted through connection URLs.
  if (!loopback && !options.has("sslmode") && options.get("sslrootcert") !== "system") return bad();
  if (options.get("sslrootcert") === "system" && options.has("sslmode") && options.get("sslmode") !== "verify-full") return bad();
  return address.toString();
}

export function resolveRefreshSettings(env: NodeJS.ProcessEnv): RefreshSettings {
  const instanceCount = integer(env, "WEB_INSTANCE_COUNT", 1, 1, 1024);
  const mode = env.WEB_REFRESH_COORDINATOR ?? "memory";
  if (mode !== "memory" && mode !== "postgres") return invalid("WEB_REFRESH_COORDINATOR");
  if (mode === "memory" && instanceCount > 1) {
    throw new Error("Multiple Web instances require the shared postgres refresh coordinator.");
  }
  let databaseUrl = env.WEB_REFRESH_DATABASE_URL ?? "";
  const namespace = env.WEB_REFRESH_NAMESPACE ?? "default";
  if (!/^[a-z][a-z0-9_-]{0,47}$/.test(namespace)) return invalid("WEB_REFRESH_NAMESPACE");
  let encryptionKey = Buffer.alloc(0);
  if (mode === "postgres") {
    databaseUrl = refreshDatabaseUrl(databaseUrl);
    const rawKey = env.WEB_REFRESH_ENCRYPTION_KEY ?? "";
    if (!/^[A-Za-z0-9_-]{43}$/.test(rawKey)) return invalid("WEB_REFRESH_ENCRYPTION_KEY");
    encryptionKey = Buffer.from(rawKey, "base64url");
    if (encryptionKey.length !== 32 || encryptionKey.toString("base64url") !== rawKey) return invalid("WEB_REFRESH_ENCRYPTION_KEY");
  }
  const maxPending = integer(env, "WEB_REFRESH_MAX_PENDING", 128, 1, 1024);
  const databaseConcurrency = integer(env, "WEB_REFRESH_DATABASE_CONCURRENCY", 4, 1, 32);
  if (databaseConcurrency > maxPending) return invalid("WEB_REFRESH_DATABASE_CONCURRENCY");
  const maxWaiters = integer(env, "WEB_REFRESH_MAX_WAITERS", 1024, 1, 8192);
  const maxWaitersPerKey = integer(env, "WEB_REFRESH_MAX_WAITERS_PER_KEY", 64, 1, 1024);
  if (maxWaitersPerKey > maxWaiters) return invalid("WEB_REFRESH_MAX_WAITERS_PER_KEY");
  const driverTimeoutMs = integer(env, "WEB_REFRESH_DRIVER_TIMEOUT_MS", 2_000, 100, 10_000);
  const rotationTimeoutMs = integer(env, "WEB_REFRESH_ROTATION_TIMEOUT_MS", 15_000, 100, 120_000);
  const waitTimeoutMs = integer(env, "WEB_REFRESH_WAIT_TIMEOUT_MS", 20_000, 100, 120_000);
  return Object.freeze({
    mode, instanceCount, databaseUrl, encryptionKey, namespace,
    maxEntries: integer(env, "WEB_REFRESH_MAX_ENTRIES", 8192, 1, 65_536),
    maxPending, maxWaiters, maxWaitersPerKey, databaseConcurrency, driverTimeoutMs, rotationTimeoutMs, waitTimeoutMs,
    sweepIntervalMs: integer(env, "WEB_REFRESH_SWEEP_INTERVAL_MS", 30_000, 1000, 600_000),
  });
}

/** Replicas must agree on policy before any of them can spend a credential. */
export function refreshClusterPolicy(settings: RefreshSettings): string {
  return JSON.stringify({ protocol: 1, reuseMs: REFRESH_REUSE_MS, transientMs: REFRESH_TRANSIENT_MS,
    uncertainRetentionMs: REFRESH_UNCERTAIN_RETENTION_MS, rotationTimeoutMs: settings.rotationTimeoutMs, maxEntries: settings.maxEntries });
}
