/**
 * The one upstream response header the browser is allowed to see (#184).
 *
 * `Retry-After` may be a delta in seconds or an HTTP date. Relay it only as a
 * bounded, normalized integer number of seconds: a reconstructed response must
 * never become a channel for arbitrary upstream headers, header injection or an
 * absurd wait that a form cannot display.
 */

const SECONDS_PATTERN = /^\d{1,10}$/;
const MAX_RETRY_AFTER_SECONDS = 24 * 60 * 60;
const MAX_HEADER_LENGTH = 128;

/**
 * Parse an upstream `Retry-After` into seconds the UI can show, or `null` when
 * the value is absent, malformed or already in the past. The result is always
 * an integer between 1 and 24 hours, whatever the upstream sent.
 */
export function parseRetryAfterSeconds(value: string | null, now = Date.now()): number | null {
  if (value === null) return null;
  const raw = value.trim();
  if (raw.length === 0 || raw.length > MAX_HEADER_LENGTH) return null;

  let seconds: number;
  if (SECONDS_PATTERN.test(raw)) {
    seconds = Number(raw);
  } else {
    const deadline = Date.parse(raw);
    if (!Number.isFinite(deadline)) return null;
    seconds = Math.ceil((deadline - now) / 1000);
  }
  if (!Number.isFinite(seconds) || seconds < 1) return null;
  return Math.min(MAX_RETRY_AFTER_SECONDS, Math.trunc(seconds));
}
