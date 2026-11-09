# ADR 0035: A view is one reader, one work, one day — and never the author

- Status: Accepted
- Date: 2026-11-09

## Context

Every surface in the product could say how many people *saved* a work and how
many commented, and nothing could say how many read it. The writes were not
missing — the `GET /api/v1/articles/:slug` read happens all day — but a `GET` is
the wrong place to put a counter: it is cached, prefetched, crawled, refreshed
and reloaded by the very author checking a typo, and each of those would move a
number whose only value is that it means something.

The three questions a counter has to answer before it can be built are who counts
as a reader, what stops the same reader counting twice, and what happens to the
number when a work is deleted and restored. Answering them after shipping a
number is how a platform ends up with a statistic nobody trusts.

## Decision

**A view is recorded by an explicit `POST`, not by the read.**

```
POST /api/v1/articles/:slug/views?locale=zh-CN
→ 200 { "data": { "counted": true, "viewCount": 3 } }
```

The page sends it once after it has mounted. The server render never does: a
server render happens for crawlers, link previews and prefetches, and none of
them is a person looking at a page. A work that is not a published work answers
`404`; a repeated beacon answers `200 {counted: false}` — a deduplicated view is a
normal answer, not a client error.

**A reader counts once per work per UTC day.**

```
bucket = HMAC(HMAC(secret, "bot-thk:article-view:v1"), [articleId, viewer, "YYYY-MM-DD"])
```

charged through `consumeRateLimit({ key, limit: 1, windowSeconds: 86400 })` — the
same keyed counter store the write rate limits use, whose expiry sweep already
runs. Three consequences follow, and all three were the reason for the choice:

- **A refresh cannot inflate it.** The second read of the day finds the bucket
  spent.
- **The database never learns who read what.** The row is a digest keyed by a
  namespace derived from the deployment's secret; an account id or an address
  cannot be recovered from it, and two deployments do not produce the same
  digests. This is the same construction `application/rate-limit.ts` uses for its
  buckets, deliberately — one hashing idiom, audited once.
- **The boundary is a fixed line.** A UTC day starts at 00:00 for everyone. A
  sliding 24-hour window would need the stored timestamp read back before the
  decision and would make the boundary drift with each view; a reader who arrives
  at 23:59 and again at 00:01 counts twice, and that is the price of a rule
  anyone can state in one sentence.

**The author's own reads are not reach.** A signed-in author opening their own
work is proofreading; the counter returns what it already said, and the dedupe
store is not even consulted for the decision.

**The number lives on the row.**

```sql
ALTER TABLE articles ADD COLUMN view_count integer NOT NULL DEFAULT 0 CHECK (view_count >= 0);
```

Denormalised on purpose: every list that shows a work — the feed, a taxonomy
page, a profile, related works, the desk — reads it with the row it already has,
so no page pays a `GROUP BY`, and `StoredArticle.viewCount` flows through the one
mapper both providers share. `incrementArticleViewCount` is the only writer, it
returns the new total in the same statement (`UPDATE … RETURNING`), and deleting
and restoring a work keeps its history: reach the author earned is not something
a tombstone resets.

**Without a secret, nothing is counted.** The dedupe key needs a secret of at
least 32 bytes — the floor the rest of the service already requires. In a
deployment that lacks one the endpoint answers `{counted: false}` and writes
nothing: a counter that cannot tell two readers apart is a refresh counter, and a
number that only goes up is worse than one that stays still, because the second
looks broken instead of looking successful.

**The route is throttled like any other write.** `POST articles.views` is in the
write rate-limit table (`120/min per address`, `60/min per account`). The
boot-time check that refuses to start when a mutating route has no policy is what
made remembering this a requirement rather than a hope.

## Consequences

- **The stored number is a metric, not a document.** It is not written to the
  provider-migration journal: the journal carries entities across a cutover, and
  giving every page read a journal row to preserve a count would cost more than
  the count is worth. A view recorded during a cutover window may not travel to
  the new provider; the table copy brings the column across.
- **`view_count` and the dedupe rows are not reconciled.** The rows expire (a
  day's bucket is swept), the column does not: the column is the all-time number,
  the rows are today's spend. Nothing derives one from the other, so nothing can
  disagree.
- **Anonymous readers count.** Requiring a session would count only signed-in
  readers, the smallest and least representative part of an audience. An
  anonymous reader is keyed by a digest of their address, which means a household
  behind one NAT counts once a day — a known, documented undercount in the
  direction that flatters nobody.
- **Bots that execute JavaScript count.** A crawler that renders the page and
  runs its scripts is indistinguishable from a reader at this layer. Filtering by
  user agent would be a second, unverifiable rule; the honest position is that
  the number is "page loads that became a mounted page, deduplicated per reader
  per day".
- **No ordering depends on it.** Works are still ordered by publication date or
  by saves. Ranking by views would make the counter an objective to game, which
  is how these numbers stop being true.
- **The Flutter client is unchanged.** It reads `viewCount` from article JSON and
  does not yet send beacons; its pages will under-count until it does, and that
  is visible rather than silent.
