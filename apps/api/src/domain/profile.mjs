import { ProfileInputError } from "./errors.mjs";

export function validateProfileUrl(name, value, allowRelative) {
  if (value === undefined || value === null) return value;
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
