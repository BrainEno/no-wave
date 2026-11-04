import type { Locale } from "./content.ts";
import { getUi, type UiCopy } from "./ui-copy.ts";

/**
 * The shape the API answers with when it refuses a request.
 *
 * Every field is optional on purpose: the payload arrives from the network and
 * this module's job is to survive a body that is missing, empty, or not JSON at
 * all, which is what a proxy answers with when the API is down.
 */
export type ApiErrorPayload = { error?: { code?: unknown; message?: unknown } };

/**
 * The codes a form can say something useful about.
 *
 * The API answers with a stable code and a deliberately generic English
 * sentence: it cannot know what the page around it is doing, and it must not
 * leak internals. A code is the seam where the two meet — the page reads the
 * code and speaks to the reader in the page's own language. Codes that are not
 * listed here keep whatever the server said.
 */
const CODE_MESSAGES: Readonly<Record<string, (ui: UiCopy) => string>> = Object.freeze({
  // Registering an address that already has an account, or moving an account
  // onto an address somebody else holds. Both are 409; the difference from a
  // generic conflict is that the reader has a next step.
  EMAIL_TAKEN: (ui) => ui.auth.emailTaken,
  // A 429 must never echo the API's generic English sentence. The form adds a
  // wait time when the proxy relays a valid Retry-After; every other surface
  // gets this language-appropriate answer.
  RATE_LIMITED: (ui) => ui.auth.rateLimited,
});

/** The code the API answered with, or `""` when the body has none. */
export function apiErrorCode(payload: unknown): string {
  if (typeof payload !== "object" || payload === null || !("error" in payload)) return "";
  const error = (payload as ApiErrorPayload).error;
  if (typeof error !== "object" || error === null) return "";
  return typeof error.code === "string" ? error.code : "";
}

/**
 * Words to show a reader for a refused request.
 *
 * A known code is answered from the interface copy, so the sentence matches the
 * page around it. Anything else keeps the server's message — an unknown code
 * with a generic fallback would hide the one clue that is left — and a body
 * with nothing usable in it falls back to `fallback`.
 */
export function apiErrorMessage(payload: unknown, locale: Locale, fallback?: string): string {
  const ui = getUi(locale);
  const resolved = fallback ?? ui.auth.failed;
  if (typeof payload !== "object" || payload === null || !("error" in payload)) return resolved;
  const error = (payload as ApiErrorPayload).error;
  if (typeof error !== "object" || error === null) return resolved;
  const known = CODE_MESSAGES[apiErrorCode(payload)];
  if (known) return known(ui);
  return typeof error.message === "string" && error.message ? error.message : resolved;
}
