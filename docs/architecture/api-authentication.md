# API authentication contract

## Current verification behavior

The API treats bearer credentials as authenticated only after server-side JWT validation and durable session-revocation checks. The actor ID comes exclusively from the verified `sub` claim; client-supplied `userId`, `authorId`, `actorId`, `senderId`, and identity headers are not trusted as authentication inputs.

The verifier accepts a compact JWS with the fixed `HS256` algorithm and the application-specific header type `application/vnd.bot-thk.access+jwt`. It rejects `none`, unsupported algorithms, malformed/non-canonical base64url segments, detached-payload or critical header extensions, oversized bearer values, and malformed claims.

Required configuration and claims:

- `AUTH_JWT_SECRET`: server-only secret of at least 32 bytes; production values must be generated with a cryptographically secure random source and never committed or logged.
- `AUTH_JWT_ISSUER`: required exact match for `iss`.
- `AUTH_JWT_AUDIENCE`: required audience contained in `aud`.
- `iat`: required integer NumericDate; it cannot be in the future.
- `exp`: required integer NumericDate; it must be in the future and later than `iat`.
- Access-token lifetime: `exp - iat` must not exceed `AUTH_JWT_MAX_TTL_SECONDS`, default `900` seconds (15 minutes). The server setting accepts integers from 60 through 86400 seconds.
- `nbf`: optional integer NumericDate; if present it must have passed and precede `exp`.
- `sub`: required non-empty, whitespace-stable stable user ID.
- `jti`: required non-empty, whitespace-stable per-session identifier used for revocation.

The standard `exp` check was present before this hardening; the additional `iat` and maximum-lifetime checks prevent an issuer mistake from creating an arbitrarily long-lived access token. An accepted `exp` is not a refresh-token strategy: access-token renewal and refresh-token rotation must be designed separately.

## Session revocation and route authorization

Protected REST and GraphQL requests check the token's `jti` against durable persistence. If a session is revoked, the request is unauthenticated. If the revocation query is absent or fails, the request fails closed instead of treating a valid signature as sufficient authorization. `DELETE /api/v1/me/session` and the transitional GraphQL `revokeCurrentSession` mutation revoke the current `jti` through the token's expiry.

REST endpoints derive actor identity from verified JWT claims, then call the application-service facade. Domain/persistence layers continue to enforce ownership, conversation membership, same-article reply relationships, recipient scoping and transactional notification behavior. The current REST route and field coverage is inventoried in [REST–GraphQL parity audit](../audit/rest-graphql-parity.md).

Public reads stay public. If a public endpoint accepts an optional bearer token, it uses viewer-specific state only after successful validation and revocation checking; invalid or revoked optional credentials do not confer viewer privileges.

## Standards boundary and issuer compatibility

The header type `application/vnd.bot-thk.access+jwt` is intentionally application-specific. This custom verifier is **not a claim of full RFC 9068 OAuth JWT access-token-profile conformance**: it currently validates HS256 using a shared secret, does not require the RFC 9068 `client_id` claim, and the repository does not implement an OAuth authorization server or token endpoint. The separate OAuth profile uses the distinct `at+jwt` type and has additional interoperability requirements. Do not replace the private type with `at+jwt` unless the project deliberately adopts and implements that profile end to end.

If the trusted issuer is deployed separately from the resource server, prefer an asymmetric signing and key-discovery design (for example, a reviewed JWKS integration) so the API does not need a key that can also mint tokens. Keep issuer, audience, type, key rotation and token lifetime aligned across issuer and validator.

## Incomplete login/session work

The repository currently provides **JWT verification and current-session revocation**, not a complete login lifecycle. The following still need explicit design and tests before production account authentication is claimed complete: token issuance, sign-in/out integration, refresh-token rotation and reuse detection, password reset/recovery invalidation, account disablement semantics, brute-force/abuse throttling, signing-secret/key rotation, client token storage and (if cookies are used) CSRF policy. Do not weaken token validation or trust a client-supplied identity to accommodate a mismatched legacy issuer.

Use HTTPS for all non-local traffic. Never reuse test fixtures in deployments, and never log bearer tokens or signing secrets.
