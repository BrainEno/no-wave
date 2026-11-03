import { createHash } from "node:crypto";

export function requestHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function parseJsonValue(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try { return JSON.parse(value); } catch { return value; }
}

export function isoDate(value: unknown): string {
  return value instanceof Date ? value.toISOString() : new Date(value as string).toISOString();
}

export function isoDateNullable(value: unknown): string | null {
  if (value == null) return null;
  return value instanceof Date ? (value as Date).toISOString() : new Date(value as string).toISOString();
}
