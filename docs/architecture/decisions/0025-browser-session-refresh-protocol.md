# ADR 0025: The browser session is one cookie contract and one refresh per rotation

- Status: Accepted
- Date: 2026-11-04
- Amended: 2026-11-12 — #324 and the remaining refresh behavior in #314
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

Both `POST /api/auth/refresh` and automatic 401 recovery use
`resolveSessionRefresh`. They share **one registry**, not one ledger per route.
Private resource reads/writes and viewer/actor guards use that same entry.

`refreshCoordinatorKey` hashes the UTF-8 encoding of this exact JSON array:

```
SHA-256(JSON.stringify([
  "no-wave/refresh/v2",
  apiUrl(apiBaseUrl, "api/v1/auth/refresh"),
  refreshToken
]))
```

The upstream is the canonical URL actually called, including any base path.
Trailing-slash aliases share a key; another endpoint or refresh generation does
not. The former optional access-token argument is accepted for source
compatibility but ignored. **Access is not rotation identity**: the browser can
omit it after expiry and always omits its narrower Path on explicit auth calls.
Requiring the old pair split these callers and replayed a one-time credential
(#324). Keys contain no raw credential; do not log or persist credentials or the
short-lived rotated values in an unprotected store.

`resolve(key, rotate)` has two states:

- **In flight:** the first caller presents the credential; every sibling awaits
  the same promise. There is one upstream refresh, independent of access-cookie
  presence and explicit versus automatic entry.
- **Settled:** reuse a rotation or definitive 400/401 refusal for `reuseMs`
  (default 5 s). A sibling can reach its 401 after the winner settled but before
  the browser applied its cookies. Reusing that answer avoids replay. Other
  failures, including 429, outages and malformed successful envelopes, use
  `transientMs` (default 250 ms), not a five-second lockout. The map retains at
  most 1,024 settled entries; `reuseMs: 0` disables both reuse windows. Pending
  rotations keep the existing upstream deadline, including body consumption.

A shared outcome is a token set or sanitized failure metadata, **never a shared
Response/body stream or upstream Set-Cookie**. Each route constructs its own
private no-store response and keeps its established policy:

| Shared outcome | Automatic 401 recovery | Explicit auth refresh |
| --- | --- | --- |
| Token set | retry its own guarded operation once, then write all three rotated cookies even if that retry fails | return token type/expiry only and write the same rotated cookies |
| Definitive 400/401 refusal | original 401 and clear all three cookies | sanitized upstream status/error; no cookie changes, preserving the explicit route contract |
| 429 | sanitized 429, normalized positive Retry-After when valid, no cookie changes and no resource retry | the same 429/backoff/no-cookie contract |
| Other HTTP failure | original 401, no cookie changes | sanitized upstream failure, no cookie changes |
| Timeout/network/malformed success | original 401, no cookie changes | 504 UPSTREAM_TIMEOUT / 502 SERVICE_UNAVAILABLE / 502 INVALID_AUTH_RESPONSE; no cookie changes |

Retry-After is bounded to 1–86,400 integer seconds; malformed, zero and past
values are dropped. Upstream headers other than that whitelist are not relayed.
Legacy injected coordinators returning `null` (refused) or `undefined`
(uncertain) remain supported; new implementations must carry the sanitized
failure shape to preserve explicit status and 429/backoff semantics.

The API's one-time rotation and atomic reuse-family revocation are unchanged.
A mutation retains its exact body/idempotency key and is retried at most once;
a refreshed actor mismatch stops before the write. A failed coordinator never
falls back to uncoordinated rotation. Genuine replay beyond the short reuse
window still reaches the API and can require a new login.

### 3. Cross-instance is a deployment contract, not a silent assumption

The shipped coordinator is `InMemoryRefreshCoordinator`, scoped to one Web
process. Production requests share that one instance; a caller that injects its
own `fetchImpl` gets a separate ledger, so rotation results never cross
transports. `ApiProxyConfig.refreshCoordinator` is an explicit port so a
deployment can supply a shared implementation (a distributed lock plus a
short-TTL result value) without touching the request path. A test pins the
boundary: two in-memory coordinators are two processes and do not share a
rotation. The shared implementation must use atomic claims and a short-TTL result,
protect token values, and handle lease/failure ownership; the v2 key and typed
outcomes are its protocol, not an implementation of a distributed lock. The
React Router app does not gain a shared external store through an environment
flag in this change. **#318 remains open.**

**A deployment running more than one Web instance must do one of the following:**

1. route every request of a browser session to the same Web process (sticky
   routing keyed on a digest of `nw_refresh`), so the in-memory coordinator is
   sufficient; or
2. inject a coordinator whose claim and result are shared across instances.

With neither, concurrent explicit/automatic requests landing on different processes can still replay
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

- **Short reuse window.** Possession of the exact old refresh credential is
  sufficient to reuse its rotation for at most `reuseMs`; an access cookie is
  deliberately not an extra condition. Refresh possession already authorizes
  rotation at the API. This is a BFF-only availability/security tradeoff, not an
  API grace period. Results leave the server only as `HttpOnly` cookies and
  Authorization, never browser JSON; they are bounded, memory-only by default,
  and must not be logged. A delayed/stolen refresh beyond the window remains a
  replay. Losing the winner's response can still require a new login.
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
  non-throttle failure behavior for a single 401 is preserved; refresh 429 is
  now propagated instead of hidden as that 401. Deterministic tests cover
  three simultaneous 401s, a late-arriving fourth, distinct sessions, rejected
  refresh, transient refresh failure and window expiry.
- API rotation SQL, transactions, migration journal, replay detection, token
  shapes and REST responses stay intact. The #314 amendment adds a read-only
  hash-to-live-session quota lookup on both providers; it grants no identity.
  See the [authentication quota contract](../api-authentication.md#abuse-controls-and-deployment-limitations).
- The original decision fixed #161/#183. The amendment fixes the access-cookie
  split and explicit bypass in #324 and completes #314 refresh 429 propagation.
  It does not implement or close cross-replica coordination (#318).

## Verification map

| Claim | Cheapest reliable layer |
| --- | --- |
| Marker readable by `document.cookie`, tokens not | `web-http` cookie contract tests + a cross-package regression test in `web-ui` that feeds emitted `Set-Cookie` values into `sessionMarkerFromCookie` |
| One refresh for N parallel 401s, all succeed on the new session | deterministic `web-http` concurrency test with a gated stub fetch |
| Reuse window and its expiry | injected coordinator with a controllable clock |
| Replay still revokes the family | unchanged API integration test |
| Private shells stay data-free | existing `web-rr` route tests |
| Browser journey | CI `e2e` (production build, real Chromium) |

### Amendment verification

- `refresh-boundary.test.ts`: gated mixed-entry/access-boundary bursts, typed
  failures/backoff, coordinator outage, actor fencing and exact write replay.
- `refresh-quota.integration.test.ts`: real SQLite/PostgreSQL session quotas,
  121 same-NAT sessions, unknown-token spraying, expiry and atomic replay safety.
- `apps/web-rr/test/refresh-session.test.ts`: production bundle/default singleton
  across real HTTP/API/providers, not an injected fetch/coordinator.
- `e2e/session-refresh.spec.ts`: actual Chromium Path/HttpOnly jar, concurrent
  explicit/automatic calls and durable 429 recovery with an unspent credential.
