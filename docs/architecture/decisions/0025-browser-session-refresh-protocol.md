# ADR 0025: The browser session is one cookie contract and one refresh per rotation

- Status: Accepted
- Date: 2026-11-04
- Relates to: #161, #183; [ADR 0012](0012-portable-web-framework-migration.md),
  [ADR 0014](0014-password-recovery-and-email-verification.md),
  [API authentication contract](../api-authentication.md)

## Context

The browser never holds a token. The Web application is a backend-for-frontend
(BFF): it reads three cookies, attaches the access token as an `Authorization`
header, and rotates the refresh token against the API when the API answers 401.
The API's rotation is strictly one-time: reusing a consumed refresh credential
atomically revokes the **whole session family**, and there is deliberately no
grace window ([authentication contract](../api-authentication.md), and the
concurrency test in `apps/api/src/persistence/identity.integration.test.ts`).

Two defects came out of treating that contract as three independent features:

1. **The top bar could not see the session.** `serializeCookie()` appended
   `HttpOnly` to *every* cookie. `SiteChrome` reads `nw_session` from
   `document.cookie` after hydration to decide whether to request the inbox, so
   a signed-in reader was always classified as signed out and the bell answered
   "去登录 →" (#161, reopened after PR #171). The same marker is read on the
   *server* by `/account`, `/admin/featured` and `/write/media` loaders, and it
   is a page-render hint, not an authentication decision.
2. **Concurrent 401s revoked the session.** `forwardAuthoringRequest` called
   `upgradeSession()` independently for every 401. Two parallel private requests
   carry the same, not-yet-rotated refresh cookie; the second one presents the
   already-consumed token, the API calls it a replay, and even the winner's
   brand-new token dies (#183).

The two are one problem: the browser, the BFF and the API must agree on **when a
rotation is in progress and which credentials belong to the current generation**.
This ADR fixes that agreement first; the code changes follow it.

Non-goals: changing the API's replay detection, adding a refresh grace window to
the identity layer, relaxing login throttling (#184 is separate), or changing the
API's JSON shapes. The identity-layer concurrency contract stays exactly as its
integration test asserts (`[200, 401]`, family revoked).

## Decision

### 1. Three cookies, one rule about authority

| Cookie | Path | `HttpOnly` | Value | Authority |
| --- | --- | --- | --- | --- |
| `nw_access` | `/api/authoring` | **yes** | opaque access token | the bearer credential |
| `nw_refresh` | `/api` | **yes** | opaque refresh token | the rotation credential |
| `nw_session` | `/` | **no** | refresh expiry as unix seconds | **none** |

`HttpOnly` stays the default in `serializeCookie()`; the marker is the single
explicit opt-out, with `SameSite=Lax` and `Secure` unchanged. A page script can
read and forge `nw_session`. That is acceptable because its value is only a
timestamp and it grants nothing:

- private route loaders use it to choose between *redirect to sign-in* and
  *render a data-free shell*; every byte of account, inbox and authoring data
  comes from `/api/authoring/*`, where the BFF attaches the access token and the
  API verifies it;
- the top bar uses it only to decide whether to ask for the unread count. A
  forged or expired marker earns the forger one extra request that answers 401,
  after which the UI shows the sign-in link;
- a 401 from any inbox endpoint is authoritative and overrides the marker.

The marker must never carry an account id, a token, a role or anything else a
script could interpret as an answer. `hasUsableSession()` keeps rejecting
anything that is not 1–15 digits naming a future second.

### 2. One refresh per rotation, in the BFF

`forwardAuthoringRequest` no longer refreshes on its own. On a 401 with a
refresh cookie it asks a **`RefreshCoordinator`** to resolve a key:

```
key = SHA-256("no-wave/refresh/v1" || NUL || apiBaseUrl || NUL
              || refreshToken || NUL || (accessToken ?? ""))
```

The key is a domain-separated digest, never the token itself. Binding the key to
the stale access token as well as the refresh token means a caller must present
the *same stale pair* to reuse a rotation result; a different API origin gets a
different key. No raw credential is retained as a map key, logged or persisted.

`resolve(key, rotate)` has two states:

- **in flight**: the first caller starts `rotate()`; every concurrent caller
  awaits that same promise. One HTTP call to `/api/v1/auth/refresh` per key.
- **settled, within a short reuse window** (`reuseMs`, default 5 s): the outcome
  is reused instead of starting a second rotation. This is needed because a
  third request can reach its 401 *after* the winner's refresh resolved but
  *before* the browser has received and applied any `Set-Cookie`. Without the
  window, that request would submit the old token and revoke the family. The
  window is bounded, the entry count is capped, and entries are memory-only.

Every caller applies the same outcome, so concurrent requests converge instead
of disagreeing:

| Outcome | Meaning | Every concurrent request |
| --- | --- | --- |
| `TokenSet` | rotation succeeded | retries its own resource once with the new access token; writes the rotated cookies (tokens `HttpOnly`) into **its own** response |
| `null` | refresh definitively rejected (400/401) | returns the original 401 and clears all three cookies |
| `undefined` | transient failure (network, 5xx, malformed envelope) | returns the original 401 and changes no cookie |

The identity layer sees exactly one presentation of the old token. Genuine
replay after the reuse window still reaches the API and still revokes the
family. A mutation is still retried at most once, with its idempotency key
forwarded; no new retry loop is introduced.

### 3. Cross-instance is a deployment contract, not a silent assumption

The shipped coordinator is `InMemoryRefreshCoordinator`, scoped to one Web
process. Production requests share that one instance; a caller that injects its
own `fetchImpl` gets a separate ledger, so rotation results never cross
transports. `ApiProxyConfig.refreshCoordinator` is an explicit port so a
deployment can supply a shared implementation (a distributed lock plus a
short-TTL result value) without touching the request path. A test pins the
boundary: two in-memory coordinators are two processes and do not share a
rotation.

**A deployment running more than one Web instance must do one of the following:**

1. route every request of a browser session to the same Web process (sticky
   routing keyed on a digest of `nw_refresh`), so the in-memory coordinator is
   sufficient; or
2. inject a coordinator whose claim and result are shared across instances.

With neither, concurrent 401s landing on different processes can still replay
the old token. This is documented, not hidden behind a best-effort lock. Sticky
routing by the *refresh* cookie (not by source IP) is what keeps a rotation and
all its retries on one process; session cookies are rewritten by every response,
so after the first response the browser converges on the new generation.

### 4. The top bar is a state machine, not a cache of identity

After hydration `SiteChrome` reads `nw_session` from `document.cookie`:

```
sessionUsable = null  → marker not read yet        → "载入中…"
              = false → absent/expired/malformed, or an inbox answered 401
                                                  → "登录 →" link, no badge
              = true  → marker current              → fetch unread count,
                                                     then list on bell open
```

`loading / ready / error` describe the inbox request, not the session. Opening
the bell re-reads; marking one or all read re-reads; a pathname change re-reads
the marker so login, logout and rotation are picked up on the next page. The
bell never writes identity from the marker: a 401 anywhere moves the state to
`false` and drops the badge and rows.

### 5. Residual risks, accepted explicitly

- **Short reuse window.** For at most `reuseMs`, a caller that already possesses
  the exact stale access/refresh pair can obtain the rotated session from the
  ledger instead of being forced to a new login. Constraints: the pair must be
  exact, the result never reaches JavaScript (only `Authorization` and
  `HttpOnly` `Set-Cookie`), the window is short, entries are capped and never
  persisted or logged. An attacker holding a full stale cookie jar already had a
  live session before the rotation; the alternative — no settled reuse — would
  reintroduce #183 for late-arriving concurrent requests.
- **Marker is forgeable.** The consequence is a data-free shell plus one 401.
  It must never be promoted into an authorization signal.
- **One Web instance is the supported default.** Multi-instance requires the
  deployment choice in §3; no shared store is shipped in this change.

## Consequences

- `nw_session` becomes readable by page scripts; token cookies stay `HttpOnly`.
  `packages/web-http/test/cookies.test.ts`, `apps/web-rr/test/web.test.ts` and
  the ADR 0014 wording are updated to assert the new split rather than
  "all cookies are HttpOnly".
- `forwardAuthoringRequest` gains an optional `refreshCoordinator` dependency;
  behaviour for a single 401 is unchanged. Deterministic concurrency tests cover
  three simultaneous 401s, a late-arriving fourth, distinct sessions, rejected
  refresh, transient refresh failure and window expiry.
- The API, its SQL, transactions, migration journal, replay detection, token
  shapes and REST responses are untouched.
- #161 and #183 are closed together at the BFF boundary. #184 (`Retry-After`)
  is a separate follow-up and is not part of this protocol.

## Verification map

| Claim | Cheapest reliable layer |
| --- | --- |
| Marker readable by `document.cookie`, tokens not | `web-http` cookie contract tests + a cross-package regression test in `web-ui` that feeds emitted `Set-Cookie` values into `sessionMarkerFromCookie` |
| One refresh for N parallel 401s, all succeed on the new session | deterministic `web-http` concurrency test with a gated stub fetch |
| Reuse window and its expiry | injected coordinator with a controllable clock |
| Replay still revokes the family | unchanged API integration test |
| Private shells stay data-free | existing `web-rr` route tests |
| Browser journey | CI `e2e` (production build, real Chromium) |
