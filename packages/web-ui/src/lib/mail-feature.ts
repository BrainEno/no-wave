/**
 * Whether this deployment has switched account mail on.
 *
 * One switch, two readers: the API refuses the endpoints that would put a link
 * in somebody's inbox (409 `MAIL_DISABLED`), and the Web tier stops showing the
 * interface for them. Both read `MAIL_ENABLED` from the same environment — the
 * repository-root `.env.local` configures both processes — so one value keeps
 * the server and the pages from disagreeing.
 *
 * The API's own copy lives in `apps/api/src/application/identity-mailer.ts`
 * (`isMailEnabled`); the API must not depend on a Web package, so the two are
 * written against the same contract instead of importing one another. Each has
 * a test pinning that contract, and `.env.example` is the operator's version of
 * it.
 *
 * Deliberately **not** `NEXT_PUBLIC_*`: those are inlined at build time, and
 * being able to switch mail off without rebuilding the site is the point. This
 * is read on the server, at request time, in the pages that need it, and handed
 * to the client components as a prop.
 *
 * Off by default. Unset, empty and unrecognised values all mean off: a typo
 * must not switch mail on.
 */
export const MAIL_ENABLED_VALUES: readonly string[] = Object.freeze(["true", "1", "yes", "on"]);

export function isMailEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const raw = typeof env.MAIL_ENABLED === "string" ? env.MAIL_ENABLED.trim().toLowerCase() : "";
  return MAIL_ENABLED_VALUES.includes(raw);
}
