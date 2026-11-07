# The published API contract

`GET /api/v1/openapi.json` answers with an OpenAPI 3.1 document describing every
route under `/api/v1`. The same document is checked in at
`docs/api/openapi.json`, so a reader who has the repository does not need a running
server to see the contract, and a reader who has a server does not need the
repository.

Both are generated from `apps/api/src/transport/rest/routes.ts` — the table the
dispatcher itself matches against — by
`apps/api/src/transport/rest/openapi/`. Paths, methods and path parameters come
from that table; the prose and the parameters come from
`openapi/operations.ts`; the component schemas come from `openapi/schemas.ts`.
Nothing in the document enumerates an endpoint by hand.

## Why it is generated rather than written

A hand-written contract is a second description of the API, and the two drift the
first time somebody renames a route. Here the drift is impossible in both
directions:

- A route added to the table without an operation fails the API at start-up
  (`assertOperationsMatchRoutes`), not on the next person who reads the document.
- An operation naming a route that no longer exists fails the same check.
- `docs/api/openapi.json` is compared byte-for-byte with the served document by
  `pnpm openapi:check`, which the root `pnpm test` list runs. A contract change that
  forgets to regenerate the file turns into a failing test rather than a stale file
  that describes the previous release.

```sh
pnpm openapi:check   # default: prove docs/api/openapi.json matches the API
pnpm openapi:write   # refresh the file after an intentional contract change
```

Adding a route therefore takes two edits: the row in `routes.ts` and a metadata row
in `openapi/operations.ts`, keyed `"<METHOD> <route id>"`. A new response or body
shape adds a component in `openapi/schemas.ts`.

## Using it

```sh
curl -s http://localhost:4000/api/v1/openapi.json | jq '.paths | keys'
curl -s http://localhost:4000/api/v1/openapi.json | jq '.paths["/api/v1/articles"]'
```

The document imports into Postman, Insomnia, Stoplight, `openapi-typescript` and
any other OpenAPI 3.1 consumer. Two things are worth knowing before generating a
client from it:

- **Operation ids are `<route id>.<method>`** (`articles.item.get`), not prose
  names. They are stable across renames of the handler file and unique per
  operation, which is what codegen needs, and they are the same ids the dispatcher
  and the `405` allow-list use.
- **The document describes the envelope, not every field of every row.** Where a
  response is a stored row (`Article`, `AuthorProfile`, `Conversation`, …) the
  schema lists the fields the projection layer reads. It does not set
  `additionalProperties: false`, because the serializers deliberately pass values
  they do not understand through untouched; a closed object would be a promise the
  API does not make.

## A five-minute journey: register, publish, read

This is the "register → sign in → publish → read" path the audit asked for
(F-19), verified against a local stack (`pnpm setup:local && pnpm db:migrate`,
API on `:4000`). Every field and status below is in the document.

```sh
API=http://localhost:4000/api/v1

# 1. Register. Answers 201 with a bearer token and a refresh token.
curl -s -X POST "$API/auth/register" -H 'content-type: application/json' \
  -d '{"email":"writer@example.test","password":"correct horse battery staple"}' | jq '.data.tokenType'

# 2. Sign in later. Same body, same answer shape.
TOKEN=$(curl -s -X POST "$API/auth/login" -H 'content-type: application/json' \
  -d '{"email":"writer@example.test","password":"correct horse battery staple"}' | jq -r '.data.accessToken')

# 3. An author profile. Public pages read it, so publish after this exists.
curl -s -X PUT "$API/me/profile" -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{"displayName":"A Writer"}' > /dev/null

# 4. Publish a work. Exactly one of contentBlocks / editorState.
curl -s -X POST "$API/articles" -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"title":"The first work","locale":"en","workType":"essay","publish":true,
       "contentBlocks":[{"id":"b1","type":"paragraph","text":"The sea was loud that night."}]}' \
  | jq '.data.slug'

# 5. Read it anonymously — the address a reader would use.
curl -s "$API/articles/the-first-work?locale=en" | jq '.data.title'
curl -s "$API/articles?locale=en" | jq '.data | length'
```

A retry of step 4 that carries the same `Idempotency-Key` header returns the work
the first attempt stored instead of a second copy under a uniquified slug; the
header is documented on the operation, with the replay rules in
[rest-idempotency.md](../architecture/rest-idempotency.md).

## What the document claims, and what it does not

| Claim | How it is held to it |
| --- | --- |
| Every route and method in the API is in the document, and nothing else is | `openapi.test.ts` builds both sets from the live route table and compares them |
| Every documented path is routable by the dispatcher | the same test hands each documented path back to `resolveRestRoute` |
| An operation documented as anonymous does not answer `401`, and a session-only `GET`/`DELETE` does answer `401` without a credential | `openapi.integration.test.ts` boots a real server and calls all 65 operations |
| Every operation has a summary, an id, a success response and a `400` | `openapi.test.ts` |
| Every `$ref` resolves; every path parameter is declared; no duplicate operation ids | `openapi.test.ts` |
| The checked-in file is the served document | `scripts/openapi.test.ts` and `pnpm openapi:check` |

Deliberately outside the document's scope:

- **Response headers.** Every JSON response carries `Cache-Control: no-store` and
  uploaded images carry an immutable policy; that is a property of the transport,
  stated in the document's introduction rather than repeated on 65 operations.
- **Rate limits.** Write throttling is per account and per TCP peer with buckets
  defined in `apps/api/src/application/rate-limit.ts`; the numbers are operational
  settings, not part of the contract. See
  [ADR 0011](../architecture/decisions/0011-write-rate-limit-policies.md).
- **The block schema of a body.** `contentBlocks` is described as an array of
  objects because the block contract is versioned and owned by the domain; a copy
  here would be a third definition of it. The write rules are on the
  `ArticleWrite` and `CommentWrite` schemas.
- **The narrative for humans.** Discovery ordering, cursor semantics, tombstone
  retention and the locale rules are explained in `apps/api/README.md` and
  [authoring-locales.md](authoring-locales.md). The contract states the shape of
  each operation; those documents state why it behaves that way.
