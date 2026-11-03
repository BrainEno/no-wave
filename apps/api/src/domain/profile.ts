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

/**
 * The public author directory's bounds (ADR 0024).
 *
 * A name is short, so the query is bounded — an unbounded `LIKE` over every
 * profile is a request somebody could use to make the database do work for them.
 * The offset is bounded for the same reason deep offsets always are: page ten
 * thousand of a directory is not a page anybody reads.
 */
/**
 * A freshly registered account always has a public author profile. The default
 * pen name is generic on purpose: it must not echo the email address, which is
 * a login identifier rather than public byline. The author can change it from
 * the writing desk.
 */
export const DEFAULT_AUTHOR_DISPLAY_NAME = "无浪作者";

export const AUTHOR_QUERY_MAX_LENGTH = 200;
export const AUTHOR_OFFSET_MAX = 100_000;

/** A row that predates the column, or a profile that has none yet, is a member. */
export function normalizeStoredRole(value: unknown): UserRole {
  return USER_ROLES.includes(value as UserRole) ? (value as UserRole) : DEFAULT_USER_ROLE;
}
