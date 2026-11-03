/**
 * Whether this deployment has switched media **deletion** on.
 *
 * The API enforces the switch on `DELETE /api/v1/me/media/:id` (409
 * `MEDIA_DELETE_DISABLED`) and reports it in every library page as
 * `deletionEnabled`; the page draws its delete button from that answer rather
 * than from a constant of its own, so there is exactly one switch. This module
 * exists for the one case the response cannot cover: a Web tier rendering
 * before it has talked to the API, or an older API that predates the field. Both
 * default to off.
 *
 * The rule is copied from `apps/api/src/application/media-assets.ts`
 * (`isMediaDeleteEnabled`) rather than imported: the API must not depend on a
 * Web package. Each side pins the same contract in its own test, and
 * `.env.example` is the operator's copy of it.
 *
 * Off by default. Unset, empty and unrecognised values all mean off: a typo must
 * not delete somebody's image.
 */
export const MEDIA_DELETE_ENABLED_VALUES: readonly string[] = Object.freeze(["true", "1", "yes", "on"]);

export function isMediaDeleteEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const raw = typeof env.MEDIA_DELETE_ENABLED === "string" ? env.MEDIA_DELETE_ENABLED.trim().toLowerCase() : "";
  return MEDIA_DELETE_ENABLED_VALUES.includes(raw);
}
