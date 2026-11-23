# Notion interchange: importing a database, exporting work back

This document is the bridge between a Notion database and this site's articles:
what the author's own database actually contains, how each property and block
maps, what cannot be carried, and the order the parts ship in. The decision
behind it is [ADR 0036](../architecture/decisions/0036-notion-as-interchange-format.md);
the mapping itself is `apps/api/src/application/notion-interchange.ts`, and it is
the single source of truth for both directions.

Read this as a contract, not a proposal: every row below is implemented and
covered by `notion-interchange.test.ts`, or it is explicitly listed as *not
carried*.

## 1. What the database in use contains

Inspected 2026-11-03: data source "Bottom Think"
(`01331af0-b39c-4c76-991c-a2d67804c5ca`), eleven properties, three pages' property
values and two pages' bodies (the 13-block 「墙壁」 and the twenty-odd-paragraph
「飞行器」).

| Notion property | Type | Observed | Meaning on this site |
| --- | --- | --- | --- |
| `Page` | title | 「墙壁」, `Aircraft` | `title` |
| `Slug` | rich text | `墙壁` — the *title*, not an ASCII address | a slug **if** it is already ASCII, otherwise derived (see §3) |
| `Excerpt` | rich text | usually empty | `summary` |
| `Date` | date | `2026-10-08`, no time, no zone | `publishedAt` (see §4) |
| `Published` | checkbox | `true` on the primary pages, `false` on an English page | `publish` |
| `FeaturedImage` | files | often empty; signed S3 URLs when set | **not carried** — no cover field on an article (see §6) |
| `Tags` | multi-select | `诗歌`, `小说`, `其他` | taxonomy `tag`s **and** `workType` (see §5) |
| `English` | relation → same database | points at the paired page, both ways | the `en` edition of the same work |
| `Parent item` / `Sub-item` | relation → same database | mostly empty | **not carried** — no hierarchy (see §6) |
| `Rank` | number | `1`, `2` … | **not carried** — ordering belongs to the reading surfaces |

The bodies are paragraphs in practice (occasional empty spacer paragraphs carry
visual rhythm only). The rest of the block vocabulary is handled for other
people's databases, not because this one needs it.

## 2. Property mapping (Notion → article draft)

`articleDraftFromNotionPage({ page, blocks, options })` returns
`{ draft, issues }`; `draft` is `null` when the page cannot be an article.

| Draft field | Source | Rules |
| --- | --- | --- |
| `title` | the property whose type is `title` | trimmed; a page without one is refused (`empty-title`) |
| `summary` | `Excerpt` (name configurable) | truncated to 2000 characters |
| `slug` | `Slug` → title | an already-ASCII slug is kept; anything else is transliterated (`slug-derived`) |
| `locale` | caller's `locale` option → the page's language | a page that another page's `English` relation points at is `en`, the page pointing at it `zh-CN`; a page with no relation is `en` when no Han/kana/hangul character appears anywhere in it and it has Latin text to read, otherwise `zh-CN` (`inferEditionLocale`, [ADR 0055](../architecture/decisions/0055-edition-language-from-text.md)) |
| `publish` | `Published` | `options.publish` overrides it |
| `publishedAt` | `Date` | UTC; a published page with no `Date` uses the injected clock |
| `tags` | `Tags` | names trimmed, empties dropped |
| `workType` | `Tags` → `workTypeByTag` table | `小说→novel`, `诗歌→poetry`, `诗→poetry`, `其他→other` (the author's own Notion tags); the finer genre words fold the same way as the stored works did (ADR 0054): `短篇`/`长篇`/`连载→novel`, `散文`/`评论`/`文学批评`/`非虚构`/`其他文体→other`; anything else is `other` with `work-type-fallback` |
| `contentBlocks` | the page's blocks | see §5 |
| `contentBlocksVersion` | — | always `1` (inline marks and links are carried) |
| `externalId` | the page id | the identity used for idempotent re-import |

Property *names* are options (`propertyNames`), because the next author's
database is not this one; only the title property is found by type, since its
name is arbitrary.

## 3. Slugs

This site's public address is work-level, globally unique and ASCII-only
(`^[a-z0-9]+(?:-[a-z0-9]+)*$`, see `validateArticleSlug`). The author's
database puts the Chinese title in `Slug`, which that contract cannot hold. The
mapping therefore reuses the site's own rule for hand-written work —
`slugifyArticleTitle`, word-segmented pinyin:

| Title | Derived address |
| --- | --- |
| 墙壁 | `qiangbi` |
| 巡逻队 | `xunluo-dui` |
| 裁掉 | `cai-diao` |
| 飞行器 | `feixing-qi` |
| 学校的所在 | `xuexiao-de-suozai` |

Uniqueness is **not** the mapping's job: the store owns it (a unique index on
`articles.slug`), and an importer resolves collisions exactly as the authoring
desk does. Because the address is work-level, the primary edition decides it and
the `en` edition shares it.

## 4. Dates and timestamp precision

`Date` is a calendar day with no time zone. The site stores `timestamptz` at
millisecond precision and *shows a date*, so the only neutral reading is **UTC
midnight of that day**: `2026-10-08` → `2026-10-08T00:00:00.000Z`.

| Notion `Date.start` | Stored `publishedAt` | Why |
| --- | --- | --- |
| `2026-10-08` | `2026-10-08T00:00:00.000Z` | the date is the fact; UTC keeps it identical for every reader |
| `2026-10-08T09:30:00.000Z` | `2026-10-08T09:30:00.000Z` | already zoned, honoured exactly |
| `2026-10-08T09:30:00+08:00` | `2026-10-08T01:30:00.000Z` | converted, not reinterpreted |
| `2026-10-08T09:30:00` | `2026-10-08T09:30:00.000Z` | a zone-less instant is read as UTC, never as the server's local time |
| absent | `now()` when published, `null` when a draft | a draft has not been published yet |

In the desk the author may instead fill an absent `Date` from the page's creation
day; it is off by default and changes only what the desk sends (see *Filling a
missing Date from the creation date* at the end of this document).

