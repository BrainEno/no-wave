import type { Locale } from "./content.ts";
import { getUi } from "./ui-copy.ts";

/**
 * The sentence a reader sees between a successful sign-in and the router's
 * `replace()` (#185).
 *
 * The loader decides where the reader goes — `/account` by default, or a legal
 * `next` — and this module only names that destination. It never rewrites the
 * path: a destination the interface has no word for gets a generic, still
 * truthful label rather than a guess. Keeping it pure lets the copy be checked
 * without rendering React or driving a browser.
 */
export type SignInMode = "login" | "register";

const ORIGIN = "https://no-wave.invalid";

/** A short name for the page `nextPath` points at. */
export function destinationLabel(nextPath: string, locale: Locale): string {
  const ui = getUi(locale);
  let pathname: string;
  try {
    const parsed = new URL(nextPath, ORIGIN);
    if (parsed.origin !== ORIGIN) return ui.auth.destination.fallback;
    pathname = parsed.pathname;
  } catch {
    return ui.auth.destination.fallback;
  }
  // `/en` is a locale prefix, not a different product page.
  if (pathname === "/en" || pathname.startsWith("/en/")) pathname = pathname.slice(3) || "/";
  if (pathname === "/account" || pathname.startsWith("/account/")) return ui.auth.destination.account;
  if (pathname === "/write" || pathname.startsWith("/write/")) return ui.auth.destination.write;
  if (pathname === "/") return ui.auth.destination.home;
  return ui.auth.destination.fallback;
}

export function signInSuccessMessage(nextPath: string, mode: SignInMode, locale: Locale): string {
  const ui = getUi(locale);
  const place = destinationLabel(nextPath, locale);
  return mode === "register" ? ui.auth.registerSuccess(place) : ui.auth.loginSuccess(place);
}
