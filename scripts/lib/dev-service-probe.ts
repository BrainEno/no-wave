export type DevProbeRole = "api" | "worker" | "web";
export type DevProbe = {
  ready: boolean;
  status: number | null;
  reason:
    | "ready"
    | "http_status"
    | "role_mismatch"
    | "invalid_response"
    | "response_too_large"
    | "timeout"
    | "cancelled"
    | "connection";
};

/** A successful TCP connection or HTML 200 does not establish API readiness.
 * Verify the role's bounded JSON contract, including the body deadline. No
 * response value or exception text escapes into developer diagnostics. */
export async function probeDevService(
  role: DevProbeRole,
  url: string,
  parent: AbortSignal,
  timeoutMs: number,
): Promise<DevProbe> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
    throw new RangeError("A dev probe needs a positive time budget.");
  const local = new AbortController();
  let timedOut = false;
  let status: number | null = null;
  const timer = setTimeout(() => {
    timedOut = true;
    local.abort();
  }, Math.ceil(timeoutMs));
  const signal = AbortSignal.any([parent, local.signal]);
  try {
    const response = await fetch(url, { signal, redirect: "manual" });
    status = response.status;
    if (status < 200 || status >= 300) {
      local.abort();
      return { ready: false, status, reason: "http_status" };
    }
    if (role === "web") {
      local.abort();
      return { ready: true, status, reason: "ready" };
    }
    if (!response.body)
      return { ready: false, status, reason: "invalid_response" };
    const declaredLength = response.headers.get("content-length");
    const limit = 8192;
    if (declaredLength !== null && Number(declaredLength) > limit) {
      local.abort();
      return { ready: false, status, reason: "response_too_large" };
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let received = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        received += chunk.value.byteLength;
        if (received > limit) {
          local.abort();
          return { ready: false, status, reason: "response_too_large" };
        }
        chunks.push(chunk.value);
      }
    } finally {
      reader.releaseLock();
    }
    let value: unknown;
    try {
      value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      return { ready: false, status, reason: "invalid_response" };
    }
    if (!value || typeof value !== "object" || Array.isArray(value))
      return { ready: false, status, reason: "invalid_response" };
    const body = value as { status?: unknown; service?: unknown };
    const expected = role === "api" ? "api" : "notification-worker";
    if (body.service !== expected)
      return { ready: false, status, reason: "role_mismatch" };
    if (body.status !== "ready")
      return { ready: false, status, reason: "invalid_response" };
    return { ready: true, status, reason: "ready" };
  } catch {
    return {
      ready: false,
      status,
      reason: parent.aborted
        ? "cancelled"
        : timedOut
          ? "timeout"
          : "connection",
    };
  } finally {
    clearTimeout(timer);
  }
}
