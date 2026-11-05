/** A key identifies a logical write, not an individual HTTP attempt. */
export const IDEMPOTENCY_KEY_HEADER = "idempotency-key";
export const IDEMPOTENCY_KEY_MAX_LENGTH = 300;

export function mintKey(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  if (typeof crypto === "undefined" || typeof crypto.getRandomValues !== "function") {
    throw new Error("Secure randomness is unavailable.");
  }
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export type PendingIntent = { key: string; payload: string };

/**
 * A retry must reuse both the key and the request body. Return null when the
 * user has edited a still-unconfirmed intent: silently assigning its key to a
 * different payload could produce a conflict or an unintended second write.
 * The caller must keep the previous intent until success or explicit discard.
 */
export function intentForAttempt(previous: PendingIntent | null, payload: string): PendingIntent | null {
  if (previous) return previous.payload === payload ? previous : null;
  return { key: mintKey(), payload };
}
