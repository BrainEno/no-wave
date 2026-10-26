import { ArticleInputError } from "./errors.ts";

export function isUuid(value: unknown): value is string {
  return typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

export function requiredText(name: string, value: unknown, maxLength = 2000): string {
  if (typeof value !== "string" || value.trim().length === 0 || value !== value.trim() || value.length > maxLength) {
    throw new ArticleInputError(`${name} must be a non-empty, trimmed string no longer than ${maxLength} characters.`);
  }
  return value;
}
