# Upstream timeouts in the Web tier

## What this is

Every API call the Web tier makes — the SSR content reads behind public pages and
the BFF proxies behind authoring, account, inbox and media routes — runs under a
time limit. When the API accepts a connection and then stops answering, the
visitor gets the page's own error response instead of a request that waits for a
socket, a browser or a load balancer to give up. This closes audit finding F-17.

It is a liveness guard, not a retry policy, a circuit breaker or a cutover
mechanism. Nothing here changes persistence, the migration replay protocol
([ADR 0010](decisions/0010-sqlite-first-and-online-provider-cutover.md)) or the
API's own statement timeouts.

## The budget

| | |
| --- | --- |
| Default | 10 000 ms (`DEFAULT_UPSTREAM_TIMEOUT_MS`) |
| Maximum | 120 000 ms (`MAXIMUM_UPSTREAM_TIMEOUT_MS`) |
| Configuration | `API_TIMEOUT_MS`, an integer number of milliseconds |
| Invalid value | Rejected, never clamped and never silently replaced by the default |

An **unset** variable means the default. An empty or malformed value (`""`,
`"0"`, `"5s"`) is invalid on purpose: a deployment that sets the variable and
gets it wrong should say so, not quietly run on a budget nobody chose.

The deadline is a race between the call and a timer, and the timer is always
cleared when the call settles. Consequences worth knowing:

- The budget covers **connection, response headers and the buffered body** for
  every JSON surface. A response that sends headers and then stalls mid-body ends
  the call just like a connection that never opens.
- The abort signal is handed to `fetch`, so a cooperating transport drops the
  socket early — but the deadline does not depend on that. A transport that never
  reads the signal still times out.
- An abort that the call observes becomes `UpstreamTimeoutError`; any other
  failure keeps its own identity. A refused connection stays a "could not be
  reached" 502, not a timeout.
- `API_TIMEOUT_MS` is resolved at the same place as `API_BASE_URL`
  (`configuredClient()` for SSR content reads, `apiProxyConfig()` for proxies), so
  an explicitly constructed client and an environment-configured one cannot drift
  apart.
- A malformed value fails closed. Public pages answer their own 503; proxy routes
  answer **503** `SERVICE_UNAVAILABLE` ("not configured correctly") and never call
  the API.

## What each surface does when the budget expires

| Surface | Answer |
| --- | --- |
| SSR page loader (content API read) | The page's existing **503** `content-api-unavailable` boundary, `no-store`; the loader carries only the error *class* (`UpstreamTimeoutError`) |
| Authoring / account / inbox / comments / likes / follows / featured proxy | **504** `UPSTREAM_TIMEOUT`, `no-store`, no upstream text, no origin or credential in the body |
| Auth proxy | **504** `UPSTREAM_TIMEOUT`; logout still clears cookies |
| Public media object | **504** `UPSTREAM_TIMEOUT` — instead of "the bytes came back unusable", because the bytes never arrived |
| Session refresh inside a proxy | The refresh proves nothing about the session, so the original **401** passes through and the browser keeps its cookies |

A timeout after a *successful* rotation still returns the rotated cookies with
the failure: dropping them would leave the browser holding a token pair the API
has already revoked.

## Limits

- The API may still finish the work. Aborting the Web tier's request does not
  cancel an upstream write that has begun, so a timed-out mutation can still
  commit. Idempotency keys ([REST idempotency](../architecture/rest-idempotency.md))
  and the API's own authorization remain the protection against double submission;
  a timeout is not evidence that a write did not happen.
- No retries. A timed-out call is reported, not repeated. Retrying a mutation here
  would silently change what the browser asked for.
- No circuit breaker, no failure-rate tracking, no per-endpoint budgets. One value
  applies to every call in the process.
- Media reads are buffered under the same deadline and remain bounded by
  `MEDIA_MAX_BYTES`; the deadline adds a time ceiling to that size ceiling.
- Uploads from the browser to the Web process, and the Web process's own response
  writing, are outside this budget.
- A deadline cannot make a slow dependency fast. It bounds how long one request
  waits, which is what keeps a hung API from consuming the SSR connection pool.

## Verification

- `packages/web-http/test/upstream-deadline.test.ts` — the helper's contract:
  timer cleared, typed error, abort observed, a signal-ignoring transport still
  times out, non-timeout errors keep their identity, invalid budgets rejected.
- `packages/web-http/test/forward-timeout.test.ts` — the forwarder: 504 mapping,
  stalled body, connection failure staying a 502, rotation surviving a timeout,
  hung refresh passing the original 401 through, malformed budget never reaching
  the API.
- `packages/web-http/test/media.test.ts` — hung object store, stalled bytes,
  malformed budget.
- `packages/web-ui/src/lib/api-content.test.ts` — the SSR client: hung read,
  stalled body, construction-time validation, and an unaffected normal read.
- `apps/web-rr/test/web.test.ts` — the deployment shape: a stalled mock API with
  `API_TIMEOUT_MS=1200` produces a 503 page inside the budget, and the server
  keeps serving the next request.
