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
| `locale` | caller's `locale` option | default `zh-CN`; an English edition is imported with `locale: "en"` |
| `publish` | `Published` | `options.publish` overrides it |
| `publishedAt` | `Date` | UTC; a published page with no `Date` uses the injected clock |
| `tags` | `Tags` | names trimmed, empties dropped |
| `workType` | `Tags` → `workTypeByTag` table | `诗歌→poetry`, `小说→novel`, `散文→essay`, `评论→criticism`, `文学批评→literary_criticism`, `非虚构→nonfiction`, `其他→other`; anything else is `other` with `work-type-fallback` |
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
| `divider`, `column_list`, `column` | *nothing* | pure layout, nothing lost, no issue |
| `table`, `table_row` | *dropped* | a cell grid has no equivalent (`table-block-dropped`) |
| `child_page`, `child_database`, `link_to_page`, `table_of_contents`, `breadcrumb`, `synced_block`, anything newer | *dropped* | `unsupported-block` with the type name |

Child blocks of a container are appended *after* it, because the site's model is
flat; the caller passes the flattened list.

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

**Missing pages are not deleted or reassigned.** A page linked to another
account is refused (`this page is already imported into another account`) rather
than copied — a Notion page names one work in the world. A link whose work was
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
any of its article/tag/link writes commit. This workflow is not a database-wide
cross-locale ownership constraint: bypassing SQL and standalone link writers are
still the separate hardening work in #270, not a completed promise from draft #303.
A network timeout does not prove that nothing was written. The web proxy gives this route a longer default timeout, but
an explicitly configured `API_TIMEOUT_MS` still takes precedence. The seed script
remains separate and does not copy images.

### Where the guarantees are tested

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
6. client → this API         POST /api/v1/imports/notion  { "bundle": …, "apply": true }
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
Markdown files and 2000 total entries. A request after conversion must also fit
8 MiB. ZIP64, split or incomplete archives are rejected. Files are never extracted
to disk. Local or inline images are **omitted with a warning**, even when present
in the ZIP; they are not yet uploaded. External images remain links; recognized
Notion-hosted URLs go through the existing bounded image copy path, and signed
URLs on other hosts are removed. Per-request limits and retry caveats in the
image section above still apply. The conversion warnings should be reviewed
before confirming, especially for unsupported Markdown and missing relationships.
