# ADR 0027: The client address is the socket peer unless the deployment names its proxies

- Status: Accepted
- Date: 2026-11-07
- Updated: 2026-11-12 — authenticated Web BFF address bridge (#322)
- Relates to: ADR 0011 ([persistent write rate limits](0011-persistent-api-write-rate-limits.md));
  [API authentication contract](../api-authentication.md); #314, #322, #323

## Context

All per-IP API decisions use `ctx.clientAddress`: identity-attempt windows,
persistent write quotas, and anonymous article-view deduplication. Addresses are
throttling/telemetry inputs, never authentication or resource ownership. The
session-list API does not store or return visitor addresses.

A socket identifies the immediate caller. In a browser → Web BFF → API deployment,
that caller is the Web server, not the visitor. Merely increasing the API's
`TRUSTED_PROXY_HOPS` cannot recover a header the BFF never sent. Every anonymous
reader then shares a bucket, and one client can exhaust another's login/create
allowance. Blindly relaying a browser's forwarding headers fixes isolation by
letting attackers choose their own buckets, which is not a fix.

## Decision

### 1. Direct and legacy API deployments remain compatible

Without `BFF_CLIENT_ADDRESS_SECRET`, the API keeps the original policy:

- `TRUSTED_PROXY_HOPS` defaults to `0`; ignore all forwarded address headers and
  use the normalized TCP peer.
- An explicit integer `1`–`5` selects that many XFF entries from the right.
  This legacy positional policy is only safe when network controls prevent
  bypassing the declared chain and every proxy appends/overwrites correctly.
- Missing/short/invalid selected entries fall back to the socket. Invalid hop
  configuration fails startup; no address means the one `unknown` bucket.

A container port mapping alone is **not** evidence that a trustworthy XFF chain
exists. Do not infer a hop count from a hosting brand or from an incoming header.

### 2. Resolve visitor provenance at the Web socket boundary

The Web production listener and Vite development middleware use the same policy:

| Input | Default | Validation |
| --- | --- | --- |
| `WEB_TRUSTED_PROXY_HOPS` | `0` | integer `0`–`5` |
| `WEB_TRUSTED_PROXY_PEERS` | empty | at most 32 comma-separated literal IPs/CIDRs, at most 4096 characters; no `/0`, hostnames or zone IDs |

At zero hops, browser-written XFF, `Forwarded`, `X-Real-IP` and private bridge
headers have no authority. For nonzero hops a named peer list is mandatory. The
observed socket must match that list; otherwise use the socket even if a chain
was supplied. Select from the right, normalize the full selected suffix, and
require **every intermediate proxy** in that suffix to match the peer list too.
The selected visitor need not be a proxy. An incomplete, malformed or over-8192-
character chain falls back to the socket, not a more specific untrusted entry.

Requiring the intermediate peers matters: someone reaching only the last of two
configured proxies must not provide the missing earlier hop themselves. Extra
left-hand entries never move the selected trusted position. Operators still need
a reviewed topology, tightly scoped peer ranges and an appending/overwriting
policy on each edge; naming a large network is not a substitute for that review.

Canonicalization removes source ports, converts IPv4-mapped IPv6 to IPv4 and
normalizes IPv6 spelling. Unknown socket identity never becomes a browser claim.

### 3. Carry only authenticated, per-upstream metadata into the API

Set the **same**, separately generated `BFF_CLIENT_ADDRESS_SECRET` on Web and API.
Unset/empty disables the bridge. A configured value must be 32–512 non-whitespace
ASCII characters; invalid values fail startup without printing their contents.
Use at least 32 random bytes encoded as hex, distinct from the JWT key and from
other deployments' bridge keys. The secret is never transmitted.

The Web replaces, rather than forwards, these private request headers:

- `x-nw-client-address`: one canonical IP;
- `x-nw-client-address-proof`: `v1.<integer epoch seconds>.<lowercase HMAC-SHA256 hex>`.

The HMAC input is the JSON array
`["no-wave:bff-client-address:v1", seconds, uppercaseMethod, exactPathAndQuery, canonicalAddress]`.
Every actual identity call, resource call, viewer/actor guard, automatic refresh,
retry and public-media request gets a proof for its own target. Redirects are
refused (`redirect: "error"`) so metadata, bearer credentials or identity bodies
cannot follow an upstream redirect to a different origin.

The API validates the version, canonical address, bounded scalar header shape,
method, exact raw path/query and ±30-second clock skew, then compares MAC bytes
with `timingSafeEqual`. Duplicate, missing, stale, mismatched or malformed proofs
fall back to the normalized **socket**, never XFF. In bridge mode
`TRUSTED_PROXY_HOPS` **must be `0`**, enforced at startup. Otherwise a failed proof
could recover authority through the older unauthenticated proxy path.

The resolver assigns `ctx.clientAddress` once; identity, write-limit and view
services consume the same result. No domain policy or production quota changes.

### 4. Keep request scope and Node module identity intact

One server-only `AsyncLocalStorage` scope holds immutable address/key/clock input.
A disabled or unknown inner scope shadows its parent. Concurrent requests,
awaits, nested invocations and exceptions cannot select a global “current visitor.”
`web-http` accepts an explicit header-provider callback and reads no environment
or framework context from its browser-safe entry point.

The Node-only package subpath is explicitly externalized for **both** Vite SSR
resolution and the production Rolldown build. Vite configuration loads the native
entry for dev ingress too. Bundling another copy of this module creates another
storage instance: unit signatures would pass while actual production requests
silently fell back to the BFF socket. Real production and dev TCP tests protect
this boundary; Node 24 loads the external TypeScript entry in the runtime image.

### 5. Failure and deployment policy are explicit

- Neither end configured: legacy behavior, including a shared BFF peer bucket.
- Only one end configured, different keys, stale clocks or unusable proof: socket
  fallback; this is conservative but **not correct visitor isolation**. Health
  checks alone cannot establish correct attribution. Verify two real clients.
- Invalid configured secret, Web trust policy, or nonzero legacy API hops in
  bridge mode: fail startup, with no secret value in the diagnostic.
- An outbound signing/transport failure becomes the existing sanitized 502/504;
  do not send a mutation with partially assembled provenance.
- Keep TLS/trusted private transport between tiers, synchronize clocks, and do
  not expose/log either proof header. A proof is a short-lived address claim,
  not a nonce or body signature: it is replayable for the same method/path/query
  during its validity window if stolen, and grants no actor/resource permission.
- Key replacement needs an approved coordinated rollout. There is no dual-key
  grace period; mismatched instances fall back to the socket. This ADR neither
  rotates any key nor authorizes a deployment.

See [portable stack operations](../../operations/portable-stack.md#visitor-address-provenance)
for role-specific examples and verification.

## Reading identity and remaining scope

The browser view beacon uses `/api/authoring/articles/:slug/views` so the
`HttpOnly` access cookie scoped to `/api/authoring` is actually sent (#323). The
old route remains for compatibility. With either session credential present,
verify `/me` before the bodyless view mutation, including after renewal. An
expired/revoked author must not silently become an anonymous successful view.
Genuinely anonymous visitors skip the identity check and dedupe by trusted
address; authenticated visitors dedupe by verified actor and authors do not
self-increment. Neither cookie scope nor backend ownership is widened.

This fixes #322 and the related view-cookie omission, **not all of #314**. Separate
session/user refresh buckets, the 121-session acceptance case and automatic-
refresh 429/Retry-After behavior remain follow-up work. Refresh coordinator keys,
explicit-refresh single-flight and cross-instance coordination (#324/#318) also
remain unchanged. IP separation is not a defense against many legitimate users
behind one NAT or against distributed volumetric abuse.
