/**
 * What may travel in a diagnostic log line (audit F-21).
 *
 * Two places in the API write a *driver* message into a log: the startup failure
 * line, and `rest_unhandled_error` for a 500. Both exist because "the access log
 * says 500 and nothing else" is not diagnosable, and both are capped — but capped
 * is not the same as safe:
 *
 * - a PostgreSQL DSN carries its password in the userinfo
 *   (`postgres://writer:…@db.internal/no_wave`), and a driver that was handed a
 *   malformed DSN can quote it back verbatim;
 * - SQLite errors quote the file path, and some drivers quote the failing
 *   statement with its bound values;
 * - a message is also where an operator's own secret ends up, because the
 *   process put it in the environment and something printed it.
 *
 * So a message is redacted twice before it is logged: known secret *values* from
 * the environment are masked wherever they appear, and DSN-shaped credentials and
 * `password=`-style pairs are masked by pattern. The line is then flattened to one
 * line and capped — a log line that spans several lines breaks every log pipeline
 * that reads it.
 */

export const DIAGNOSTIC_MAX_LENGTH = 500;

/** A value shorter than this is too likely to be a word, not a secret. */
const MINIMUM_SECRET_LENGTH = 8;

/** `postgres://user:pass@host/db` and every other scheme with userinfo. */
const URL_USERINFO = /([a-z][a-z0-9+.-]*:\/\/)[^\s/@]*@/gi;

/** `password=hunter2`, `secret: abc`, `api_key = …` — separators that appear in real messages. */
const CREDENTIAL_PAIR = /\b(password|passwd|pwd|secret|secretkey|secret_key|api[_-]?key|token|authorization|credential)\b(\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s&,;]+)/gi;

/**
 * Values that must never appear in a log line, taken from the environment.
 *
 * Only the variables this API actually reads, and only their non-empty values:
 * masking a value the process never uses would be theatre, and an empty value
 * would match everywhere.
 */
export function secretValues(env: NodeJS.ProcessEnv = process.env): string[] {
  const names = [
    "DATABASE_URL",
    "DATABASE_URL_UNPOOLED",
    "AUTH_JWT_SECRET",
    "MAIL_SMTP_PASSWORD",
    "MEDIA_S3_SECRET_ACCESS_KEY",
    "AWS_SECRET_ACCESS_KEY",
    "OUTBOX_DRAIN_SECRET",
  ];
  const values: string[] = [];
  for (const name of names) {
    const value = env?.[name];
    if (typeof value === "string" && value.trim().length >= MINIMUM_SECRET_LENGTH) values.push(value.trim());
  }
  return values;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * A message safe to put in one JSON log line, or `null` when there is nothing
 * worth logging.
 *
 * `null` rather than `""` on purpose: the callers spread the result into a record
 * conditionally, so an absent message stays absent instead of becoming a field
 * that says nothing.
 */
export function redactDiagnostic(
  message: unknown,
  {
    secrets = [],
    maxLength = DIAGNOSTIC_MAX_LENGTH,
  }: { secrets?: Array<string | undefined>; maxLength?: number } = {},
): string | null {
  if (typeof message !== "string") return null;
  let redacted = message;
  for (const secret of secrets) {
    if (typeof secret !== "string" || secret.length < MINIMUM_SECRET_LENGTH) continue;
    redacted = redacted.replace(new RegExp(escapeRegExp(secret), "g"), "<redacted>");
  }
  redacted = redacted.replace(URL_USERINFO, "$1<redacted>@");
  redacted = redacted.replace(CREDENTIAL_PAIR, (_match, key: string, separator: string) => `${key}${separator}<redacted>`);
  // One line, always: a newline in a JSON string is legal and still breaks the
  // operators who pipe these lines into something that reads one line at a time.
  redacted = redacted.replace(/\s+/g, " ").trim();
  if (redacted.length === 0) return null;
  return redacted.length > maxLength ? redacted.slice(0, maxLength) : redacted;
}
