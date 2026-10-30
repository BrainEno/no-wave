# API authentication contract

## Status and trust boundary

The product owner selected **self-hosted account authentication in the standalone API**. The API now provides email/password registration and login, short-lived access tokens, one-time refresh-token rotation with reuse detection, and session logout. No Web framework, cookie, browser storage or external identity service is coupled to these operations. This is an initial backend lifecycle, **not a production-ready account system**: email verification, recovery, account administration and several operational controls below remain open.

The API derives the actor exclusively from the verified `sub` claim; client-supplied `userId`, `authorId`, `actorId`, `senderId`, and identity headers do not establish identity. Protected REST and transitional GraphQL requests additionally check durable revocation state and fail closed if that check fails. Domain services still enforce resource ownership, membership and recipient scoping.

## HTTP contract

All routes require `Content-Type: application/json`, accept only the named fields, limit the body to 4 KiB, return `Cache-Control: no-store`, and never set a cookie:

| Method and path | Request | Success |
| --- | --- | --- |
| `POST /api/v1/auth/register` | `{ "email": "…", "password": "…" }` | `201` and token set |
| `POST /api/v1/auth/login` | `{ "email": "…", "password": "…" }` | `200` and token set |
| `POST /api/v1/auth/refresh` | `{ "refreshToken": "…" }` | `200` and rotated token set |
| `POST /api/v1/auth/logout` | `{ "refreshToken": "…" }` | `200` and `{ "data": { "ok": true } }`, including for an unknown or already-revoked well-formed token |
| `DELETE /api/v1/me/session` | Bearer access token | Revokes the current self-hosted session family, or the presented `jti` for an independently issued token |

A token set is `{ "data": { "accessToken", "tokenType": "Bearer", "accessExpiresAt", "refreshToken", "refreshExpiresAt" } }`; times are UTC ISO 8601 strings. Use `Authorization: Bearer …` for protected REST/GraphQL requests. Registration creates a stable random user ID; a public profile is configured separately. Email is trimmed and lowercased; currently only the documented practical ASCII email subset is accepted (one `@`, no whitespace, conventional local characters and DNS labels). A new password must contain 12–128 Unicode characters and at most 512 UTF-8 bytes; passwords are not trimmed or normalized.

Malformed input returns `400`, incorrect login credentials and invalid/expired/reused refresh credentials return generic `401`, duplicate normalized registration returns `409`, and throttling returns `429` with `Retry-After` seconds. Unsupported media, oversized bodies and methods return `415`, `413` and `405`. Misconfigured issuer or missing persistence returns `503`; unexpected persistence failures are sanitized `500` responses. Login does not distinguish an unknown account from a wrong password and performs a dummy password derivation for unknown accounts. **Registration's `409` does reveal that an identifier is unavailable**; do not claim account-enumeration resistance.

## Credentials and session lifecycle

- Passwords are salted independently and hashed using Node's scrypt (`N=32768`, `r=8`, `p=3`, 64-byte output). The database never stores plaintext passwords.
- An access token has a new random `jti` on every issuance. It lasts at most 15 minutes, or less when `AUTH_JWT_MAX_TTL_SECONDS` is lower or the session is nearer its absolute expiry. Only token IDs and expiry timestamps are retained, not the access token.
- A session has an absolute 30-day expiry, not a sliding lifetime. Each refresh credential is 32 random bytes, encoded as canonical unpadded base64url; only its SHA-256 hash is stored. Rotating atomically consumes the old credential, issues a new one and records a new access-token ID.
- Reusing any consumed refresh credential before session expiry atomically revokes **the whole session family**, including every unexpired access token issued to that session. Concurrent refreshes with the same token therefore yield at most one success, and the subsequent reuse invalidates even the winning token. Serialize refreshes in clients: there is no grace window or retry idempotency. A lost refresh response or a duplicate request can require a fresh login.
- Logout by refresh token, `DELETE /api/v1/me/session`, and transitional GraphQL `revokeCurrentSession` serialize with rotation and revoke the whole mapped self-hosted family. Other separately logged-in sessions remain active. An older independently issued JWT has no mapped refresh family: only its own `jti` can be revoked locally; the external issuer's refresh credentials are not controlled by this API.
- The worker/API retain consumed refresh hashes until their session expires so replay can be detected. Every 128 authentication rate-limit operations, bounded opportunistic maintenance removes at most 100 sessions expired for more than 24 hours **only if none of their recorded access tokens is still valid** (cascading their token rows), 512 expired rate-limit rows, and 512 `revoked_sessions` rows whose `expires_at` has passed. Removing an expired revocation is safe because session verification only treats rows with a future expiry as active; the cleanup rechecks expiry at deletion time. Quiet installations can retain expired rows until subsequent traffic.

## Token verification and issuer compatibility

The verifier accepts compact JWS using fixed `HS256` and application-specific header type `application/vnd.bot-thk.access+jwt`. It rejects `none`, unsupported algorithms, malformed/non-canonical base64url, detached-payload or critical extensions, oversized bearer values and malformed claims. Required configuration and claims:

