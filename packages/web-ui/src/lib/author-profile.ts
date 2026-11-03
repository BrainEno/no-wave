/**
 * Boundary helpers for the writing desk's author profile.
 *
 * The UI only needs the public byline, not the API's full profile shape: a
 * missing or malformed answer is "no pen name yet", and an edit is sent to the
 * API only after it has been trimmed and bounded here.
 */

export type AuthorProfile = { displayName: string; locale: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseAuthorProfile(payload: unknown): AuthorProfile | null {
  if (!isRecord(payload) || !isRecord(payload.data)) return null;
  const displayName = payload.data.displayName;
  if (typeof displayName !== "string" || displayName.trim().length === 0) return null;
  const locale = typeof payload.data.locale === "string" ? payload.data.locale : "zh-CN";
  return { displayName: displayName.trim(), locale };
}

/** The API accepts 1–120 characters after trimming; an empty name is not a profile. */
export function normalizeDisplayName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 120) return null;
  return trimmed;
}
