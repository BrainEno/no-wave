import { UpstreamTimeoutError, apiUrl, applyClientAddressHeaders, withUpstreamDeadline, type ApiProxyConfig, type FetchImpl } from "./api.ts";
import { errorResponse, safeApiError } from "./http.ts";
import { isTokenEnvelope } from "./policy.ts";
import { parseRetryAfterSeconds } from "./retry-after.ts";
import { InMemoryRefreshCoordinator, refreshCoordinatorKey, type RefreshCoordinator, type RefreshFailure, type RefreshOutcome } from "./refresh-coordinator.ts";

// One registry for BOTH explicit and 401-triggered refresh. A transport override
// is a different upstream trust boundary; an explicit distributed port wins.
const processCoordinator = new InMemoryRefreshCoordinator();
const transportCoordinators = new WeakMap<FetchImpl, RefreshCoordinator>();
function coordinatorFor(config: ApiProxyConfig): RefreshCoordinator {
  if (config.refreshCoordinator) return config.refreshCoordinator;
  if (!config.fetchImpl) return processCoordinator;
  let coordinator = transportCoordinators.get(config.fetchImpl);
  if (!coordinator) {
    coordinator = new InMemoryRefreshCoordinator();
    transportCoordinators.set(config.fetchImpl, coordinator);
  }
  return coordinator;
}

export function isRefreshFailure(outcome: RefreshOutcome): outcome is RefreshFailure {
  return outcome !== null && outcome !== undefined && "kind" in outcome && outcome.kind === "failed";
}

/** A reconstructed private response: never cache/share a Response body or upstream cookies. */
export function refreshFailureResponse(failure: RefreshFailure): Response {
  const response = errorResponse(failure.code, failure.message, failure.status);
  if (failure.retryAfterSeconds !== null) response.headers.set("retry-after", String(failure.retryAfterSeconds));
  return response;
}

function unavailableRefresh(error: unknown): RefreshFailure {
  const timeout = error instanceof UpstreamTimeoutError;
  return { kind: "failed", status: timeout ? 504 : 502, code: timeout ? "UPSTREAM_TIMEOUT" : "SERVICE_UNAVAILABLE",
    message: timeout ? "The API service did not answer in time." : "The API service could not be reached.", retryAfterSeconds: null };
}

/**
 * The only BFF rotation entry. Access cookies cannot participate in identity:
 * the browser automatically omits one at its Path/expiry boundary while still
 * presenting the very same one-time refresh credential.
 */
export async function resolveSessionRefresh(refreshToken: string, config: ApiProxyConfig, timeoutMs: number): Promise<RefreshOutcome> {
  const base = config.apiBaseUrl;
  if (!base) return { kind: "failed", status: 503, code: "SERVICE_UNAVAILABLE", message: "The API service is not configured.", retryAfterSeconds: null };
  try {
    const key = await refreshCoordinatorKey(base, refreshToken);
    return await coordinatorFor(config).resolve(key, () => rotate(refreshToken, base, config, timeoutMs));
  } catch (error) {
    // An unavailable external coordinator is not permission to rotate without
    // its lock. Fail closed, without exposing driver/configuration diagnostics.
    return unavailableRefresh(error);
  }
}

async function rotate(refreshToken: string, base: string, config: ApiProxyConfig, timeoutMs: number): Promise<RefreshOutcome> {
  try {
    return await withUpstreamDeadline(timeoutMs, async (signal): Promise<RefreshOutcome> => {
      const target = apiUrl(base, "api/v1/auth/refresh");
      const headers = new Headers({ accept: "application/json", "content-type": "application/json; charset=utf-8" });
      applyClientAddressHeaders(headers, target, "POST", config.clientAddressHeaders);
      const response = await (config.fetchImpl ?? fetch)(target, {
        method: "POST", headers, body: JSON.stringify({ refreshToken }), redirect: "error", cache: "no-store", signal,
      });
      const text = await response.text();
      let payload: unknown = null;
      try { payload = JSON.parse(text) as unknown; } catch { /* Malformed success is not a rotation. */ }
      if (response.ok && isTokenEnvelope(payload)) return payload.data;
      if (response.ok) return { kind: "failed", status: 502, code: "INVALID_AUTH_RESPONSE", message: "The API returned an invalid authentication response.", retryAfterSeconds: null };
      const { error } = safeApiError(payload, response.status);
      return { kind: "failed", status: response.status, ...error, retryAfterSeconds: parseRetryAfterSeconds(response.headers.get("retry-after")) };
    });
  } catch (error) {
    // Preserve an explicit caller's timeout code while automatic callers retain
    // the original 401; neither path may clear cookies on an uncertain failure.
    return unavailableRefresh(error);
  }
}