Export writes the date back as `YYYY-MM-DD` (Notion's own day granularity), so a
round trip does not accumulate time-of-day drift.

Two things about that day are worth stating plainly, because they are not the
same fact:

- **This site stamps its own publication instant.** Publishing (here, or through
  an import) writes `published_at` with the site's clock; the `Date` a Notion page
  carried is *not* what a work's publication day becomes. So an exported bundle
  carries the day **this** site published on, which may differ from the day the
  page it came from carried.
- **A re-import compares the digest, and the digest covers that day.** Re-importing
  a freshly exported bundle is therefore an `update` the first time — identical
  content, one write — and a `skip` from then on, because the stored digest and
  the bundle's draft now agree. `imports.integration.test.ts` asserts exactly that
  convergence rather than claiming a round trip is a no-op on its first pass.

## 5. Blocks

The site's block model is `paragraph`, `heading` (levels 2–4), `quote`, `list`
(ordered or not, up to 100 items), `image`, `code`, with inline runs carrying
`bold` / `italic` / `underline` / `strikethrough` / `code` and one `href`.

### 5.1 Direction: Notion → article

| Notion block | Becomes | Notes |
| --- | --- | --- |
| `paragraph` | `paragraph` | empty paragraphs are dropped (`empty-block-dropped`) — the site's spacing is CSS, not empty rows |
| `heading_1` / `heading_2` / `heading_3` | `heading` level 2 / 3 / 4 | a document cannot carry its own H1: the page title is the H1 |
| `quote` | `quote` | a `quote` block's attribution is not a Notion concept, so it is not read |
| `bulleted_list_item` / `numbered_list_item` | one `list` per consecutive run of the same kind | the site stores a list, Notion stores rows; more than 100 rows splits into several lists |
| `code` | `code` | language normalised (`plain text` → `text`, default `text`), capped at 50 000 characters |
| `image` | `image` | caption becomes `caption` and `alt`; a signed URL is reported (`expiring-image-url`) |
| `bookmark`, `embed`, `video`, `audio`, `file`, `pdf` | `paragraph` with a linked run | the reference stays readable and clickable (`link-block-flattened`) |
| `equation` | `paragraph` in `code` marks | the LaTeX source is kept verbatim (`equation-flattened`) |
| `callout`, `toggle` | `paragraph` | the site is flat; the text is kept (`callout-flattened`, `toggle-flattened`) |
| `to_do` | `paragraph` | the checkbox state has nowhere to live (`checkbox-state-dropped`) |
| `divider`, `column_list`, `column`, `synced_block` | *nothing* | pure layout, nothing lost, no issue — a synced block's content is read as its children (below) |
| `table`, `table_row` | *dropped* | a cell grid has no equivalent (`table-block-dropped`) |
| `child_page`, `child_database` | *dropped*, body not read | `unsupported-block` with the type and title (`child_page: <title>`); the sub-page is another document |
| `link_to_page`, `table_of_contents`, `breadcrumb`, anything newer | *dropped* | `unsupported-block` with the type name |

Child blocks of a container are appended *after* it, because the site's model is
flat; the caller passes the flattened list. The source (`collectBlocks`) walks
into every block with `has_children` **except** `child_page` and
`child_database`: their children are the body of a separate Notion page or
database, which Notion shows on its own page rather than inline, so reading them
would append another document after the work's ending. Toggles, callouts, quotes,
list items, toggleable headings, columns and synced blocks are walked — a
duplicate synced block answers with the original's blocks, exactly what Notion
renders inline; if the original is not shared with the integration the read
fails rather than importing the page without that passage. Works imported before
this rule may still end with a sub-page's text; a fresh dry run of the same page
offers an `update` that removes it.

Inline runs are built from each item's `plain_text`, not from `text.content`:
the write contract requires the concatenated runs to equal the block's `text`
exactly (`validateInlineRuns`), and `plain_text` is the string Notion shows for
text, mentions, equations and link previews alike — so the equality is
structural rather than a coincidence of this database.

Every produced block is run through `validateArticleBlocks([block], 1)` before it
leaves the mapping. A block the write contract would reject is dropped with
`invalid-block-dropped` instead of failing the whole page: one unsupported
construct must not cost the author a manuscript.

### 5.2 Direction: article → Notion

| Article block | Becomes |
| --- | --- |
| `paragraph` | `paragraph` |
| `heading` level 2 / 3 / 4 | `heading_1` / `heading_2` / `heading_3` |
| `quote` | `quote`, plus a `paragraph` for the attribution |
| `list` | consecutive `bulleted_list_item` / `numbered_list_item` |
| `code` | `code` with `language` |
| `image` | `image` of type `external` — the site's `/api/media/<uuid>` URLs are stable, so nothing expires on the way out |

Properties written back: `Page` (title), `Slug`, `Excerpt`, `Date`,
`Published`, `Tags`. Nothing else: the relations and `Rank` are the author's own
structure and are not reconstructed from a site that has no such concepts.

## 6. What is deliberately not carried

| Notion feature | Why not | Report code |
| --- | --- | --- |
| `FeaturedImage` | an article has no cover field; adding one is a contract change with a migration and two client releases | `featured-image-not-carried` |
| `Parent item` / `Sub-item` | the site has no hierarchy between works (ADR 0016 retired serials for the same reason) | `hierarchy-not-carried` |
| `Rank` | ordering is a property of a reading surface, not of a work | — |
| `to_do` state | a published work has no checkbox | `checkbox-state-dropped` |
| Table cell grids | no table block exists | `table-block-dropped` |
| A signed Notion image URL | it 403s within the hour; the bytes must be copied into media storage first | `expiring-image-url` |
| A work type its `Tags` do not imply | the import derives `workType` from the tags, and Notion has no property to hold it; a round trip would change it silently | `work-type-not-carried` |
| A `zh-TW` edition of a `zh-CN` work | a translated edition travels as one linked page, and the mapping reads that page as `en` | `translation-locale-not-carried` |

A page that ends up with **no** blocks is refused (`empty-body`) rather than
published with invented text.

## 7. Architecture

```
Notion API ──(client, user's own token)──► bundle {pages, blocks}
                                              │
                        POST /api/v1/imports/notion  (§10)
                                              │
                                   notion-interchange.ts          ← the only mapping
                                              │  draft  + issues
                                   normalizeArticleInput / validateArticleBlocks
                                              │
                              existing article services + persistence ports
                                              │
                        articles / article_translations / taxonomies
                                              │
                    existing REST reads ──► web (react-router) · Flutter
                                              │
              GET /api/v1/imports/notion/export  (§11)  ──► bundle ──► Notion
                                (same mapping, the other direction,
                                 with page ids from `external_content_links`)
```

1. **The mapping is pure and shared by both directions.** No HTTP, no database,
   no credentials, no ambient clock. Both directions are tested against each
   other, which is why a round trip is a unit test rather than an integration
   fiction.
2. **Import writes ordinary articles through the existing write contract.** An
   imported work is a row in `articles`, exactly like a hand-written one; there
   is no `imported` flag on any read path and no shadow table. That single
   decision is what satisfies "the web app and the Flutter client must show the
   imported data": both already read `contentBlocks`, `viewCount`, tags and
   translations, so neither needs a release to see it.
3. **No third-party token is stored.** A Notion integration token belongs to the
   user; storing it would make this API the custodian of a credential outside its
   own data. The client fetches from Notion and posts the bundle; the seed path in
   this repository does the same with a token from its own environment. The server
   only ever sees content.
4. **Idempotency is a link record, not a diff.** `external_content_links` holds
   one row per `(provider, page, locale)` → `(article_id, digest, owner)`; a
   re-import of an unchanged page is a no-op, and a changed one updates the same
   article instead of creating a second copy. The digest lives in the database, so
   a client's claim that it "already imported" something is never trusted
   ([ADR 0037](../architecture/decisions/0037-import-provenance.md)).
5. **Images are copied, not linked.** The import step fetches expiring URLs
   through the existing server-mediated upload path (ADR 0028) so the work does
   not depend on Notion's bucket staying reachable.

### Phasing

| Phase | Scope | State |
| --- | --- | --- |
| 0 | The pure mapping, both directions, with fixtures from the real database | **landed** |
| 1 | Seed: `scripts/notion-seed.ts` reads a bundle (a captured JSON file, or fetches it with a token from the environment) and creates/updates articles through the REST API for one author | **landed** (§9) |
| 2 | `POST /api/v1/imports/notion` (dry run + apply, per-page report), the link table (migration), signed-in users importing into their own account | **landed** (§10) |
| 3 | `GET /api/v1/imports/notion/export?slugs=` returning a Notion-shaped bundle; the authoring desk offers "export to Notion" and downloads it, or pushes it with their own token | **landed** (§11) |
| 4 | Import UI on the authoring desk, and an upload-by-token flow for the Flutter client | **landed** (§12) |

Phase 0 is what makes 1–4 cheap: every later phase is transport and storage
around a mapping that is already pinned by tests.

## 8. Worked example: 「墙壁」

Input (real payload): title `墙壁`, `Slug` = `墙壁`, `Date` = `2026-10-08`,
`Published` = true, `Tags` = [`诗歌`], `Excerpt` empty, four paragraph blocks of
which one is empty.

```jsonc
{
  "slug": "qiangbi",
  "locale": "zh-CN",
  "title": "墙壁",
  "summary": "",
  "workType": "poetry",
  "tags": ["诗歌"],
  "publish": true,
  "publishedAt": "2026-10-08T00:00:00.000Z",
  "contentBlocksVersion": 1,
  "contentBlocks": [ /* three paragraphs, in order */ ]
}
```

Issues: `slug-derived` (`墙壁 -> qiangbi`) and one `empty-block-dropped`. No
content is lost.

## 9. Running the seed (phase 1)

The seed exists so the mapping can be used *today*, on a real database, without
waiting for the REST surface. It is an operator command, it talks HTTP only, and
it writes through the same contract the writing desk uses — which is also why it
is the honest rehearsal for phase 2.

```bash
# 1. capture the database once (the token stays in this process's environment)
NOTION_TOKEN=secret_… pnpm notion:seed \
  --notion-database <database-id> --write-bundle notion-bundle.json

# 2. see exactly what would happen; nothing is written
pnpm notion:seed --bundle notion-bundle.json \
  --email author@example.com --password '…'

# 3. write it
pnpm notion:seed --bundle notion-bundle.json \
  --email author@example.com --password '…' --apply
```

| Option | Default | Meaning |
| --- | --- | --- |
| `--bundle <file>` | — | read a captured bundle |
| `--notion-database <id>` | `$NOTION_DATABASE_ID` | fetch the bundle with `$NOTION_TOKEN` |
| `--write-bundle <file>` | — | save what was fetched, so later runs need no token |
| `--api <url>` | `$API_BASE_URL` or `http://127.0.0.1:3000` | the instance to write into |
| `--email`, `--password` | `$NOTION_SEED_EMAIL`, `$NOTION_SEED_PASSWORD` | the author account (it must already exist, with a profile) |
| `--state <file>` | `.notion-seed-state.json` | what has been imported, by page id |
| `--apply` | off | without it the run is a dry run |
| `--json` | off | machine-readable report |

### What a run guarantees

- **Dry run is the default.** Without `--apply` the command issues **no request
  at all** — it cannot log in, cannot read tags, cannot write. The plan, the
  refusals and the loss report are printed exactly as they would be.
- **`Published: false` becomes a draft.** It is created unpublished: visible in
  the author's desk, invisible to readers, the same as a work saved there.
- **One work, one status, one instant.** In the real database the English page
  carries `Published: false` and no `Date` while its Chinese partner is
  published and dated. Publishing and the publication instant are properties of
  the *work*, so an edition inherits both — otherwise every run would re-date the
  translation from the clock and rewrite an untouched work.
- **Re-running is safe, in two independent ways.** Creates carry an
  `Idempotency-Key` of `notion-seed:<page id>`, which the API stores with the
  article (ADR 0019) — so a run that dies half-way cannot duplicate a page it
  already created. And the state file keeps a digest of what a *reader* sees, so
  an untouched page is a `skip`, an edited one is an update of the same article,
  and a page that was merely touched in Notion (a moved cursor, a recoloured
  block) is not a change at all.
- **Tags are reused, not duplicated.** The run lists existing tags and creates
  only the missing ones; a second 「诗歌」 would split every tag page in two.
- **Nothing is lost silently.** A page that cannot be an article (no title, no
  body) is *refused* with its issue codes; every block the site cannot carry is
  counted at the end.

### What it deliberately does not do

It does not delete, unpublish or move anything that vanished from the bundle: a
one-way first import must never be able to destroy work. It does not create the
author account (that is registration plus a profile), and it does not copy
Notion-hosted images — those URLs expire within the hour, so they are reported
(`expiring-image-url`, `featured-image-not-carried`) and re-hosting them belongs
with the media pipeline rather than a seed script.

### Where the guarantees are tested

`scripts/lib/notion-seed-run.test.ts` runs the real driver against a stub that
speaks the REST contract: a dry run issues zero requests; an apply logs in, lists
tags, creates one article per *work* (not per page) with the page's idempotency
key, `PUT`s the translation onto the work's id with `locale: "en"`, and writes
state that maps both pages to the same article; a second run with the same bundle
writes nothing; a blank page is refused with `empty-body`.
`scripts/lib/notion-client.test.ts` covers the fetcher (pagination of the query
and of a page's body, recursive children in order, one retry on `429`, and an
error that names the endpoint but never the token), and
`scripts/lib/notion-bundle.test.ts` covers grouping, digests and the plan.
The planner itself moved to `apps/api/src/application/notion-bundle.ts` in
phase 2, because the endpoint and the seed must answer "is this page already
imported?" the same way; `scripts/lib/notion-bundle.ts` re-exports it.

## 10. Importing through the API (phase 2)

`POST /api/v1/imports/notion` is the endpoint a signed-in author calls with a
bundle they fetched themselves. The full contract is in
`docs/api/openapi.json`; this section is the part a reader of the mapping needs.

```http
POST /api/v1/imports/notion
Authorization: Bearer <access token>
Content-Type: application/json

{ "bundle": { "version": 1, "database": {...}, "pages": [...] }, "apply": false }
```

**A dry run is the default.** Without `apply: true` nothing is written — no
works, no tags, no provenance rows — and `pages` is the plan: one line per page
with `action` (`create` / `update` / `skip` / `refused` / `failed`), the work's
`slug` and `articleId` when one exists, a one-line `detail`, and the mapping's
`issues`. A dry run is what an author should send first. It also returns `planToken`
and `planExpiresAt`: an authenticated snapshot of this actor, the exact selected
bundle/grouping, target work revision/existence, source links and create-key
recovery state. It writes no import data and costs nothing to repeat.

**Apply the preview, not a new unprotected plan.** Send the same selected `bundle`,
`apply: true`, and the unchanged `planToken` returned by the dry run. Plans expire
after 15 minutes. Missing, tampered, expired, changed-selection, wrong-account or
pre-cutover tokens return `409 IMPORT_PLAN_INVALID` before import writes. A work
or source link that changed after preview is `refused`, with a request to preview
again; unrelated works may still succeed. Comparison and the work's editions,
tags, media references and provenance writes share one database transaction.
An edition cannot conflict with its own primary's write. A failure rolls back
that whole work and its journal rows, not previously committed unrelated works.
`applied: true` therefore means apply was attempted, not that every page succeeded.
See [the version-protection design](../architecture/notion-import-version-protection.md)
for locking, signed-plan and cutover details.

**Re-importing is idempotent, and the memory is the server's.** Each applied
edition writes `external_content_links` (`provider = "notion"`,
`external_id = <page id>`, `locale`), holding the work it produced and a digest of
what a reader sees. The same bundle a second time answers `skip` for every page and
writes nothing; a changed page answers `update` and keeps the work's existing
address (an import never renames anything). The table is migration `0033`
(`0020` on SQLite); why it exists is
[ADR 0037](../architecture/decisions/0037-import-provenance.md).

**A work's translations arrive as one work.** Only an unambiguous `English`
relation groups two pages. `Parent item` and `Sub-item` express hierarchy, not
translations; pages are imported separately and the lost hierarchy is reported.
If an `English` target is missing or more than two pages form a translation group,
the affected pages are refused before writing. The report counts an added edition
as an `update`: one work, one article, one address.

**Page ownership is global across locales.** Every existing row for
`(provider, external_id)` shares one owner; changing locale cannot let another
account claim the page. PostgreSQL migration **0036** enforces this with a named
`btree_gist` exclusion; SQLite migration **0023** uses database INSERT/UPDATE
triggers, including for direct SQL and independent concurrent connections.
Same-owner multi-locale rows are valid, without relaxing the planner's existing
locale/grouping rules. A losing import is `refused` with an explicit "already
owned by another account" explanation, not raw SQL or a private owner's/work's
identity. The entire losing work, including new tags and journal captures, is
rolled back. Unrelated database failures remain `failed`. Upgrade prerequisites
and fail-fast historical conflict repair are documented in
[ADR 0037](../architecture/decisions/0037-import-provenance.md).

**Missing pages are not deleted or reassigned.** A page linked to another
account is refused (`this page is already imported into another account`) rather
than copied — a Notion page names one work in the world, regardless of locale.
A link whose work was
deleted is refused rather than recreated. A page that cannot become a work
(`empty-body`, `empty-title`) is refused with its issue codes while the rest of the
bundle still lands.

**Limits and refusals.** At most 200 pages per bundle (`400` beyond that), an 8 MiB
serialized bundle (`413`), up to 512 KiB for its plan token plus request-envelope
overhead, `application/json` only (`415`), a session (`401`), and a rate limit of
ten imports per ten minutes per account. Creates retain the author-scoped
`notion-seed:<page id>` create key. After an uncertain response, inspect the desk
and preview again: committed pages are not duplicated, while an obsolete plan
never silently becomes a new create or an overwrite.

**What it does not do.** It does not use a Notion token (the token stays with the
client, ADR 0036 decision 3), carry featured covers, hierarchy or `Rank`, or
delete work that vanished from the bundle. On apply it does fetch eligible signed
Notion image URLs from the bundle as described below; it never fetches images in a
dry run.

### Copying Notion-hosted images

Dry runs report `expiring-image-url` and do not fetch or upload images. On apply,
image blocks of type `file` are downloaded and passed through the ordinary media
service, so normal image type, size, dimension and normalization checks apply.
External image links are left alone. Covers (`FeaturedImage`) still have no home
in the article contract and are reported as `featured-image-not-carried`.

For SSRF safety only HTTPS URLs for `prod-files-secure.s3.amazonaws.com` and
`prod-files-secure.s3.us-west-2.amazonaws.com` are fetched; redirects, credentials,
custom ports and fragments are refused. A download has a four-second deadline,
an 8 MiB streamed byte limit and must advertise JPEG, PNG or WebP. Errors do not
include signed URLs. Each apply attempts at most eight distinct downloads; further
images are omitted and reported, and a later apply can continue.

If an image cannot be copied, the image is removed from that edition, its text
can still be written, and `image-copy-failed` gives the reason. If removing images
leaves no valid blocks, the article write fails instead of creating an empty work.
The provenance record is marked incomplete so another dry run offers an update;
a retry of the same bundle reuses successfully copied media from the incomplete
edition and retries missing images. If a signature refresh changes the bundle, the
plan remains an update: the API cannot know from a URL alone whether the bytes
changed. On apply it downloads and normalizes again, then reuses the old asset only
if it belongs to the author and both the normalized bytes and the stored object's
integrity match. Changed, missing or corrupt objects result in a new asset. This
saves duplicate media but is still an update, not a claimed skip. Conversely, an
identical bundle is still skipped without a network read; it cannot detect an object
whose bytes changed behind the very same URL. For a page with
more than eight images, reuse the exact bundle across retries while its URLs remain
valid: a changed signature resets the incomplete checkpoint, so a refreshed bundle
may need more than one attempt and can fail to finish under the per-request cap. Previously imported works still containing the
same temporary URLs are also offered an update. As with any import, an update can
replace edits that already existed when previewed; review the plan before
applying. Edits made after that preview are protected by the locked comparison.
If the source signature expires, obtain a fresh bundle and preview it before
retrying.

Media writes happen before the article write. A failed article write, an interrupted
request, or changing the bundle between retries can leave unreferenced media in the
library; they are not automatically deleted. A late version/provenance conflict
or write failure reports that the work was not written/was rolled back and warns
when prepared images may remain. The media library shows those unused assets and
allows the owner to remove them. A failed provenance write now rolls back the
article, all editions, newly created tags and journal rows too; it does not leave
a newly committed unlinked article.

For historical imports that already lack a provenance link, the author-scoped
create key finds the original work. The dry run offers an update and explicitly
warns that existing edits may be replaced; only an apply against that previewed
revision updates the work and saves its missing link. Deleted works are refused
until restored, and a translation linked to a different work or account blocks
recovery rather than being silently moved. Competing imports of the same source,
including different locales/accounts, serialize and the loser is refused before
any of its article/tag/link writes commit. Migrations 0036 PostgreSQL / 0023
SQLite additionally enforce the cross-locale owner invariant for bypassing SQL
and standalone link writers; only the exact ownership violation becomes a clear
refusal. This extends #305's atomic importer rather than restoring draft #303's
old non-atomic path.
A network timeout does not prove that nothing was written. The web proxy gives this route a longer default timeout, but
an explicitly configured `API_TIMEOUT_MS` still takes precedence. The seed script
remains separate and does not copy images.

### Where the guarantees are tested

- `apps/api/src/persistence/notion-page-ownership.integration.test.ts` — real
  independent SQLite/PostgreSQL full-import and direct-SQL races, INSERT/UPDATE
  invariants, legacy migration failure/repair/retry, narrow error mapping, eleven
  whole-work rollback stages per provider and HTTP owner-only orphan-media
  visibility/removal with shared references protected.
- `apps/api/src/application/notion-import.test.ts` — decisions against a stub: a
  dry run touches no writing service; an apply records owner and digest; the same
  bundle twice writes nothing at all; a changed page updates and keeps its address;
  an empty page is refused while the rest lands; another account's page is refused;
  a deleted work is refused; missing-link recovery is previewed and remains scoped
  to the owner; translations attach to one work; a malformed bundle and
  an oversized one are rejected before anything is read.
- `apps/api/src/transport/rest/imports.integration.test.ts` — real HTTP and a real
  database, on SQLite always and on PostgreSQL when `TEST_DATABASE_URL` is set: the
  `401`, the dry run writing nothing, the apply creating a work that **the public
  unauthenticated read** then serves (the same request the web and Flutter clients
  make), the idempotent second run, the update that keeps the slug, the refusal for
  a second account, and the `400`s.
- `apps/api/src/transport/rest/import-version-protection.integration.test.ts` —
  both providers reject stale/tampered/expired/wrong-actor/wrong-generation plans;
  revision and source-link changes cannot be overwritten, including changes
  during image preparation; independent connections serialize conditional writes
  and cross-locale source claims; multi-edition/tag/link and journal writes are
  atomic; real provider transfer invalidates old plans; leftover media can be
  removed. `e2e/notion-import.spec.ts` and `e2e/authoring.spec.ts` cover the browser
  confirmation, re-preview and retained-draft conflict behavior.
- `apps/api/src/persistence/persistence-adapter-contract.test.ts` — the link table
  behaves identically on both providers: one row per page edition, an upsert that
  replaces in place, and `getMyArticle` scoping (an id is not a permission).

## 11. Exporting through the API (phase 3)

`GET /api/v1/imports/notion/export?slugs=a,b` is the exchange in the other
direction: a signed-in author asks for their own works as a bundle they can push
into their Notion database with their own token (ADR 0036 decision 3 — this API
never holds a Notion credential). The full contract is in
`docs/api/openapi.json`; this section is the part a reader of the mapping needs.

```http
GET /api/v1/imports/notion/export?slugs=qiangbi,cai-diao
Authorization: Bearer <access token>
```

```jsonc
{
  "data": {
    "bundle": { "version": 1, "database": { "id": "", "title": "no-wave export" }, "pages": [ /* … */ ] },
    "report": {
      "works": [{
        "slug": "qiangbi", "articleId": "…", "title": "墙壁", "primaryLocale": "zh-CN",
        "pages": [{ "locale": "zh-CN", "pageId": "01331af0-…", "provenance": "notion", "articleId": "…", "issues": [] }],
        "issues": []
      }],
      "missing": [],
      "summary": { "works": 1, "pages": 1, "missing": 0 }
    }
  }
}
```

`data.bundle` is exactly the object `POST /api/v1/imports/notion` accepts as its
`bundle`; write it to a file and it is a bundle. `data.report` is what the bundle
could not say about itself.

**A work is one address, up to two pages.** The primary page is the edition in
this site's own order of preference (`zh-CN`, then `zh-TW`, then `en`), so the
same work exports the same way twice. An `en` edition travels as a second page
paired by the `English` relation on **both** sides — the shape the author's own
database already has. Every page carries the work's address in `Slug`: the site
has one address per work, and an export does not invent a second one.

**Page ids are provenance.** An edition that was imported from Notion carries the
page id it came from (`provenance: "notion"`), read back through
`external_content_links`; writing to that id updates the page the author already
has. An edition written here carries `site:<articleId>:<locale>`
(`provenance: "site"`) — not an invented Notion id, so repeat exports are
byte-identical and a client can diff them.

**Nothing is written.** No provenance row, no work, no tag: exporting twice returns
the same bundle, and the desk can offer a download on a draft. `slugs` is capped
at 50 works per request and the resulting bundle never exceeds the 200 pages an
import accepts.

**What Notion cannot hold is reported, not guessed.** A `zh-TW` edition is
`translation-locale-not-carried` (the mapping has one translation language); a
work type its own `Tags` do not imply is `work-type-not-carried`, because an
import derives `workType` from the tags and would come back with a different one.
A requested slug that is not one of the caller's live works — including a work in
the recycle bin — is listed in `missing` rather than failing the request, and a
work of another account is indistinguishable from one that does not exist.

**One round-trip seam, stated.** Publishing here stamps this site's own instant,
and an import's digest covers the page's `Date`. Re-importing a freshly exported
bundle is therefore one `update` with identical content, then `skip` — the memory
converges, and nothing about the work drifts (§4).

### Where the guarantees are tested

- `apps/api/src/application/notion-export.test.ts` — decisions against a stub: one
  address and one page per edition paired by the relation; provenance ids reused
  and `site:` ids stable across two exports; a `zh-TW` edition reported instead of
  written as `en`; a work type its tags do not imply reported; unknown and
  other-account slugs listed as `missing`; tags read once per language; the
  request bounds refused before anything is read; and an exported page fed back
  through `parseNotionBundle` and the mapping to prove the digest is unchanged.
- `apps/api/src/transport/rest/imports.integration.test.ts` — real HTTP and a real
  database on both providers: the `401`, the `400`s for a missing or malformed
  `slugs`, an unknown slug answering `200` with `missing`, an imported work
  exported with **the page id it came from** and its properties, blocks and tags
  intact, an export written nowhere, the exported bundle re-imported onto the same
  work (`update`, then `skip`), a hand-written work exported with a `site:` id, and
  another account's export of the same address coming back empty.
- `packages/web-http/test/authoring.test.ts` — the desk's download: the answer is
  an attachment, a malformed or oversized `slugs` is refused locally, and a failed
  export keeps the API's error instead of saving it as a file.

## 12. Importing from the desk, and from any client (phase 4)

Phases 1–3 made the mapping usable by an operator, by a script and by a
downloaded file. Phase 4 puts it in front of the author: `/write/notion` in the
web application, and the same endpoint for a client that would rather be a phone
than a browser.

### 12.1 The authoring desk

`/write/notion` is a private, unindexed page under `/write`, gated the way the
media library is: the loader answers from the session marker — a cookie that
carries no credential — and either renders the shell or redirects to
`/sign-in?next=%2Fwrite%2Fnotion`. Everything that decides anything happens
after hydration, against data the API verifies.

The page asks the server twice, and that is the whole design:

1. **Choosing a file is a dry run.** The browser reads the file, checks only what
   makes "this is not a bundle" certain — it parses as JSON, it is an object, it
   has `version: 1`, a `pages` array of pages with an `id`, a
   `properties` object and a `blocks` array, within 8 MB and 200 pages — and then
   `POST /api/authoring/notion-import` with `{ bundle }`. Nothing is written; the
   answer is the plan.
2. **The plan is shown, page by page.** Each line is the API's: the action
   (`create` / `update` / `skip` / `refused` / `failed`), the title, the locale,
   the mapping's issue codes, and — for a page that was refused or failed — the
   server's reason. The codes and the reasons are printed as the server wrote
   them; only the action names are translated, because they are the page's own
   vocabulary. A summary line counts them, and a second line groups the issue
   codes, because "what did not come across" is a question about kinds, not about
   pages.
3. **Only the plan that would write offers the write.** The confirm button says
   how many works it would touch and exists only while the plan has a `create` or
   an `update`. A second import of an unchanged database therefore has no button
   at all: the server has already said there is nothing to do, and a button that
   would write nothing is a button that teaches the author to distrust the page.
   Pressing it sends the same bundle with `apply: true`, and the report that comes
   back is the same list saying what happened — after which the button is gone.

The proxy in front of the endpoint adds nothing to the answer and refuses only
things a request can be wrong about before the API sees it: `POST` only (`405`),
same origin (`403`), `application/json` only (`415`), at most 8 MB (`413`), JSON
that parses to an object with a `bundle` object (`400`), and `apply` present only
as a boolean — `"true"` is a `400` rather than a write. The bundle is forwarded
as the text that arrived: re-serialising it would rewrite a document the author
chose, and the digest that decides "unchanged" is computed over what the server
received. Every refusal the proxy makes is marked
`x-authoring-not-forwarded: 1`; an upstream refusal is not.

### 12.2 Upload by token, from a client (Flutter and anything else)

A client does exactly what the seed does, with the user's own token in the
client's own process (ADR 0036 decision 3 — this API never stores a Notion
credential), and then exactly what the desk does:

