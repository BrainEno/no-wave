# REST transport layout (issue #58, step 2)

- Date: 2026-10-29
- Supersedes the single-function handler described in issue #58 ("1708-line single-function if-chain")
- Related: [frontend portability migration](./frontend-portability-migration.md), ADR 0012

## What changed

`apps/api/src/transport/rest/handler.ts` was one 1746-line file: 42 route blocks in a single `if`-chain, plus every request helper, body normalizer and response serializer. It is now split by responsibility, with no change to a single route's behavior, status code, header or payload.

```
transport/rest/
  handler.ts            78 lines  request prelude + context assembly + ordered dispatch
  routes.ts            (unchanged) declarative route table + resolveRestRoute
  http.ts              request/response plumbing: sending, query parsing, body reading,
                       auth-context helpers, RestServices/MediaAssetsPort types
  bodies.ts            write-body normalizers (article/profile/like/comment/tag/taxonomy/
                       conversation/message) and their allowed-field sets
  serializers.ts       REST response serializers (article, articles, comment, comments,
                       notification)
  routes/
    index.ts           REST_ROUTE_GROUPS — the ordered dispatch list
    context.ts         RestRouteContext + RestRouteGroup types
    auth.ts            auth/*
    write-rate-limit.ts generic write throttle (a group, not a route)
    media.ts           media.item, me.media
    health.ts          health
    identity.ts        me, me.profile, me.session, users*
    notifications.ts   me.notifications*
    conversations.ts   conversations*
    articles.ts        articles*, comments.item, me.articles, me.liked-articles
    authors.ts         authors.*
    taxonomies.ts      tags*, categories*, taxonomies*
```

Largest file is now `http.ts` at 387 lines; the largest route group is `articles.ts` at 319.

## Why this shape

1. **One dependency bag instead of closure capture.** Every route group is `(context: RestRouteContext) => Promise<boolean>`. The context is built once per request by `handler.ts` and frozen. Route code therefore does not close over server-construction state, which is what makes the groups independently testable and movable.
2. **Dispatch order is data, not control flow.** `REST_ROUTE_GROUPS` is an exported array. The only ordering that matters is preserved and now explicit: identity actions run before the generic write rate limiter, and the rate limiter runs before any group that can read a body or touch persistence. Every group is additionally id-guarded, so moving one cannot change another route's behavior.
3. **Route matching stays in one place.** `routes.ts` (step 1) still owns paths, allowed methods and the 405 allow-list. The handler does not re-derive either, and `routes.test.ts` pins the classification contract.
4. **The prelude is auditable.** `handler.ts` is now short enough to read end-to-end: prefix check, duplicate-query rejection, route resolution, 405, context, dispatch, 404 tail.
5. **Helpers are separated by kind, not by caller.** Request/response plumbing (`http.ts`), input normalization (`bodies.ts`) and output serialization (`serializers.ts`) have different reasons to change; a new route now imports exactly one of them.

## Behavior preservation

- `apps/api/src/server.test.ts`: 56/56 (HTTP-level behavior across the REST surface).
- `apps/api/src/transport/rest/routes.test.ts`: 6/6 (route classification, 405 allow-lists, unmatched prefixes).
- `tsc --noEmit` for `apps/api` (both the default and strict configs).
- Full `pnpm test` shows the same result as before the split, including the pre-existing Node-22-only `node:sqlite` boolean-binding failure.

The split is a pure move: route bodies were extracted verbatim. The only edited lines are the module header, the context destructuring, and the `const on<X>Route = routeId === "..."` aliases that used to sit between blocks.

## Follow-ups (not done here)

- ~~Route groups are still `if`-chains keyed on `routeId` internally; the next step is one handler function per route id plus a `Record<routeId, handler>` map per group.~~ **Done (step 3, 2026-10-29).** Each group is now a frozen `Record<routeId, RestRouteHandler>`; handlers return `Promise<void>` because a matched route always writes exactly one response, so the old `return true` on every exit path was noise. Two route ids that were split across two `if` blocks by method (`articles.item` PUT/GET, `me.profile` GET/write) are now one handler with an internal method branch, in the original order. Every group exports its `*_ROUTE_IDS`, and `route-dispatch.test.ts` asserts the table and the groups agree: each declared route claimed exactly once, no group claiming an unknown id (verified by renaming one key: all three assertions fail).
- `http.ts` still carries `authenticatedUser`/`authenticatedActorId`/`optionalViewerId`, which read identity through the service facade. If the transport ever hosts a second protocol, these belong in a shared `auth-context` module rather than under `rest/`.