- `AUTH_JWT_SECRET`: server-only, at least 32 UTF-8 bytes, generated with a cryptographically secure random source and never committed or logged.
- `AUTH_JWT_ISSUER` and `AUTH_JWT_AUDIENCE`: exact issuer and expected audience; both are required.
- `iat` and `exp`: integer NumericDate, `iat` not in the future, `exp` in the future and later than `iat`. The verifier limits `exp - iat` to `AUTH_JWT_MAX_TTL_SECONDS` (default 900, configurable 60–86400 seconds); the new issuer never emits more than 900 seconds.
- `nbf`: optional integer NumericDate, already active and before `exp`.
- `sub` and `jti`: required nonempty, whitespace-stable identity and token identifiers. The legacy internal field named `sessionId` holds the JWT `jti`.

The existing verifier contract is unchanged; a pre-existing independently issued JWT with the same configured key, issuer, audience, type and required claims continues to work. Legacy tokens with `_id` instead of `sub`, missing issuer/audience/type/issuance claims or `tokenVersion` semantics are **not** silently accepted, linked or migrated; see [legacy compatibility](legacy-token-compatibility.md). Anyone holding the shared HS256 secret can mint trusted tokens, including tokens impersonating self-hosted IDs. A separate issuer is therefore a fully trusted minting authority, not an isolated identity provider.

This private type and custom endpoint are **not** a claim of RFC 9068 or OAuth/OIDC authorization-server conformance. Do not change the type to `at+jwt` without implementing that profile. Key rotation/JWKS and independent issuer integration require a separate design.

## Recovery and verification

See [ADR 0014](decisions/0014-password-recovery-and-email-verification.md) for the reasoning; this
is the contract.

| Route | Body | Answer |
|---|---|---|
| `POST /api/v1/auth/forgot-password` | `{ email }` | `202 { data: { ok: true } }` — the same answer whether or not the address has an account |
| `POST /api/v1/auth/reset-password` | `{ token, password }` | `200 { data: { ok: true } }`; `401` for a token that was never issued, is spent or is expired; `400` for a malformed token or a password under 12 characters |
| `POST /api/v1/auth/verify-email` | `{ token }` | `200 { data: { ok: true } }`; `401` for a spent or unknown token |
| `POST /api/v1/me/email-verification` | – (authenticated) | `202 { data: { ok: true, alreadyVerified } }`; `401` unauthenticated |

- Only the SHA-256 digest of a token is stored, with its purpose, the address it was issued for, an
  expiry and a consumed stamp. A reset link lives 30 minutes, a verification link 24 hours, and each
  works exactly once. Issuing again supersedes the link already out.
- A successful password reset revokes **every** session of that account. Users are signed out
  everywhere, and the confirmation page should say so.
- The token travels in a request body, never in a path: paths are logged by proxies and browsers.
  The mail links to a page, and the page posts the token back.
- `GET /api/v1/me` returns `{ id, email, emailVerifiedAt }` (additive fields only).
- Outbound mail goes through the `IdentityMailer` port. The shipped implementation is a structured
  log line, and it does not write the link unless `AUTH_IDENTITY_MAIL_LOG_LINK=1`. No provider
  adapter exists, by ADR 0012, so **recovery is not production-usable until one is added**;
  configure `AUTH_IDENTITY_BASE_URL` for the public origin the links point at.
- Throttling reuses the keyed-digest limiter: 20 per socket peer and 5 per email per hour for
  recovery requests, 20 per peer and 5 per token per 15 minutes for resets, 30 per peer per 15
  minutes for verification redemptions, and 5 per account per hour for re-sending a verification.

## Abuse controls and deployment limitations

Fixed-window counters are shared through the database and keyed by a domain-separated HMAC, not raw email/IP. Validated registration is limited to 20 attempts per socket peer and five per email per hour; login to 60 per peer and five per email per 15 minutes; refresh and logout each to 120 per peer per 15 minutes. Both successful and failed attempts consume quota. The peer comes only from the socket; **client-supplied `X-Forwarded-For` is ignored**. Behind a reverse proxy, many users may share one bucket. Provide a reviewed trusted-proxy/edge rate-limit design and account for distributed abuse before public deployment; the present controls do not cover all registration abuse, per-session rotation volume or volumetric DoS. Synchronize API and database clocks.

Email is a login identifier, as in the historical registration flow, and it can now be **verified** — see [ADR 0014](decisions/0014-password-recovery-and-email-verification.md). Verification records that an address was reachable; it **gates nothing**, so an unverified address still signs in, publishes and comments. Do not read `emailVerifiedAt` as an authorization signal.

There is no breach-password screening, MFA, account disable/delete, global session management, audit/alerting, signing-key rotation, or legacy account/data import. The API does not implement a browser token-storage strategy, trusted cross-origin CORS policy or CSRF protection for a future cookie design. Because refresh credentials are returned to the caller and sent in JSON, a browser client that exposes them to JavaScript is vulnerable to token theft via XSS; use a separately reviewed browser/BFF design. Require TLS for all non-local traffic and never log passwords, bearer/refresh tokens, cookies, authorization headers or secrets.

Before any release, stop/drain old API instances and old notification workers, apply the additive migrations under an approved backup/release plan, then start only upgraded API instances and workers. **Do not mix old and new API instances while issuing self-hosted sessions**: an older logout implementation revokes only the presented `jti`, not its refresh family. Old notification workers also lack the new delivery serialization. Rollback must first stop all components and account for the loss of these guarantees. No deployment is implied by this implementation.
