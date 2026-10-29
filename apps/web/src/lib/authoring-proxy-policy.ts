export const ACCESS_TOKEN_COOKIE = "nw_access";
export const REFRESH_TOKEN_COOKIE = "nw_refresh";

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

export function isSameOriginMutation(requestUrl: string, originHeader: string | null): boolean {
  if (!originHeader) return false;
  try {
    const request = new URL(requestUrl);
    const origin = new URL(originHeader);
    return originHeader === origin.origin && origin.origin === request.origin &&
      (origin.protocol === "http:" || origin.protocol === "https:");
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
