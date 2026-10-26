import { ArticleInputError } from "./errors.ts";

export function isUuid(value) {
  return typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

export function requiredText(name, value, maxLength = 2000) {
  if (typeof value !== "string" || value.trim().length === 0 || value !== value.trim() || value.length > maxLength) {
    throw new ArticleInputError(`${name} must be a non-empty, trimmed string no longer than ${maxLength} characters.`);
  }
  return value;
}
