# ADR 0036: Notion is an interchange format, not a database the site syncs with

- Status: Accepted
- Date: 2026-11-03

## Context

The author's existing work lives in a Notion database ("Bottom Think"): a row per
work with a title, a `Slug`, an `Excerpt`, a `Date`, a `Published` checkbox, a
`FeaturedImage`, a `Tags` multi-select, two self-relations (`English` for the
translation pair, `Parent item` / `Sub-item` for nesting) and a `Rank` number,
plus the work's body as Notion blocks.

The site already models nearly the same thing: a work (`articles`) with one row
per locale (`article_translations`), blocks validated by a small, strict schema,
tags as taxonomies, and a published flag. Two surfaces read it — the React
Router web app and the Flutter client — and both read it through the same REST
contract.

There are three tempting architectures, and two of them are traps:

1. **A sync engine.** Keep a live two-way binding, reconcile `last_edited_time`
   on both sides, resolve conflicts per property. This turns every ordinary
   authoring edit into a merge problem, and a bug in it can destroy the
   author's manuscript — the one asset in the product that cannot be
   regenerated.
2. **A parallel "imported" content type.** Store imported pages in their own
   tables and teach each client to read them. Every future feature (comments,
   likes, view counts, search, moderation, feeds) would need a second
   implementation, and the Flutter client — which this repository does not
   ship — would have to be updated in lockstep to see the data at all.
3. **An interchange format.** Treat Notion as a *file format* for articles:
   import reads it once and writes ordinary articles; export writes an ordinary
   article back out. Nothing downstream knows Notion exists.

The portability requirement ("users import from their own Notion", "articles go
back to Notion", "the web page and the Flutter client must show the result") is
what settles it: only (3) makes imported work indistinguishable from written
work at every read path, and only (3) keeps the two clients unchanged.

## Decision

**The mapping is one pure module; the rest is the article contract the site
already has.**

1. **`apps/api/src/application/notion-interchange.ts` is the entire mapping, in
   both directions, and it is pure.** No HTTP, no database, no credentials, no
   ambient clock (a published page without a `Date` is dated by an injected
   `now`). One file means the import and export paths are tested against each
   other and cannot drift; purity means a real payload can be replayed in a
   test byte for byte.

2. **An imported work is an article, created through the same validation and
   the same persistence ports as a hand-written one.** No shadow table, no
   `imported` flag on the read path, no client-side branch. The mapping's output
   is asserted against the *same* `normalizeArticleInput` / `validateArticleBlocks`
   a human's draft passes before it lands. Consequently the web app and the
   Flutter client need no changes at all: they already read `viewCount`,
   `contentBlocks`, tags and translations, and an imported work is another row.

3. **Notion credentials never reach this server.** A Notion integration token
   is the user's, and storing it would make the API a custodian of a third-party
   credential with no revocation story, no scopes per workspace and a
   breach blast radius outside our own data. Instead the *client* holds the
   token, fetches the pages, and sends us a **bundle** (pages + blocks exactly as
   Notion returned them). The seed path in this repository does the same thing
   with a token from the environment of whoever runs it. The server only ever
   sees content.

4. **Identity is the Notion page id, recorded next to the article.** Re-import
   must update, not duplicate, so a link record `(provider, external_page_id) →
   (article_id, locale)` is the unit of idempotency, and a content digest on it
   decides whether a re-import is a no-op. The mapping itself is deterministic,
   so "same page, same blocks" produces the same draft. Until that table exists
   (phase 2), the seed run gets the same property from two things it already
   has: the API's stored `Idempotency-Key` (`notion-seed:<page id>`, ADR 0019),
   which makes a create of an already-created page a no-op, and a local digest
   file, which makes an unchanged page a skip. Neither is a migration, and both
   are replaced — not accompanied — by the link table.

5. **Lossy corners are recorded, never guessed.** The site's block model is
   smaller than Notion's and its article has no cover field, no nesting, no
   manual rank and no checkbox state. Anything without an equivalent is
   flattened into the nearest block that can hold its text (a bookmark becomes a
   paragraph with a linked run, an equation a paragraph in code marks) or
   dropped **with an issue code**, and the import report states the count per
   code. Silently dropping an author's paragraph is the failure mode this rule
   exists to prevent.

6. **Images from Notion are copied, not linked.** A `files` property or an
   image block of type `file` carries a signed S3 URL that expires in about an
   hour, so a stored URL is a broken image by tomorrow. The mapping flags them
   (`expiring-image-url`, `featured-image-not-carried`) and the import step is
   expected to fetch the bytes into the site's own media storage (ADR 0028)
   before writing the article.

## Consequences

- **There is deliberately no live sync.** Import is a one-shot run that can be
  repeated; an edit in Notion after that run is picked up by re-importing, not
  by a background job. Export is a snapshot written into the author's Notion
  workspace. Two-way conflict resolution is a *future* decision with its own
  ADR, and it will need per-field provenance to argue about.
- **Notion's structure is flattened on purpose.** `Parent item`/`Sub-item`
  nesting, `Rank`, `English` as a standalone page, and the `FeaturedImage`
  cover have no home in the article contract, so they are reported rather than
  invented. Adding a cover field is a contract change with a migration and a
  client release behind it — a separate capability, not a side effect of an
  importer.
- **The translation pair is one work.** In Notion, `English` is a second page
  in the same database; in the site, it is `article_translations` of the same
  work, addressed by one slug. The importer treats the page with a `Date`/`Slug`
  as the work's primary edition and a page reachable only through `English` as
  the `en` edition. A blank English page is refused (`empty-body`) rather than
  filled with placeholder text.
- **A page with only unsupported blocks is refused, not imported empty** — the
  write contract requires a body, and inventing one would publish a work whose
  content the author never wrote.
- **The seed script is not a server feature.** It runs with an operator's token
  on an operator's machine and writes through the public REST API, so it exercises
  the same contract a user's import will.
- Rate limiting, moderation, notifications, search and view counting are
  untouched: imported articles arrive as ordinary `draft`/`published` rows.

## Validation contract

- `apps/api/src/application/notion-interchange.test.ts` maps payloads trimmed
  from the real "Bottom Think" database and asserts the result passes
  `normalizeArticleInput`, that CJK titles derive ASCII slugs, that date-only
  values become UTC midnight, that every flattening path emits its issue code,
  and that a full round trip (page → draft → page → draft) preserves what a
  reader would see.
- `pnpm test` and the six typecheck targets keep the module honest; the mapping
  has no I/O, so it is covered by unit tests rather than an integration suite.
