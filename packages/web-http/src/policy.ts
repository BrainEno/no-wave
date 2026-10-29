export const ACCESS_TOKEN_COOKIE = "nw_access";
export const REFRESH_TOKEN_COOKIE = "nw_refresh";

export function setIdempotencyKeyHeader(headers: Headers, idempotencyKey?: string | null): void {
  if (idempotencyKey !== undefined && idempotencyKey !== null) {
    headers.set("idempotency-key", idempotencyKey);
  }
}

export type TokenSet = {
  accessToken: string;
  tokenType: "Bearer";
  accessExpiresAt: string;
  refreshToken: string;
  refreshExpiresAt: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

export function isTokenEnvelope(value: unknown): value is { data: TokenSet } {
  if (!isRecord(value) || !isRecord(value.data)) return false;
  const data = value.data;
  return typeof data.accessToken === "string" && data.accessToken.length > 30 &&
    data.tokenType === "Bearer" &&
    typeof data.refreshToken === "string" && /^[A-Za-z0-9_-]{43}$/.test(data.refreshToken) &&
    isTimestamp(data.accessExpiresAt) && isTimestamp(data.refreshExpiresAt);
}

export function tokenMaxAge(expiresAt: string, now = Date.now(), maximumSeconds = 30 * 24 * 60 * 60): number {
  const expiry = Date.parse(expiresAt);
  if (!Number.isFinite(expiry) || !Number.isFinite(now)) return 0;
  return Math.max(0, Math.min(maximumSeconds, Math.floor((expiry - now) / 1000)));
}

const HOST_AUTHORITY_PATTERN = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*|\[[0-9a-f:.]+\])(?::[1-9]\d{0,4})?$/i;

/**
 * Reject a mutation unless the browser-sent `Origin` is exactly the origin the
 * request was addressed to.
 *
 * `request.url` is not a trustworthy authority: Next.js builds it from the
 * hostname the server was started with, so `next dev --hostname 0.0.0.0` (and the
 * container `HOSTNAME=0.0.0.0` used by the Web image) produce
 * `http://0.0.0.0:3000/...` even though the browser used `localhost`,
 * `127.0.0.1` or a LAN address. Comparing against that value rejected every
 * same-origin mutation with `403 ORIGIN_REJECTED` for those hostnames.
 *
 * The `Host` header is what the browser actually addressed, so prefer it, and
 * fall back to `request.url` when it is absent or malformed. The comparison
 * stays an exact origin equality (scheme, host and port), so a foreign origin,
 * a different port or a scheme downgrade is still rejected.
 */
export function isSameOriginMutation(
  requestUrl: string,
  originHeader: string | null,
  hostHeader: string | null = null,
): boolean {
  if (!originHeader) return false;
  try {
    const request = new URL(requestUrl);
    const origin = new URL(originHeader);
    if (originHeader !== origin.origin) return false;
    if (origin.protocol !== "http:" && origin.protocol !== "https:") return false;
    const authority = typeof hostHeader === "string" && HOST_AUTHORITY_PATTERN.test(hostHeader)
      ? hostHeader
      : request.host;
    return origin.origin === `${request.protocol}//${authority}`;
  } catch {
    return false;
  }
}

export function safeRedirectPath(value: unknown): string {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//") ||
      value.includes("\\") || /[\u0000-\u001f\u007f]/.test(value)) return "/write";
  try {
    const parsed = new URL(value, "https://no-wave.invalid");
    if (parsed.origin !== "https://no-wave.invalid") return "/write";
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return "/write";
  }
}
