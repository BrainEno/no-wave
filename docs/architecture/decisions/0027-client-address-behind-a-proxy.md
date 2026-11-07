# ADR 0027: The client address is the socket peer unless the deployment names its proxies

- Status: Accepted
- Date: 2026-11-07
- Relates to: audit F-21 ([full review 2026-11-02](../../audit/full-review-2026-11-02.md));
  ADR 0011 ([persistent write rate limits](0011-persistent-api-write-rate-limits.md));
  [API authentication contract](../api-authentication.md)

## Context

Every per-client decision in the API reads one string:

- the `ip` half of every write rate-limit policy (ADR 0011);
- the `login`, `register`, `refresh` and `logout` attempt windows in the identity
  service;
- the address recorded and shown for each session in `GET /api/v1/me/sessions`.

That string came from `request.socket.remoteAddress`, and `X-Forwarded-For` was
deliberately ignored. The reasoning was sound: the header is written by the
client, and a client that can choose its bucket has no bucket at all.

The reasoning is only sound on a host where the process sees the visitor. On
every deployment this project actually has — Render, Fly, a container behind
nginx, a Vercel container behind the platform router — the socket peer is **the
proxy**. Everything above degrades quietly rather than loudly:

| Decision | Behind a proxy, with the peer as the client |
| --- | --- |
| Write limits | one shared IP bucket for every visitor: one noisy client throttles everyone |
| Login / register / refresh | one shared attempt window: an attacker can exhaust it and lock out the site, or hide inside it |
| Session list | every device says it is at the same address |

None of these fail a request, log a warning or appear in a metric. The limits are
simply not in force, and the deployment looks healthy.

## Decision

### 1. The socket peer stays the default, and the header stays ignored

`TRUSTED_PROXY_HOPS` is `0` unless an operator sets it. At `0` the behaviour is
exactly what it was: `X-Forwarded-For` is never read. A deployment that does not
have a proxy cannot acquire this bug by upgrading, and a client can never name its
own bucket.

### 2. The operator names the number of proxies, not the header

`TRUSTED_PROXY_HOPS` is an integer from `0` to `5`:

- `1` — one proxy between the visitor and this process (Render, Fly, nginx,
  `docker run -p`, a Kubernetes ingress whose own peer address is not exposed);
- `2` — two, e.g. a CDN in front of an ingress.

The address is taken **that many entries from the right** of the forwarded chain.
That position is the one the outermost trusted proxy appended; every entry to its
left is whatever the client (or an untrusted hop) wrote, and is ignored. An
attacker who prepends a thousand addresses does not move the position.

### 3. An unusable configuration fails at startup

An empty value means "not configured" (`0`). Anything that is not an integer in
range — `true`, `1.5`, `-1`, `6` — throws a `RangeError` while the server is being
composed, so the process does not start. Silently falling back to `0` would leave
the operator believing the proxy is handled while every visitor shares a bucket:
the exact state this ADR exists to end.

### 4. A chain shorter than the configuration is not trusted

If fewer forwarded entries arrive than the configured number of hops, the request
did not come through the described infrastructure. The socket peer is used. The
rule everywhere is the same: when the configuration and the request disagree, take
the safer of the two, never the more specific one.

### 5. The address is normalized, and "unknown" is one honest bucket

`::ffff:192.0.2.10` becomes `192.0.2.10`, and a source port appended by a proxy
(`192.0.2.10:51234`, `[2001:db8::1]:443`) is removed, so the same client is the
same bucket whatever shape its address arrived in. A request that cannot be
attributed at all is `unknown` — one shared bucket, which is the honest answer for
"we do not know", and the placeholder the API already used.

### 6. The resolution happens once, in the request context

`clientAddressFor()` runs in `createRestHandler`, and routes read
`ctx.clientAddress`. No route derives an address of its own, so the forward-header
policy cannot drift between the rate limiter, the identity service and the session
list.

## Consequences

- A deployment behind a proxy has to set one variable. The value is documented in
  [`apps/api/README.md`](../../../apps/api/README.md) and the ADR is the reasoning;
  without it, the deployment keeps the old (wrong) behaviour rather than a guessed
  one.
- Setting it **higher** than the real number of proxies is a self-inflicted
  vulnerability: the trusted position then lands on an entry a client controls. The
  bound of 5 is not a safety guarantee; the number has to describe the deployment.
- The address is not authentication. It is a throttling key and a display string;
  nothing authorizes on it, and a misconfigured hop count cannot grant access —
  it can only misattribute a bucket.
- `TRUSTED_PROXY_HOPS` does not make the API trust `X-Forwarded-Proto` or
  `X-Forwarded-Host`. Redirect and origin decisions still come from configuration
  (`AUTH_IDENTITY_BASE_URL`, the Web tier's dev-origin allowlist), not from
  headers.
- The Web tier does **not** forward the visitor's address to the API today
  (`packages/web-http/src/forward.ts` sends `accept`, the bearer token and the
  idempotency key). In the BFF deployment the API therefore charges the Web
  server, and the anonymous write bucket is shared no matter what
  `TRUSTED_PROXY_HOPS` says; the setting applies to deployments where the
  visitor's address reaches the API itself — a direct API deployment behind one
  proxy. Forwarding from the Web tier is a separate change, because it raises the
  same question one tier earlier (which proxy may the Web server believe) and is
  not implied here.
- This does not add the session-scoped `refresh` bucket that audit F-21 also
  lists. That is a separate limit on a separate key and it is not implied here.
