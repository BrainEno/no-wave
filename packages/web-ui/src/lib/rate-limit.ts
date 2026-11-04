import { parseRetryAfterSeconds } from "@bot-thk/web-http";
import { apiErrorCode, apiErrorMessage } from "./api-error.ts";
import type { Locale } from "./content.ts";
import { getUi } from "./ui-copy.ts";

/**
 * What a sign-in form says when the API refuses it (#184).
 *
 * Only `RATE_LIMITED` is special: the API's generic English sentence becomes a
 * localized one, and a valid `Retry-After` becomes a wait the reader can act
 * on. Every other code keeps its existing answer — including the deliberately
 * identical sentence for an unknown address and a wrong password, which must
 * not become an account-enumeration oracle.
 */

/** A short, readable wait: seconds below a minute, otherwise whole minutes. */
export function retryWaitLabel(seconds: number, locale: Locale): string {
  const ui = getUi(locale);
  const whole = Number.isFinite(seconds) && seconds >= 1 ? Math.trunc(seconds) : 1;
  if (whole < 60) return ui.auth.retrySeconds(whole);
  return ui.auth.retryMinutes(Math.ceil(whole / 60));
}

export function signInFailureMessage(
  payload: unknown,
  locale: Locale,
  retryAfterHeader: string | null,
  fallback?: string,
): string {
  const ui = getUi(locale);
  if (apiErrorCode(payload) === "RATE_LIMITED") {
    const seconds = parseRetryAfterSeconds(retryAfterHeader);
    return seconds === null ? ui.auth.rateLimited : ui.auth.rateLimitedWait(retryWaitLabel(seconds, locale));
  }
  return apiErrorMessage(payload, locale, fallback ?? ui.auth.failed);
}
