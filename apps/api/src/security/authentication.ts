import { createHmac, timingSafeEqual } from "node:crypto";

const BEARER_PREFIX = /^Bearer\s+(.+)$/i;
const MAX_BEARER_TOKEN_LENGTH = 8192;
const DEFAULT_MAX_ACCESS_TOKEN_TTL_SECONDS = 15 * 60;
const MAX_CONFIGURABLE_ACCESS_TOKEN_TTL_SECONDS = 24 * 60 * 60;
const DEFAULT_ACCESS_TOKEN_TYPE = "at+jwt";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function decodeSegment(segment: string): { value: unknown; bytes: Buffer } | null {
  // Compact JWS uses unpadded base64url. Reject permissive decoding of malformed
  // encodings rather than accepting ambiguous tokens.
  if (!/^[A-Za-z0-9_-]+$/.test(segment)) return null;
  try {
    const bytes = Buffer.from(segment, "base64url");
    if (bytes.toString("base64url") !== segment) return null;
    return { value: JSON.parse(bytes.toString("utf8")), bytes };
  } catch {
    return null;
  }
}

function configuredMaxTokenTtl(env: NodeJS.ProcessEnv): number {
  const raw = env.AUTH_JWT_MAX_TTL_SECONDS;
  if (raw === undefined || raw === "") return DEFAULT_MAX_ACCESS_TOKEN_TTL_SECONDS;
  if (!/^[1-9]\d*$/.test(raw)) {
    throw new Error("AUTH_JWT_MAX_TTL_SECONDS must be an integer between 60 and 86400.");
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 60 || value > MAX_CONFIGURABLE_ACCESS_TOKEN_TTL_SECONDS) {
    throw new Error("AUTH_JWT_MAX_TTL_SECONDS must be an integer between 60 and 86400.");
  }
  return value;
}

/**
 * Verify a compact access JWT signed with HS256 using a server-only secret.
 * Tokens require the access-token type, issuer, audience, iat, exp, sub and jti.
 * Access-token lifetime is bounded even if the trusted issuer accidentally
 * emits an excessively long expiry. Revocation is checked by the caller.
 */
export function verifyBearerToken(
  request: Request,
  env: NodeJS.ProcessEnv = process.env,
  nowSeconds = Math.floor(Date.now() / 1000),
): { id: string; sessionId: string; sessionExpiresAt: number } | null {
  const secret = env.AUTH_JWT_SECRET;
  if (typeof secret !== "string" || secret.length === 0) return null;
  if (Buffer.byteLength(secret, "utf8") < 32) {
    throw new Error("AUTH_JWT_SECRET must contain at least 32 bytes.");
  }

  const issuer = env.AUTH_JWT_ISSUER;
  const audience = env.AUTH_JWT_AUDIENCE;
  if (!issuer || !audience) {
    throw new Error("AUTH_JWT_ISSUER and AUTH_JWT_AUDIENCE are required when JWT authentication is enabled.");
  }
  const maxTokenTtl = configuredMaxTokenTtl(env);
  const expectedType = env.AUTH_JWT_TYPE ?? DEFAULT_ACCESS_TOKEN_TYPE;
  if (expectedType.trim().length === 0) {
    throw new Error("AUTH_JWT_TYPE must be a non-empty access-token type.");
  }

  const authorization = request.headers.get("authorization");
  const match = typeof authorization === "string" ? BEARER_PREFIX.exec(authorization) : null;
  if (!match || match[1].length > MAX_BEARER_TOKEN_LENGTH) return null;

  const parts = match[1].split(".");
  if (parts.length !== 3 || parts.some((part) => part.length === 0)) return null;

  const [encodedHeader, encodedPayload, encodedSignature] = parts;
  const decodedHeader = decodeSegment(encodedHeader);
  const decodedClaims = decodeSegment(encodedPayload);
  const header = decodedHeader?.value;
  const claims = decodedClaims?.value;
  if (!isRecord(header) || header.alg !== "HS256" || header.typ !== expectedType || !isRecord(claims)) {
    return null;
  }
  // The verifier intentionally supports only ordinary compact JWS access tokens;
  // it does not implement critical extensions, detached payloads or compression.
  if (header.b64 === false || header.crit !== undefined) return null;
  if (!/^[A-Za-z0-9_-]+$/.test(encodedSignature)) return null;

  let suppliedSignature: Buffer;
  try {
    suppliedSignature = Buffer.from(encodedSignature, "base64url");
    if (suppliedSignature.toString("base64url") !== encodedSignature) return null;
  } catch {
    return null;
  }
  const expectedSignature = createHmac("sha256", secret)
    .update(encodedHeader + "." + encodedPayload)
    .digest();
  if (suppliedSignature.length !== expectedSignature.length || !timingSafeEqual(suppliedSignature, expectedSignature)) {
    return null;
  }

  if (claims.iss !== issuer) return null;
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audiences.includes(audience)) return null;

  // NumericDate claims are safe integer seconds. Enforce a bounded access-token
  // lifetime in addition to checking whether it has expired.
  if (!Number.isSafeInteger(claims.iat) || claims.iat > nowSeconds) return null;
  if (!Number.isSafeInteger(claims.exp) || claims.exp <= nowSeconds || claims.exp <= claims.iat) return null;
  if (claims.exp - claims.iat > maxTokenTtl) return null;
  if (claims.nbf !== undefined &&
      (!Number.isSafeInteger(claims.nbf) || claims.nbf > nowSeconds || claims.nbf >= claims.exp)) return null;

  // Identity and revocable session IDs are opaque: never silently normalize them.
  if (typeof claims.sub !== "string" || claims.sub.length === 0 || claims.sub.trim() !== claims.sub) return null;
  if (typeof claims.jti !== "string" || claims.jti.length === 0 || claims.jti.trim() !== claims.jti) return null;

  return { id: claims.sub, sessionId: claims.jti, sessionExpiresAt: claims.exp };
}

export function createAuthContext(
  request: Request,
  env: NodeJS.ProcessEnv = process.env,
): { user: { id: string; sessionId: string; sessionExpiresAt: number } | null } {
  return { user: verifyBearerToken(request, env) };
}