```text
1. client → api.notion.com   POST /v1/databases/<id>/query   (Authorization: Bearer <notion token>)
2. client → api.notion.com   GET  /v1/blocks/<page id>/children
3. client                    build { "version": 1, "database": {…}, "pages": […] }
4. client → this API         POST /api/v1/imports/notion  { "bundle": … }            ← dry run, writes nothing
5. client                    show pages[].action / issues / detail to the user
6. client → this API         POST /api/v1/imports/notion  { "bundle": …, "apply": true, "planToken": <step 4 token> }
7. client                    show the report again; it is now what happened
```

`scripts/lib/notion-bundle.ts` and `scripts/notion-seed.ts` are the reference
implementation of steps 1–3 in TypeScript; the shape they produce is the shape
steps 4 and 6 accept, and it is the shape §11 exports.

The bounds are the endpoint's (§10), and they are the ones a client has to plan
for:

| Bound | Value | What a client does about it |
| --- | --- | --- |
| body | 8 MB of JSON | split by **work**, not by page — see below |
| pages | 200 per bundle | same split |
| blocks per page | 200 (`maxBlocks`) | the rest are dropped, and the page says `block-limit-reached` |
| rate | 10 imports / 10 minutes / account | batch, and show the wait rather than retrying in a loop |

**Split a work's pages together.** `English` relations group pages *within one
bundle*. If a selected page points to a missing English page, it is refused. A page
that has no outgoing relation may still be imported on its own; if it already has
a provenance link in a different locale, a later import is refused rather than
creating a duplicate. Include both editions when importing a linked pair. Parent
and sub-item relations do not group translations.

