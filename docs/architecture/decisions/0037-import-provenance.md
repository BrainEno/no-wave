# ADR 0037: An import remembers where each edition came from, in the database

- Status: Accepted
- Date: 2026-11-09

## Context

ADR 0036 settled the shape: an imported Notion page becomes an ordinary article,
and the mapping between the two is one pure module. Phase 1 shipped that mapping
and an operator seed that writes through the REST API, remembering what it had
already imported in two places — the API's stored `Idempotency-Key`
(`notion-seed:<page id>`, ADR 0019) and a digest file on the operator's disk.

That is enough for one operator with one laptop. It is not enough for the feature
the product needs next: **any signed-in author imports their own database from the
browser** (`POST /api/v1/imports/notion`). Two things break.

1. **A client-supplied memory is not a fact.** If the browser says "page X is
   unchanged since my last import", the server can only believe it. A cleared
   profile, a second browser, a second device, or a malicious client all produce a
   different answer to the same question — and the answer decides whether the
   site rewrites a work or leaves it alone.
2. **`Idempotency-Key` is not provenance.** It makes a repeated *create* a no-op
   for as long as the stored key lives, and it says nothing about where the work
   came from, which locale of the page produced it, or whether a page's content
   has actually changed since. It is also the wrong place to hang a foreign id: an
   idempotency key is a request fingerprint, not a piece of the domain.

Re-import must remain the safe, boring operation ADR 0036 promised: import the
same bundle twice and nothing happens; change a page and the work it already
belongs to is updated, keeping its address; delete a page in Notion and the site
does nothing at all.

## Decision

**Provenance is a table the server owns, keyed by `(provider, page, locale)`, and
the import is one endpoint that reports per page.**

1. **`external_content_links` is the memory** (migration `0033` PostgreSQL,
   `0020` SQLite). One row per imported *edition*: `(provider, external_id,
   locale)` is the primary key, `article_id` points at the work, `owner_id` records
   the account that imported it, `digest` is the fingerprint of what a reader sees,
   and `synced_at` is when it was last written.

   - **`locale` is part of the key, not a column on the side.** A work's
     translations arrive as separate Notion pages, so the page — not the work — is
     the unit that has to be remembered. The same page id in two locales would
     otherwise overwrite itself.
   - **The key is global, not per owner.** A Notion page names one work in the
     world; letting two accounts link the same page would put the same words at two
     URLs and double the site's content. A second account importing a page that is
     already linked is *refused*, with the reason in the report.
   - **`ON DELETE CASCADE`**: the link is not a backup. Deleting a work forgets
     where it came from, and a later import of that page is refused rather than
     recreating something the author deleted.

2. **The digest is computed by the mapping and stored by the server.** It is
   `draftDigest` from `notion-bundle.ts` — over the title, summary, locale, work
   type, sorted tags, publish state, publication instant and the blocks without
   their ids. A page that was merely touched in Notion (a moved cursor, a recoloured
   block) is not a change. Because the comparison happens server-side, "unchanged"
   means the same thing in every client, on every device, after any cache clear.

3. **One endpoint: `POST /api/v1/imports/notion`, dry run by default.** The body
   is `{ bundle, apply? }`; without `apply: true` nothing is written — no works, no
   tags, no links — and the response is the plan. The answer is a per-page report
   (`create` / `update` / `skip` / `refused` / `failed`, one line each, with the
   issue codes the mapping already emits) rather than a single status: an import of
   forty pages must not fail because one of them is empty. The endpoint lives under
   `/imports/notion` rather than `/articles/import` because it writes two kinds of
   resource and neither is "an article create".

4. **A translation is added to its work, not created beside it.** The plan groups
   pages into works first (the `English` relation, then `Parent item`). When the
   work is new, its primary page creates the article and the other editions are
   written as `PUT`s of that article in their own locale — the same request the
   desk sends when an author adds a language version. Counting an added edition as
   an `update` in the report is deliberate: one work, one article.

5. **A re-import never renames anything.** The address of an imported work is the
   one the API chose when it was created (possibly suffixed, possibly authored in
   the `Slug` property). An update writes that address back. To know it, the import
   reads the work through `getMyArticle({articleId, actorId, locale})` — a new,
   author-scoped read, because an id is not a permission — instead of storing a
   copy of the slug on the link, which would revert a rename the author made in the
   desk.

6. **Slug resolution moves into the application layer.** The retry loop that turns
   a derived slug into `-2`, `-3`, … was written inside the `POST /articles`
   handler. It is now `createArticleWithSlug` in `application/article-create.ts`,
   used by both the endpoint and the import. Two copies would drift, and the drift
   would be invisible: the same work would get a different address depending on
   which door it came through.

7. **Nothing is deleted, unpublished or merged.** A page that disappeared from the
   bundle is not acted on (the import only sees what it was given); `publish:
   false` becomes a draft; an existing work is never unpublished by an import.
   There is still no sync engine (ADR 0036), no conflict resolution, and no
   credentials — the client fetches the pages, the server only sees content.

## Consequences

- **The seed's local state file becomes legacy.** `scripts/notion-seed.ts` still
  works and still keeps its digest file, because it writes through HTTP as an
  operator. The link table now answers the same question for API clients, and a
  future seed can use it and drop the file. ADR 0036's decision 4 said the link
  table would *replace* the key-plus-digest pair rather than accompany it; that is
  now true for the server, which is where it matters.
- **A new persistence slice.** `imports` owns three methods
  (`getExternalContentLink`, `upsertExternalContentLink`, and — since the export
  landed, ADR 0036 decision 7 — `listExternalContentLinks`, the same question asked
  by work rather than by page) in both providers. It is its own slice rather than a
  corner of `article` or `taxonomy`: provenance is neither content nor
  classification, and folding it into either would have made it invisible in the
  ownership document. The provider-migration row applier lists the table, because a
  cutover that dropped these rows would make the next import create a second copy
  of every work.
- **Two new contract surfaces.** The persistence port table gained `imports` and
  `getMyArticle`; the REST contract gained one operation with two schemas
  (`NotionImportRequest`, `NotionImportReport`) and documented `413` / `415`
  responses — an 8 MB body limit, because one page may carry 200 blocks of 20,000
  characters and a work's editions arrive together.
- **A 200-page cap and a write rate limit (10 per 10 minutes per account).** The
  cost of an import is the request, not the article. The cap is what keeps a
  "database export" from becoming an unbounded write; the report is what makes a
  retry rarely necessary, since a failed page is named.
- **Idempotency keys stay, for a different job.** Creates still carry
  `Idempotency-Key: notion-seed:<page id>` so a request that dies mid-way can be
  retried without duplicating what it already created. That is request-level
  replay protection (ADR 0019), not provenance — and the link table is what decides
  create versus update.
- **What this does not solve.** Images (`expiring-image-url`,
  `featured-image-not-carried`) are still not copied; a work's Notion nesting and
  `Rank` are still reported, not imported; and there is no export endpoint yet —
  phase 4 — which will read the same table to answer "which page is this work?".
  The Flutter client needs no change: an imported work is an ordinary article, and
  the public read path is asserted in the endpoint's integration test.
