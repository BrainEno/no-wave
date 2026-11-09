# Article view counts

A work's reach is now a number the API stores, returns and can be told about by
the page that rendered it.

```sh
# What the reading page sends once it has mounted
curl -s -X POST "https://api.example.com/api/v1/articles/a-work/views?locale=zh-CN" \
  -H "Authorization: Bearer $TOKEN"          # optional: no session is required
# → {"data":{"counted":true,"viewCount":3}}

# Every read of the work carries the number
curl -s "https://api.example.com/api/v1/articles/a-work?locale=zh-CN"
# → {"data":{ ..., "publishedAt":"…", "viewCount":3, "author":{…}, … }}
```

## What counts as a view

| Rule | Why |
| --- | --- |
| Recorded by `POST …/views`, never by the `GET` | The read is cached, prefetched and crawled; a counter on it would move without a reader |
| One view per **reader**, per **work**, per **UTC day** | A refresh cannot inflate it, and the boundary is a line anyone can state |
| The author's own reads are not counted | Proofreading is not reach |
| Signed-in readers are keyed by account, anonymous readers by address | The number covers everyone who can read the page, not only the people who signed in |
| Only published works are counted | A draft has no readers, and an unknown slug is a `404` |

The reader key is `HMAC-SHA-256` over the article id, the reader and the UTC
date, under a namespace derived from the deployment secret. The database stores
`auth_rate_limits` rows that contain a digest and nothing else: no account id, no
IP address, and no way to turn a row back into either. The row expires within a
day; the counter on the work does not.

## The response

| Field | Meaning |
| --- | --- |
| `counted` | Whether **this** call moved the number. `false` is a normal answer — the author, or a second visit in the same UTC day |
| `viewCount` | The work's total after the call |

`200` covers both outcomes deliberately: a deduplicated view is not a client
error, and a page does not need to interpret a status code to know that its
beacon was accepted.

## What a client should do

- Send the beacon **after mount**, once per page load, for the edition being read.
- Treat every answer as final. A `counted: false` is not a reason to retry, and a
  failure is not worth showing anyone: the page already rendered.
- Do not send it from the server render. A server render happens for crawlers,
  link previews and prefetches, and none of them is a reader.

The Web app does exactly this: `ArticleViewBeacon` (renders nothing) calls
`createViewBeacon`, which remembers `(slug, locale)` for the life of the page load
and posts through `POST /api/articles/:slug/views` — the same-origin proxy that
carries the session cookie and validates the two inputs before forwarding.

## Errors

| Status | Code | When |
| --- | --- | --- |
| `400` | `BAD_USER_INPUT` | the slug or `locale` is malformed |
| `404` | `NOT_FOUND` | the slug is not a published work |
| `429` | `RATE_LIMITED` | the beacon itself exceeded `120/min per address` or `60/min per account` |

## Limits and known undercounts

- **A household behind one NAT counts once a day.** Anonymous readers are keyed by
  address; that is an undercount, in the direction that flatters nobody.
- **A bot that executes JavaScript counts.** At this layer it is
  indistinguishable from a reader; filtering on user agent would be a second,
  unverifiable rule.
- **The Flutter client does not send beacons yet.** It reads `viewCount` and will
  under-count until it does.
- **Nothing is ordered by views.** Ranking by reach would turn the counter into an
  objective to game.

## Where this is implemented

| Piece | File |
| --- | --- |
| Route and handler | `apps/api/src/transport/rest/routes/articles.ts` (`articles.views`) |
| Dedupe key, day, reader | `apps/api/src/application/article-views.ts` |
| The decision (author, bucket, increment) | `apps/api/src/application/services.ts` (`recordArticleView`) |
| Column | `apps/api/src/persistence/migrations/0032_article_view_counts.sql`, `…/sqlite/0019_article_view_counts.sql` |
| Only writer of the column | `incrementArticleViewCount` in both article stores |
| Write throttle | `apps/api/src/application/rate-limit.ts` (`POST articles.views`) |
| Browser proxy | `packages/web-http/src/views.ts`, `apps/web-rr/app/routes/api.articles.$slug.views.ts` |
| Page beacon | `packages/web-ui/src/components/public/article-view-beacon.tsx` |
| Decision record | `docs/architecture/decisions/0035-article-view-counts.md` |