**Retrying is safe, and cheap.** A dry run is a pure read. An applied import
records the page id, the work and a digest, so repeating a batch — because a
connection died, or because the client resumed it — writes nothing for the pages
that already landed and continues with the rest. Creates also carry
`Idempotency-Key: notion-seed:<page id>`, so even a request that dies mid-way
leaves no duplicate behind.

**Nothing is deleted, unpublished or rewritten elsewhere.** An import writes only
the caller's own works, never renames an existing one, and never publishes
something the bundle did not mark published. A client that mirrors a Notion
database should treat the report as the record of what happened, not as a plan it
still has to apply itself.

### Where the guarantees are tested

- `packages/web-ui/src/lib/notion-import.test.ts` — the page's decisions without
  a browser: which files are refused and with which sentence (not JSON, not an
  object, a saved API response, no `version`, too many pages, a page missing its
  id or `properties` or `blocks`, named by index), both ceilings refused and both
  exactly at the limit accepted, an empty `pages` array accepted because the API
  answers it with an empty plan, a report read as written with unreadable pages
  dropped, the summary preferring the API's count, a plan that would write
  offering the write and one that would not not offering it, an applied report
  never offering the write again, and issue codes counted by kind.
- `packages/web-http/test/authoring.test.ts` — the proxy: the dry run is the
  default and the bundle is forwarded byte for byte, `apply` must be a boolean,
  the method, origin, content type, length and shape checks that never reach the
  network, and an upstream refusal passed through unmarked.
