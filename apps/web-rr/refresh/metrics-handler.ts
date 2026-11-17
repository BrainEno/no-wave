import { createProtectedMetricsHandler } from "../operations/metrics-handler.ts";

/** Disabled by default; a separate operator credential never reaches the API. */
export function createRefreshMetricsHandler(env: NodeJS.ProcessEnv) {
  return createProtectedMetricsHandler(env, { path: "/internal/refresh-metrics", credentialName: "WEB_REFRESH_METRICS_TOKEN", outputLimit: 16_384,
    disallowedCredentials: [env.WEB_UPSTREAM_METRICS_TOKEN, env.WEB_REFRESH_ENCRYPTION_KEY, env.AUTH_JWT_SECRET, env.BFF_CLIENT_ADDRESS_SECRET] });
}
