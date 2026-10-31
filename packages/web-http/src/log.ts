/**
 * Structured logging for the Web tier.
 *
 * A host collects stdout and stderr **line by line**, so one event is one line
 * and one line is one JSON object — the same shape the API and the notification
 * worker already emit (`timestamp`, `level`, `component`, `event`). Anything
 * else makes a log drain guess where a record starts.
 *
 * Nothing request-derived is logged verbatim. Query strings carry password
 * reset and email verification tokens, and a host's log retention is not the
 * place for those: a URL is reduced to its path, and even that is bounded.
 *
 * Framework-neutral on purpose (ADR 0012): the React Router server and, later,
 * any other adapter emit the same records, so an operator learns one log shape.
 */

export type WebLogLevel = "info" | "warn" | "error";

export type WebLogFields = Readonly<Record<string, string | number | boolean | null>>;

/** The `component` value every Web-tier record carries. */
export const WEB_LOG_COMPONENT = "web-rr";

/** Path names are logged, never URLs; this is the longest one kept. */
const MAX_LOGGED_PATH = 120;

/**
 * Reduce a request target to something safe to log: the path, never the query
 * string, never the fragment, never the credentials.
 */
export function safeLogPath(url: string | undefined | null): string {
  if (typeof url !== "string" || url.length === 0) return "/";
  let pathname: string;
  try {
    pathname = new URL(url, "http://localhost").pathname;
  } catch {
    return "/invalid";
  }
  if (pathname.length === 0 || pathname[0] !== "/") return "/invalid";
  if (pathname.length > MAX_LOGGED_PATH) return `${pathname.slice(0, MAX_LOGGED_PATH)}...`;
  return pathname;
}

/** Build one log line. `timestamp` is injectable so tests never sleep. */
export function formatLogLine(
  event: string,
  fields: WebLogFields = {},
  level: WebLogLevel = "info",
  timestamp = new Date().toISOString(),
): string {
  return `${JSON.stringify({
    timestamp,
    level,
    component: WEB_LOG_COMPONENT,
    event,
    ...fields,
  })}\n`;
}

/**
 * Write one record: warnings and errors to stderr, everything else to stdout,
 * because a host may route the two streams to different places.
 *
 * A write failure is swallowed on purpose — logging must never turn an
 * otherwise successful request into a failed one.
 */
export function writeLogLine(
  event: string,
  fields: WebLogFields = {},
  level: WebLogLevel = "info",
): void {
  const line = formatLogLine(event, fields, level);
  try {
    if (level === "warn" || level === "error") process.stderr.write(line);
    else process.stdout.write(line);
  } catch {
    // Nothing useful to do: the process is losing its log stream, not its work.
  }
}