- `apps/web-rr/test/client-bundle.test.ts` — the panel is in the emitted client
  bundle, so the page hydrates instead of rendering a picker that does nothing.
- `e2e/notion-import.spec.ts` — the journey in a browser: an anonymous visitor
  pointed back after signing in, the desk linking here, a chosen file showing the
  plan before anything is written, the confirm button writing it once, the work
  appearing in the desk, and the same file imported twice writing nothing the
  second time.

## Markdown and ZIP export files in the desk

The authoring page also accepts multiple `.md` files or ZIP files, converting
locally in the browser to the existing bundle. The author selects pages before
the dry run and explicit confirmation; only selected pages are submitted. Changing
the selection invalidates the plan, so it must be previewed again. A single JSON bundle remains supported. This is a desk
feature, not a new multipart API: `POST /api/v1/imports/notion` still receives
JSON. No Notion token is needed.

A Markdown file needs an initial `# Title` and a body. Notion's 32-digit page ID
at the end of the filename is used as its original page identity. For a file
without that ID, identity is its filename scoped to the signed-in author;
renaming it is a new import, and two selected files with the same identity are
refused. Re-import can update a previously imported article, so review the plan.
Notion page IDs remain globally owned across accounts as before. `English`
links associate a pair only when both pages are selected. A selected page with a
missing English target is refused; parent/sub-item links do not merge articles.
Standalone pages use the existing `zh-CN` default; linked English pages use `en`.
If existing provenance disagrees with the new grouping or locale, the affected
work is refused. See the [read-only provenance audit](../architecture/notion-import-provenance-audit.md)
for historical imports; no existing links are automatically changed.

