/**
 * Explicit inputs for every handler in this package.
 *
 * Nothing here reads `process.env`: the adapter that knows the runtime (Next.js,
 * React Router, a test) resolves the API origin and passes it in. That is what
 * makes the same handler testable without a framework request object, and it is
 * why a Vercel service binding can stay a transitional detail of one adapter.
 */
import type { RefreshCoordinator } from "./refresh-coordinator.ts";

export type FetchImpl = (input: string, init?: RequestInit) => Promise<Response>;

export type ApiProxyConfig = {
  /** Absolute HTTP(S) API origin, already validated by the caller. */
  apiBaseUrl?: string | undefined;
  fetchImpl?: FetchImpl;
  /**
   * Rotation single-flight (ADR 0025). A multi-instance deployment supplies a
   * shared implementation; the default is one coordinator per Web process (and,
   * for injected transports, one per transport).
   */
  refreshCoordinator?: RefreshCoordinator;
};

/** Join an API origin and a relative path, tolerating a trailing slash on either. */
export function apiUrl(base: string, path: string): string {
  return new URL(path.replace(/^\/+/, ""), `${base.replace(/\/+$/, "")}/`).toString();
}

export async function readPayload(response: Response): Promise<unknown> {
  try {
    return (await response.clone().json()) as unknown;
  } catch {
    return null;
  }
}
