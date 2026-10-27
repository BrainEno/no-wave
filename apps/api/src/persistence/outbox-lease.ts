import { isUuid } from "../domain/validation.ts";

/** Completion and retry require the token issued for this particular claim. */
export function assertOutboxLease(eventId: unknown, leaseToken: unknown): void {
  if (typeof eventId !== "string" || eventId.trim().length === 0 || eventId !== eventId.trim()) {
    throw new TypeError("eventId must be a non-empty, trimmed string.");
  }
  if (!isUuid(leaseToken)) {
    throw new TypeError("leaseToken must be the UUID returned by claimOutboxEvents.");
  }
}