The leading Notion metadata recognizes `Published`, `Date`, `Slug`, `Excerpt`,
`Tags`, `FeaturedImage`, `English`, `Parent item` and `Rank`. Missing Published
means draft; absent slug, tags and work type use the existing importer defaults.
Published pages with no source date use the publication clock; that generated
time is not part of the source digest. Date affects planning but the existing
article writer stamps the actual publication time, rather than backdating it.
`Rank` has no matching article field and is ignored without blocking import.
Unrecognized properties and cover images have no matching article field and are
reported. Basic Markdown paragraphs, headings, links, marks, lists,
quotes and code are converted; unsupported structures are flattened and reported.

ZIP parsing is bounded to 8 MiB compressed and 8 MiB extracted Markdown, 200
Markdown files and 2000 total entries; the files chosen at once must total 8 MiB
or less. The converted bundle is no longer required to fit one request: see
*Automatic batches* below. ZIP64, split or incomplete archives are rejected. Files are never extracted
to disk. Local images are **omitted with a warning** unless the author uploads them
first (see *Local images in a ZIP export* below); an image inside a paragraph is
always omitted with a warning. External images remain links; recognized
Notion-hosted URLs go through the existing bounded image copy path, and signed
URLs on other hosts are removed. Per-request limits and retry caveats in the
image section above still apply. The conversion warnings should be reviewed
before confirming, especially for unsupported Markdown and missing relationships.

### Database CSV beside the Markdown

Notion's Markdown export writes most database properties only to the
database's CSV (`作品库.csv` and/or `作品库_all.csv`). The desk reads `.csv`
files chosen with the Markdown, or inside the ZIP (they count toward the same
entry and byte limits; they are not pages). When both names exist for a
table, `_all` wins. A page is matched to a row first by its `# Title`, then by
its filename without the 32-digit ID, both trimmed; a title shared by several
rows is ambiguous and fills nothing. Columns are matched case-insensitively,
in English or Chinese (`Date`/`日期`, `Excerpt`/`摘要`, `FeaturedImage`/`封面`,
`Published`/`发布`, `Slug`, `Tags`/`标签`).

CSV values **only fill properties the Markdown left empty**; they never
overwrite. `Published` is read as a checkbox only when every value in the
column is boolean (`yes/no`, `true/false`, `是/否`, `Y/N`, `__YES__/__NO__`).
Dates accept `2026-10-08`, `2026/10/08`, `2026.10.08`, `2026年10月8日`,
`October 8, 2026` and `September 1 2026`, all as UTC midnight like
`notionDateToInstant`; ambiguous forms such as `10/08/2026` are left empty and
reported, and a date range keeps its start (reported). Tags split on `,`, `，` and `、`. `Rank`/`排序` is ignored; other
columns are reported. Every page gets a visible conversion warning saying
which columns were filled, or that no row matched, so the author can check
before the dry run. A page with no `# Title` falls back to its filename with a
warning; only a page with neither is skipped (and reported). A CSV cover that
is a file inside the export is reported, not imported, and a CSV
`FeaturedImage` URL is still not carried (`featured-image-not-carried`).

### Local images in a ZIP export

A Notion export keeps each image beside its page and links it relatively. The desk
lists the ZIP's image entries from its central directory (nothing is decompressed)
and resolves each standalone image link against the page's folder; a link with a
scheme, an absolute path or `..` above the archive's root is not a local image.
Before the dry run, a section 「导出包里的本地图片」 offers one button,
「上传 N 张本地图片到你的媒体库」. **Nothing is uploaded unless it is clicked**, and
an image that is not uploaded is removed and named exactly as before.

A click sends each image through the editor's own upload
(`POST /api/authoring/media` → `POST /api/v1/me/media`): the proxy's Origin check,
JPEG/PNG/WebP allow-list and 8 MiB ceiling, and the server's re-encoding, all
apply unchanged. The content type sent is the one the bytes really are. Each image
is inflated only when it is about to be sent, and cut off at 8 MiB whatever its
header claims. Files that are GIF, SVG, HEIC and so on, larger than 8 MiB, missing
from the ZIP, or not really an accepted image are listed with their reason and cost
no request.

