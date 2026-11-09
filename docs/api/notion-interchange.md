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
| `Parent item` / `Sub-item` | the site has no hierarchy between works (ADR 0016 retired serials for the same reason) | `hierarchy-not-carried` (planned with the import endpoint) |
| `Rank` | ordering is a property of a reading surface, not of a work | — |
| `to_do` state | a published work has no checkbox | `checkbox-state-dropped` |
| Table cell grids | no table block exists | `table-block-dropped` |
| A signed Notion image URL | it 403s within the hour; the bytes must be copied into media storage first | `expiring-image-url` |

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
| 3 | `GET /api/v1/imports/notion/export?slugs=` returning a Notion-shaped bundle; the authoring desk offers "export to Notion" and downloads it, or pushes it with their own token | next |
| 4 | Import UI on the authoring desk, and an upload-by-token flow for the Flutter client | later |

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
`issues`. A dry run is what an author should send first, and it is a pure read, so
it costs nothing to repeat.

**Re-importing is idempotent, and the memory is the server's.** Each applied
edition writes `external_content_links` (`provider = "notion"`,
`external_id = <page id>`, `locale`), holding the work it produced and a digest of
what a reader sees. The same bundle a second time answers `skip` for every page and
writes nothing; a changed page answers `update` and keeps the work's existing
address (an import never renames anything). The table is migration `0033`
(`0020` on SQLite); why it exists is
[ADR 0037](../architecture/decisions/0037-import-provenance.md).

**A work's translations arrive as one work.** `English` and `Parent item`
relations group pages before anything is written, so the primary page creates the
article and the other editions are written onto it in their own locale. The report
counts an added edition as an `update`: one work, one article, one address.

**Nothing is deleted, unpublished or claimed twice.** A page linked to another
account is refused (`this page is already imported into another account`) rather
than copied — a Notion page names one work in the world. A link whose work was
deleted is refused rather than recreated. A page that cannot become a work
(`empty-body`, `empty-title`) is refused with its issue codes while the rest of the
bundle still lands.

**Limits and refusals.** At most 200 pages per bundle (`400` beyond that), an 8 MB
JSON body (`413`), `application/json` only (`415`), a session (`401`), and a write
rate limit of ten imports per ten minutes per account. Creates still carry
`Idempotency-Key: notion-seed:<page id>` so a request that dies mid-way can be
retried without duplicating what it already wrote.

**What it does not do.** It does not fetch anything from Notion (the token stays
with the client, ADR 0036 decision 3), copy images (`expiring-image-url`,
`featured-image-not-carried`), carry hierarchy or `Rank`, or delete work that
vanished from the bundle.

### Where the guarantees are tested

- `apps/api/src/application/notion-import.test.ts` — decisions against a stub: a
  dry run touches no writing service; an apply records owner and digest; the same
  bundle twice writes nothing at all; a changed page updates and keeps its address;
  an empty page is refused while the rest lands; another account's page is refused;
  a deleted work is refused; translations attach to one work; a malformed bundle and
  an oversized one are rejected before anything is read.
- `apps/api/src/transport/rest/imports.integration.test.ts` — real HTTP and a real
  database, on SQLite always and on PostgreSQL when `TEST_DATABASE_URL` is set: the
  `401`, the dry run writing nothing, the apply creating a work that **the public
  unauthenticated read** then serves (the same request the web and Flutter clients
  make), the idempotent second run, the update that keeps the slug, the refusal for
  a second account, and the `400`s.
- `apps/api/src/persistence/persistence-adapter-contract.test.ts` — the link table
  behaves identically on both providers: one row per page edition, an upsert that
  replaces in place, and `getMyArticle` scoping (an id is not a permission).
