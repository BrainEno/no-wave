import { createProtectedMetricsHandler } from "../operations/metrics-handler.ts";

export function createUpstreamMetricsHandler(env: Readonly<Record<string, string | undefined>>) {
  return createProtectedMetricsHandler(env, { path: "/internal/upstream-metrics", credentialName: "WEB_UPSTREAM_METRICS_TOKEN", outputLimit: 32_768,
    disallowedCredentials: [env.WEB_REFRESH_METRICS_TOKEN, env.WEB_REFRESH_ENCRYPTION_KEY, env.AUTH_JWT_SECRET, env.BFF_CLIENT_ADDRESS_SECRET] });
}