The media limit (10 uploads per author and 20 per IP per hour) is not raised, so
**one click sends at most 10 upload requests** and stops at the first `429`, `401` or
`503` without waiting. The rest are counted ("还有 N 张没有上传"), and the author can
import what is there now and later choose the same export again. An image the server
refused is not offered again in that session.

An upload writes no article. The uploaded images appear in the author's media library,
where they can be deleted while unused. The desk converts the export again with
`{type: "external", external: {url: "/api/media/<id>"}}` blocks, the site's own stable
addresses: the importer already accepts those, and neither copies nor counts them as
Notion images. It keeps the selection and discards any plan, because the plan token is
bound to the bundle.

**A later visit does not upload the same image twice.** For each image the browser
stores, in `localStorage` (`nw:notion-zip-image-uploads:v1`, at most 2000 entries), a
SHA-256 of its path, CRC-32 and size mapped to the address it got. No names or titles
are kept. A remembered address is reused only after it is found in the signed-in
author's own library (`GET /api/authoring/media`, up to 10 pages of 60). A deleted
asset is therefore uploaded again, and another account in the same browser never
borrows one. When storage is unavailable, uploads still work without reuse.

This applies to ZIP files. Loose `.md` files chosen without their images still have
their local images removed with a warning.

Tested by `packages/web-ui/src/lib/notion-zip-images.test.ts` (link resolution, the
central directory listing, inflating only what is wanted, the 8 MiB cut-off, type
sniffing, 10 per click, stopping at 429/401/503, reuse only when the library still has
the asset, fingerprints with no names) and `e2e/notion-zip-images.spec.ts` (media and
import mocked: nothing before the click, ten then two, a plan discarded by the upload,
dry run and confirm carrying the addresses, a 429 stopping at once, and a reload
reusing the library).

### Selecting pages

Every page is selected by default. The author can search titles, and select
all, clear or invert the rows currently shown. After a dry run the list can be
filtered to works that would be created or updated, or that need attention
(refused, failed, or with issue codes), and one click selects only the works
that would be created or updated. Each row shows the planned action, locale,
issue codes and, for an update, the target article. Changing the selection
discards the plan; the next dry run is the only thing that produces a new one.
The plan or result can be downloaded as a CSV (UTF-8 with BOM; cells that
start like a formula are prefixed with `'`).

Choosing a page whose `English` counterpart is in the same export selects that
counterpart too, transitively, and says which pages were added. Only newly
chosen pages pull their counterparts in: a counterpart the author unchecks on
purpose stays unchecked, the row says the work will be refused, and the API's
`missing-translation-page` refusal is unchanged. A page whose counterpart is
not in the export at all is marked before anything is sent, with a hint to
export with subpages.

### Automatic batches

When the selection would not fit one request — 8 MiB of serialized JSON, 200
pages, or 8 distinct Notion-hosted images — the desk splits it into several
`POST /api/v1/imports/notion` requests. Pages are packed in source order, and
pages linked by `English` always travel in the same batch, so the per-request
translation check sees both sides. A single work with more than 8 Notion
images goes alone (the API copies the first 8 and reports the rest, as for
any request); a work too large for any request is left out with a visible
note.

Every batch is dry-run first and the reports are merged into one table with a
single confirmation (“确认导入（写入 N 件作品，分 M 批）”). Each batch keeps its
own plan token: confirmation applies each batch with its own token and
idempotency key, exactly as a single import does, and nothing is written
before that click. If a plan expires (`IMPORT_PLAN_INVALID`), that batch is
dry-run once again and must be confirmed again. A `429` is waited out using
the server's `Retry-After` (1–900 s, 30 s when absent; at most 6 waits per
request) with a visible countdown. Any other failure leaves that batch
unwritten — it is never retried blindly — while the remaining batches
continue; the merged report names the failed batch, and the headline says
when only some batches were written. The author can stop the remaining
batches at any time.

There is no fixed cap on the number of batches. Every dry run and every apply
counts toward the import rate limits (10 per author and 20 per IP per 10
minutes), so a large selection can take several minutes of automatic waiting.

## Pulling straight from Notion with a pasted token (ADR 0052)

The desk's default tab, 连接 Notion 直接拉取, skips the export step. The author
pastes a Notion token and the database link. The desk recommends a **personal
access token** (created at `notion.so/developers/tokens` once Developer Mode is
on): it reads with the author's own permissions, so nothing has to be added to the
database, and it can be given a short expiry and revoked right after the import.
Some workspaces let only owners create one. The fallback is an **internal
integration**: create it, add it to the database under 「… → 连接」, and paste its
secret. Either way the token is opaque to us. Both server and browser check only
that it is 20–500 characters of the RFC 6750 bearer-token alphabet (no spaces, no
control characters, no pasted link). They do not check the `ntn_` / `secret_`
prefix, because Notion does not promise a stable token format.
Notion's API sends no CORS headers, so the browser cannot call it itself. The
token therefore passes through our API, one request at a time, and is never kept.
[ADR 0052](../architecture/decisions/0052-server-side-notion-pull-without-storing-tokens.md)
amends ADR 0036 decision 3 for exactly this endpoint.

What the author does, and what each step sends:

1. **连接并读取条目** sends `POST /api/authoring/notion-fetch` with
   `{ token, mode: "rows", source }`. The answer is the rows' properties only, up
   to 1000 per request, with a `cursor` to continue. The desk shows them in the
   usual selection list: all selected by default, English partners checked
   automatically. Above 2000 rows the desk stops listing and says so.
2. **试跑所选文章** first reads the blocks of the selected pages that have not been
   read yet, with `{ token, mode: "pages", pageIds }` (at most 200 ids per request).
   The server reads in order until about 45 s or 6 MiB and lists what it finished in
   `done`. The desk sends the rest in the next request, so the server keeps no
   continuation. Deselected pages are never read, and a second dry run does not read
   the same pages again. The finished bundle then goes through the same automatic
   batches, merged plan and single confirm as an uploaded file. Nothing is written
   before 确认导入.
3. A page the server could not carry is unchecked and named above the plan, with
   its reason. The reasons are `too-many-blocks` (over 2000), `page-too-large` (over
   6 MiB), `page-unavailable` (not visible to the token, or deleted), `fetch-timeout` and
   `fetch-failed`. The last two are tried again on the next dry run. A page is never
   imported with part of its body.

The token is a field of the request body and nothing else. It is the
`Authorization` header of the outgoing Notion calls, then discarded with the
request. It is not stored in the database, a file, a log line, an error message
or a response, and Notion's own error text is never forwarded either. In the
browser it lives in the page's memory: the field is `type="password"`,
`autocomplete="off"`, nothing goes to `localStorage`, `sessionStorage` or the URL,
and a reload clears it. Only `notion-fetch` ever receives it; the import requests
carry the bundle and nothing else.

Outgoing calls go only to `https://api.notion.com/v1/`. The server makes three
read-only calls (`GET databases/{id}`, `POST data_sources/{id}/query`,
`GET blocks/{id}/children`) with server-built URLs, no redirects, 15 s and 4 MiB
per call, at least 340 ms apart, and a fixed `Notion-Version`. A Notion
`Retry-After` of up to 10 s is waited out inside the request. A longer one ends the
slice: with a 200 and `retryAfterSeconds` when some pages were finished, or a 429
when none were. The desk waits either out with a visible countdown, at most six
times per pull, and can be stopped.

