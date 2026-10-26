import { createHmac, timingSafeEqual } from "node:crypto";

const BEARER_PREFIX = /^Bearer\s+(.+)$/i;
const MAX_BEARER_TOKEN_LENGTH = 8192;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function decodeSegment(segment: string): unknown {
  try {
    return JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

/**
 * Verify a compact JWT signed with HS256 using a server-only secret.
 * Tokens are accepted only when issuer, audience, expiry, and subject are valid.
 * Oversized credentials and invalid configuration never create an authenticated user.
 */
export function verifyBearerToken(request: Request, env: NodeJS.ProcessEnv = process.env, nowSeconds = Math.floor(Date.now() / 1000)): { id: string; sessionId: string; sessionExpiresAt: number } | null {
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

  const authorization = request.headers.get("authorization");
  const match = typeof authorization === "string" ? BEARER_PREFIX.exec(authorization) : null;
  if (!match || match[1].length > MAX_BEARER_TOKEN_LENGTH) return null;

  const parts = match[1].split(".");
  if (parts.length !== 3 || parts.some((part) => part.length === 0)) return null;

  const [encodedHeader, encodedPayload, encodedSignature] = parts;
  const header = decodeSegment(encodedHeader);
  const claims = decodeSegment(encodedPayload);
  if (!isRecord(header) || header.alg !== "HS256" || !isRecord(claims)) {
    return null;
  }

  let suppliedSignature;
  try {
    suppliedSignature = Buffer.from(encodedSignature, "base64url");
  } catch {
    return null;
  }
  const expectedSignature = createHmac("sha256", secret)
    .update(`${encodedHeader}.${encodedPayload}`)
    .digest();
  if (suppliedSignature.length !== expectedSignature.length || !timingSafeEqual(suppliedSignature, expectedSignature)) {
    return null;
  }

  if (claims.iss !== issuer) return null;
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audiences.includes(audience)) return null;
  if (typeof claims.exp !== "number" || !Number.isFinite(claims.exp) || claims.exp <= nowSeconds) return null;
  if (claims.nbf !== undefined &&
      (typeof claims.nbf !== "number" || !Number.isFinite(claims.nbf) || claims.nbf > nowSeconds)) return null;
  // Identity and revocable session IDs are opaque: never silently normalize them.
  if (typeof claims.sub !== "string" || claims.sub.length === 0 || claims.sub.trim() !== claims.sub) return null;
  if (typeof claims.jti !== "string" || claims.jti.length === 0 || claims.jti.trim() !== claims.jti) return null;

  return { id: claims.sub, sessionId: claims.jti, sessionExpiresAt: claims.exp };
}

export function createAuthContext(request: Request, env: NodeJS.ProcessEnv = process.env): { user: { id: string; sessionId: string; sessionExpiresAt: number } | null } {
  return { user: verifyBearerToken(request, env) };
}
