# API authentication contract

## Current behavior

The API request context is deny-by-default. A request is considered authenticated only when the server validates a signed bearer JWT and derives the actor ID from its `sub` claim. Client-provided `userId`, `senderId`, and identity headers are not authentication inputs.

The current verifier accepts **HS256** tokens only and checks all of the following:

- Bearer token input is no larger than 8 KiB before token parsing.
- Signature matches the server-configured secret.
- `iss` exactly matches `AUTH_JWT_ISSUER`.
- `aud` contains `AUTH_JWT_AUDIENCE`.
- `exp` is present and is in the future.
- Optional `nbf` is numeric and has passed.
- `sub` is a non-empty string.
- `jti` is a non-empty unique session identifier; the verifier returns it with the session expiry so the current session can be revoked durably.

A missing token or invalid token leaves `context.user` unset; private resolvers must then return an `UNAUTHENTICATED` error. If a secret is configured but is shorter than 32 bytes, or issuer/audience configuration is incomplete, the verifier fails closed with a configuration error.

## Runtime configuration

Configure these values in the API deployment's secret/environment configuration, never in source control:

- `AUTH_JWT_SECRET`: high-entropy secret of at least 32 bytes, shared only with the trusted token issuer.
- `AUTH_JWT_ISSUER`: exact expected issuer identifier.
- `AUTH_JWT_AUDIENCE`: exact API audience identifier.

Do not reuse the test fixture values. Do not log bearer tokens or secrets. Use HTTPS for all non-local traffic.

## Compatibility boundary

This verifier establishes a server-side authentication boundary; it does **not** by itself integrate with the legacy login/token issuer. Before enabling it in a deployed environment, confirm the issuer's algorithm, claims, key-management strategy, expiry semantics, and token revocation/session policy. If the legacy issuer does not mint tokens meeting this contract, implement a deliberate adapter or migrate issuance first—do not weaken validation or trust a client-supplied identity to make tokens appear compatible.

The current `viewer` query is a small integration slice. The API also exposes `revokeCurrentSession`, which records the authenticated JWT `jti` through its expiry; subsequent requests with that token are rejected when PostgreSQL persistence is configured. Domain mutations and reads still need to call shared authentication/ownership/participant guards before they are considered protected.


## Authorization integration status

The shared guard functions are implemented and unit-tested, and `viewer` is the only private resolver currently wired to the authenticated-actor guard. The owner and conversation-participant checks are reusable primitives, **not proof that domain resources are already protected**. Before exposing blog, profile, follow, conversation, message or read-state operations, each resolver must load authoritative resource/membership data and invoke the relevant guard before returning private data or applying mutations. Rejected mutation tests must verify that no persistent side effects occurred.

Durable revocation and resource membership checks require an approved persistence adapter; do not add a process-local session or membership map as a production substitute.