| Answer | When |
|---|---|
| `400 BAD_USER_INPUT` | malformed request; the message names the field, never its value |
| `401` | no session |
| `409 NOTION_FETCH_DISABLED` | the instance runs with `NOTION_FETCH_ENABLED=false` (default on) |
| `422 NOTION_TOKEN_INVALID` | Notion did not accept the token (incomplete, expired or revoked) |
| `422 NOTION_NOT_SHARED` | the token cannot see the database (an internal integration not added under 连接, or a page the author cannot open), or the link is wrong |
| `429 NOTION_RATE_LIMITED` / `429` | Notion's rate limit, or ours: 60 per author and 120 per IP per 10 minutes, separate from the import's 10/20 |
| `502 NOTION_UNAVAILABLE` | Notion failed, timed out or answered too much |
| `503 NOTION_FETCH_BUSY` | more than 8 pulls in this process, or 2 for this author, are in flight (`Retry-After: 5`) |

Deployments must allow outbound `api.notion.com:443` from the API. Turning the
pull off leaves the upload tab working as before.

The command-line seed (§9) uses the same reading code
(`apps/api/src/infrastructure/notion-source.ts`). Since this change, a page over its
block limit fails the run instead of being silently cut short.

### Where the guarantees are tested

- `apps/api/src/infrastructure/notion-source.test.ts`: the outgoing calls' URLs and
  headers, no redirects, the byte cap, pacing and 429 handling, and the block limit
  failing instead of truncating.
- `apps/api/src/application/notion-fetch.test.ts`: link and id parsing, token
  shape, the time and byte budgets, `done` and issue codes, the error mapping, and
  messages that never repeat the request.
- `apps/api/src/transport/rest/notion-fetch.integration.test.ts`: over HTTP with
  Notion stubbed, rows and pages, every refusal's status and code, Retry-After,
  the session and flag checks, the separate rate limit and the concurrency cap.
  The responses, the API's log lines and anything the process prints are captured,
  and none contains the token or Notion's error text.
- `packages/web-http/test/authoring-notion-fetch.test.ts`: the proxy forwards
  byte for byte with a 90 s budget, keeps Retry-After, refuses non-pulls before
  the network, and never echoes the token.
- `packages/web-ui/src/lib/notion-fetch.test.ts`: the desk's loop, which follows
  cursors and `done`, waits a bounded number of times, never loops on an answer
  without progress, never drops a page silently, and words every failure without
  the token.
- `e2e/notion-fetch.spec.ts` (both endpoints mocked, Notion never contacted):
  connect, uncheck one, dry run reading only the selected pages, confirm. Also: a
  malformed token never sent, the refusal sentences, a 429 waited out, an oversized
  page unchecked with its reason, no token in any import request or in storage,
  and an empty field after a reload.

## Authorizing with Notion instead of pasting a token (ADR 0053, optional)

When the API has `NOTION_OAUTH_CLIENT_ID`, `NOTION_OAUTH_CLIENT_SECRET` and
`NOTION_OAUTH_REDIRECT_URI` (an https URL whose path is
`/write/notion/oauth/callback`), the pull tab also offers 用 Notion 授权. Without
them nothing changes: `GET /api/authoring/notion-oauth` answers
`{ data: { enabled: false } }` and the button is not shown.

1. The desk opens a blank same-origin popup on the click, cuts its `opener`, and asks
   `POST /api/authoring/notion-oauth/start` for Notion's authorize URL
   (`owner=user`, the configured `redirect_uri`, and a `state`). The state is an
   HMAC over the author, an expiry ten minutes out and a random nonce. Nothing
   about it is stored.
2. In Notion's page the author selects the database, or a page above it, and
   approves. Notion redirects the popup to `/write/notion/oauth/callback`. That page
   removes `code` and `state` from its address bar before doing anything else. It
   is `no-store` and `Referrer-Policy: no-referrer`, and the web server logs paths
   without query strings.
3. The callback sends `{ code, state }` to
   `POST /api/authoring/notion-oauth/exchange`. The API accepts the state only for
   the same signed-in author, before it expires, and only once. It then redeems the
   code at `POST https://api.notion.com/v1/oauth/token` with HTTP Basic client
   credentials. The answer is `{ data: { accessToken, workspaceName } }`. Notion's
   refresh token is never read out of its response.
4. The callback posts the result on a `BroadcastChannel` named after the state, then
   closes. The desk takes the first well-formed message on that channel only. It puts
   the token where a pasted one goes and, if a database link is filled in, connects.
   From here everything is the pasted-token flow above.

| Answer | When |
| --- | --- |
| `409 NOTION_OAUTH_DISABLED` | OAuth is not configured, or pulling is off |
| `422 NOTION_OAUTH_STATE_INVALID` | the state expired, was used, was forged or belongs to another author |
| `422 NOTION_OAUTH_CODE_INVALID` | Notion refused the code (`invalid_grant`) |
| `502 NOTION_OAUTH_MISCONFIGURED` | Notion refused the client id/secret |
| `502 NOTION_UNAVAILABLE` | Notion failed, timed out, or returned no usable token |
| `429` | 10 per author and 20 per IP per 10 minutes, separately for start and exchange |

Nothing is persisted. The access token lives in the desk's memory like a pasted one.
To revoke access, the author removes the connection in Notion's settings.

## Filling a missing Date from the creation date (desk, optional)

A published page without a `Date` is dated at the moment of the import (§4), so a
database written over years can arrive as if every work appeared today. The desk
offers one checkbox before the dry run, 「用 Notion 创建日期补上缺失的 Date」,
**unchecked by default**. It is shown only when creation dates are known:

- **Pull:** Notion returns `created_time` with every row. The fetch endpoint passes
  it through as `rows[].createdTime` (an ISO instant; anything else is dropped). It
  is metadata beside the bundle and is never put into one.
- **Upload:** a database CSV column named `Created`, `Created time`, `Created at`,
  `创建时间`, `创建日期` or `创建于` (Notion's 「创建时间」 property). It fills no
  property by itself and is not reported as an unknown column.

When checked, the desk sets `Date` to the creation day for each selected page that
is **published** (`Published` checked) and whose `Date` is **absent or empty**. It
never replaces a `Date`, even one of another type, and never dates a draft: a draft
has no publication date to be wrong. A Markdown `Date:` that was written but cannot
be read is reported as before and is not filled. The day is the one the author saw
in Notion: an API instant is read on the browser's calendar, and a CSV cell already
prints the exporter's local time, so its date part is taken as written. It is stored
as UTC midnight, like every other calendar date here.

The change is made only to what the dry run sends; the selection in memory keeps the
author's properties, so unchecking the box and running again undoes it. Switching
the box discards the current plan. The dry run lists every page it filled with its
day, and each such report row says 「Date 为空，已用创建日期补为 YYYY-MM-DD」. The
server sees an ordinary `Date`: nothing in the import API, its digest or its
rejection rules changes, and the plan token binds the filled bundle like any other.

Tested by `packages/web-ui/src/lib/notion-created-date.test.ts` (day parsing in
several timezones; only empty, published pages filled; input unchanged),
`notion-markdown.test.ts` and `notion-fetch.test.ts` (the column and `createdTime`
kept beside, not inside, the bundle), `apps/api/src/application/notion-fetch.test.ts`
(`created_time` passed through only when it is an instant) and
`e2e/notion-date-backfill.spec.ts` (both endpoints mocked: off by default, on fills
one page and names it, the confirm writes the planned bundle, unchecking undoes it).
