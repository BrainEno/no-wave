import { data } from "react-router";
import { PRIVATE_PAGE_HEADERS } from "./http-policy.ts";

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
  return data(
    { reason: "content-api-unavailable", errorName: safeErrorName(error) },
    { status: 503, headers: PRIVATE_PAGE_HEADERS },
  );
}

/**
 * 404 for a public entity that does not exist.
 *
 * The headers matter as much as the status: an error page must never be stored
 * by a shared cache, because the entity may appear a minute later.
 */
export function entityNotFound(reason: string) {
  return data({ reason }, { status: 404, headers: PRIVATE_PAGE_HEADERS });
}
