# Authoring language editions

Status: active

The writing desk creates new works in `zh-CN` or `en`. `zh-TW` is not
supported for new works (issue #417): the desk does not offer it, and
`POST /api/v1/articles` rejects it with `400`. Existing `zh-TW` works remain
accessible and editable. Article `PUT` requests still accept the three stored
locale values so that legacy works can be saved with their locale; all other
values are rejected. An omitted locale still means `zh-CN` for compatibility,
so clients editing a non-default edition **must send its stored locale
explicitly**. Profile and comment write rules are unchanged.

Other paths that could create a `zh-TW` edition (issue #417):

- Notion import refuses any page whose edition would be `zh-TW`, including one
  kept from an earlier import, and leaves the existing work unchanged.
- The catalogue edition routes are read-only (`GET`), so they cannot create an
  edition. Existing `zh-TW` editions can still be read through them.
- Open gap: `PUT /api/v1/articles/{id}` with `locale: "zh-TW"` still adds a
  `zh-TW` edition to a work that lacks one. The end-to-end legacy-seed journey
  depends on this, so blocking it needs a DB-level seed and an owner decision.

An article ID identifies a work, while `(article ID, locale)` identifies one
of its translations. A `PUT` with a different explicit locale inserts or
**replaces** that translation; it does not rename or delete the original. The
desk asks for confirmation before saving to a different locale, because an
existing target translation can be overwritten. Slug, work type, publication
status and deletion are properties of the whole work. Deleting or withdrawing
one edition affects all editions; restoring any one of its tombstones restores
the whole work as a draft, retaining its translations.

`GET /api/v1/me/articles` and `/api/v1/me/articles/deleted` remain private,
no-store, single-locale reads: with no query they select `zh-CN`, and
`?locale=en` or `?locale=zh-TW` selects exactly that translation. No content is
returned under the wrong language. `?allLocales=true` is an opt-in for the
writing desk: it reads all three locales for the same authenticated actor,
returns each edition independently, newest first, and includes
`meta.locales` listing the locales read. It cannot be combined with `locale`;
invalid selections are rejected rather than guessed. `limit` (1–100, default
50) applies **per locale** in this mode, so a response contains at most 300
editions. If any locale read fails, the entire request fails. The three reads
are not a cross-locale database snapshot: concurrent edits can race a list
refresh. Existing author lists have no paging beyond the per-locale limit.

The Web proxy preserves the old single-locale default and forwards the opt-in
with `limit=100`. The desk labels and distinguishes editions by ID and locale,
and states the 100-per-language limit. Its recycle bin uses the same selection;
restore forwards the clicked edition's `locale` so a non-`zh-CN` tombstone is
not mistaken for a missing translation. Public Web addresses exist for `zh-CN`
(`/articles/:slug`) and `en` (`/en/articles/:slug`); there is no `zh-TW` Web route, and the API serves `zh-TW` only for existing works.

## Independent deployments

Deploy the API before the Web change, and roll the Web back before the API.
Older API releases ignore the new query parameter and answer with only `zh-CN`.
The desk therefore requires the complete `meta.locales` marker and reports an
error instead of pretending such an answer is a complete list (the recycle bin
reports its own error). During a version mismatch the new desk cannot be used
until the API is upgraded; older Web clients retain their previous behavior
against the newer API. No database migration or content relabeling is needed.
