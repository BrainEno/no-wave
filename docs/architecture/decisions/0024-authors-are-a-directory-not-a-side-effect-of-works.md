# ADR 0024: Authors are a directory, not a side effect of their works

- Status: Accepted
- Date: 2026-11-02

## Context

The search page has had an "authors" tab for as long as it has had tabs, and it never
searched authors. What it did was aggregate: take the works whose title, summary or body
matched the query, and collect whoever wrote them. The component said so out loud —
"the API has no author search endpoint" — and the consequence was the one you would
expect: a writer could be found only through one of their titles. Searching a name found
nobody whose work did not happen to contain it, on the tab whose only promise is finding
people by name.

There *is* a profile search in the system: `searchUsers`, behind `/api/v1/identity/users`.
It is not the same thing, and using it for a public page would have been three separate
mistakes:

- it answers with **every account**, including the ones that have never published, so a
  public page built on it is a member list with a search box;
- it carries per-reader fields (`role`, `isFollowing`), which makes the response
  uncacheable and asks the page to explain fields a reader has no use for;
- it lives under `/api/v1/identity`, which is the messaging address book — a surface
  chosen for "find somebody to write to", not "find somebody to read".

## Decision

**Authors get their own public directory: one endpoint, one page, one rule for who is in
it.**

### The endpoint

`GET /api/v1/authors?query=&locale=&limit=&offset=` — no session, no per-reader fields.

- `query` is optional. Without it this is the directory; with it, a name filter.
- `limit` defaults to 20 and is capped at 100; `offset` is capped like every other
  offset in the API.
- The response is the same for everybody who asks, so whoever sits in front of the API is
  free to cache it. Anything that depends on the reader stays on the author's own page,
  which already carries it.

### Who is in it

**An author appears when they have a published work in the requested locale.**

That is the whole test, and it is deliberately not "has a profile". A public directory is
a list of people a reader can go and read: an account that has published nothing is not an
author here, and listing one would turn a reading index into a member list — a thing this
site has no reason to publish and every reason not to.

Locale-scoped membership is the same rule every other public list uses. `workCount` is
counted the same way, so a draft, a tombstone and another language's work are all
"published somewhere else", not "published here". The *name* still falls back across
locales: an author with only a Chinese profile who publishes in English appears in the
English directory under their only name, because a row with no name is worse than a row in
the wrong language.

### How it is ordered

**Relevance when there is a query, reach when there is not.**

With a term: an exact name first, then a name that *starts* with the term, then the author
more readers already follow. Reach is only a tie-breaker there — a directory that answers
"林" with the most-followed author whose name merely contains 林 is answering a different
question than the one that was asked.

With no term, reach is the order: followers, most first. The point of the directory is
discovery, and alphabetical order is how you look somebody up, not how you find somebody.

### The page

`/authors` and `/en/authors`, the same shape as the category index — search form, numbered
rows, pager, and a query in the URL so a filtered directory is a link somebody can send.
Each row carries the author's initial, their bio, and the two numbers a reader can act on:
how much of their work is here, and how many people already follow them. It is linked from
the footer's reading index, and the search page's authors tab ends with a way into it.

### Not in this slice

- **Searching bios.** A name is what a reader types; matching on the bio would put
  "novelist" ahead of the novelist people came for.
- **Follow buttons in the list.** They would make every row viewer-specific, which is
  exactly what the endpoint is designed not to be.
- **Ranking by recent activity.** Followers are a stable signal; publication recency
  changes while you look at it, which is the reason the popular sort has no cursor.
- **Cursor paging.** The directory is small, paged like the categories beside it, and
  stable enough for an offset — a page boundary here does not move under the reader.

## Consequences

- The search page's authors tab now finds writers by name, which is what the tab says it
  does. Its old aggregation is gone rather than kept as a fallback: two ways to answer the
  same question is how they drift apart.
- `searchUsers` and `searchAuthors` now exist side by side, on purpose. One is the
  messaging address book (every account, per-reader fields, under `/identity`); the other
  is the public catalogue (published authors only, no per-reader fields, under `/authors`).
- The directory costs one query with two subqueries per page, and it is a public read, so
  it is the cheapest page on the site to cache.
- Somebody who has published only in English is invisible in the Chinese directory. That
  is the same trade the archive, the categories and the search page already make: the site
  is bilingual, and it is two catalogues, not one merged one.
