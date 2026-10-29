import { data } from "react-router";

/**
 * Loader failure policy for public pages.
 *
 * An unreachable or failing content API is a **503** here, not a 500: the page
 * itself is fine, the upstream is not, and a crawler should be told to come back
 * rather than to treat the URL as broken. Only an error *class* is carried into
 * the response — never a message, stack or URL — because the payload is rendered
 * by the error boundary that any visitor can see.
 */
function safeErrorName(error: unknown): string {
  if (!(error instanceof Error)) return "NonErrorThrow";
  return /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(error.name) ? error.name : "Error";
}

export function upstreamUnavailable(error: unknown) {
  return data({ reason: "content-api-unavailable", errorName: safeErrorName(error) }, { status: 503 });
}
