import { ProfileInputError } from "./errors.ts";

export function validateProfileUrl(name: string, value: unknown, allowRelative: boolean): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string" || value.trim().length === 0 || value !== value.trim() || value.length > 2048) {
    throw new ProfileInputError(name + " must be null or a non-empty URL no longer than 2048 characters.");
  }
  if (allowRelative && value.startsWith("/") && !value.startsWith("//")) return value;
  let parsed;
  try { parsed = new URL(value); } catch {
    throw new ProfileInputError(name + " must be a site-relative path or an HTTP(S) URL.");
  }
  if (!["http:", "https:"].includes(parsed.protocol) || !parsed.hostname) {
    throw new ProfileInputError(name + " must use HTTP or HTTPS.");
  }
  return parsed.toString();
}

/**
 * The two account roles, and the only permission question the platform asks today.
 *
 * `member` can publish, comment, follow and tag. `editor` additionally curates:
 * the public category list and the featured shelf (ADR 0016). There is no
 * "admin" — moderation and reporting are issue #72 and get their own design;
 * this column is deliberately too small to grow into one.
 */
export const USER_ROLES = Object.freeze(["member", "editor"] as const);
export type UserRole = (typeof USER_ROLES)[number];
export const DEFAULT_USER_ROLE: UserRole = "member";

export function validateUserRole(value: unknown): UserRole {
  if (typeof value !== "string" || !USER_ROLES.includes(value as UserRole)) {
    throw new ProfileInputError(`role must be one of: ${USER_ROLES.join(", ")}.`);
  }
  return value as UserRole;
}

/** A row that predates the column, or a profile that has none yet, is a member. */
export function normalizeStoredRole(value: unknown): UserRole {
  return USER_ROLES.includes(value as UserRole) ? (value as UserRole) : DEFAULT_USER_ROLE;
}
