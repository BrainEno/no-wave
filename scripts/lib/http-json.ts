/**
 * Shared HTTP response JSON parsing helpers for developer and verification scripts.
 *
 * Avoids duplicating JSON parse error handling and record narrowing across scripts.
 */

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseJson(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text);
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

export async function readJson(
  response: Response,
): Promise<Record<string, unknown> | null> {
  return parseJson(await response.text());
}
