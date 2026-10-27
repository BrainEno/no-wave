# ADR 0008: Self-hosted identity in the independent API

- Status: Accepted
- Date: 2026-10-28
- Scope: Initial backend account/session authority; not a production-readiness approval

## Context

The API previously verified compatible JWTs and revoked a presented `jti`, but it had no issuer or complete login/refresh lifecycle. The previous product registered accounts with email and password, issued access/refresh credentials and did not require email verification during registration. The Web and API must remain independently deployable, and client-supplied IDs must not establish identity.

## Decision

The product owner selected **project-owned account authentication in the standalone API**, rather than integrating an external OIDC provider or relying on an unspecified existing issuer. The initial REST contract supports registration, password login, access token issuance, rotating refresh credentials with reuse detection, and per-session logout. Preserve the existing verifier and transitional GraphQL authorization/revocation behavior. Email remains an **unverified login identifier**, not proof of ownership; no legacy accounts, tokens or data are automatically imported. The API returns credentials to the client as JSON rather than setting a browser cookie; browser integration and storage are separate work.

Persist only salted password hashes, refresh-token hashes, access-token identifiers and session state. Use database transactions to serialize refresh, replay and logout, and fail closed when revocation or issuer configuration cannot be established. Add bounded durable throttling and regression tests without trusting forwarding headers supplied by clients.

## Consequences and remaining gates

A replay or concurrent use of the same refresh credential revokes its whole session; clients must serialize refresh and handle lost responses by signing in again. Registration returns a conflict for an existing identifier and therefore does not resist account enumeration. Unverified registration, password recovery/change, MFA, account disablement, signing-key rotation, stronger abuse controls, audit/alerting, browser storage/CORS and deployment are not solved by this decision. They require separate review before production use. Compatible independent JWTs remain trusted under the existing key/issuer policy; the API cannot revoke a refresh family it did not issue. See [API authentication](../api-authentication.md) for the exact contract and rollout constraints.
