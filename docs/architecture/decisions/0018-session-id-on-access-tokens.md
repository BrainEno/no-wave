# ADR 0018: An access token names its session, and a password change is one operation

- Status: Accepted
- Date: 2026-11-01
- Amended: 2026-11-12 — #319, end the bounded no-`sid` compatibility window
- Fixes: #129 (a password change can sign out the session that made it) and #132 (a 500 can leave the
  new password behind with the old sessions still signed in)

## Context

[ADR 0008](0008-self-hosted-api-identity.md) gave the API its own
authentication, and [ADR 0014](0014-password-recovery-and-email-verification.md) added the pieces a
password transition needs: `setIdentityPassword`, then `revokeIdentitySessions`, both on the identity
port. A password change ran them in that order and passed `exceptSessionId: sessionId`, where
`sessionId` came from the verified access token.

The access token's `jti` was being used as that session id. It is not one.

A token is minted fresh on every refresh — `verifyBearerToken` returned `sessionId: claims.jti` —
while a session is the `auth_sessions` row the token was minted from, stable across refreshes.
`revokeIdentitySessions` filters `auth_sessions.id`. A `jti` never equals any `auth_sessions.id`, so
"spare this session" spared nothing, and changing your password signed out the very request that
made it (#129). The client warns about this; a warning in the client is not a fix on the server.

The same two calls carried a second, sharper defect (#132). They are independent, so nothing made
them observable together:

- the credential was written **before** the sessions were revoked;
- the revocation was a separate call, and if it failed the request answered 500 — with the new
  password already stored and every other device still signed in.

That is the one state a password change exists to prevent, and it is reachable by an ordinary
failure. Neither half can be fixed by ordering alone: with two calls there is always a window.

## Decision

**One identifier per purpose.** `signAccessToken` takes a `sessionId` and puts it in a `sid` claim
alongside `jti`. `verifyBearerToken` returns both:

- `accessTokenId` (`jti`) — what revocation is recorded against. One row per token, so signing out
  ends the credential that was presented and leaves the visitor's other devices alone.
- `sessionId` (`sid`) — the session the token was minted from. It is what "spare the session that
  proved it knew the old password" needs.

The original decision temporarily accepted tokens without `sid`, returning an unknown
`sessionId` and sparing no session. **The 2026-11-12 amendment explicitly retires that
compatibility**, rather than silently changing it: missing, empty, non-string or
whitespace-normalized `sid` now fails authentication. `jti` is never a fallback.

Issuer and verifier now use the same effective maximum lifetime:
`min(900, AUTH_JWT_MAX_TTL_SECONDS)` seconds. The configuration parser still accepts
60–86400 for configuration compatibility, but values above 900 cannot authorize
longer-lived tokens. This closes the previous 15-minute issuer / 24-hour verifier
policy split, not a claim that a signature/key compromise has been demonstrated.

More than the former maximum 24-hour lifetime has elapsed since the 2026-11-01
self-hosted issuer began issuing `sid`. Self-hosted sessions can refresh normally;
there is no database migration or new forced family revocation. An independently
operated issuer that **still** emits no `sid` or lifetimes over the effective ceiling
must be updated and allowed to drain its old access tokens before a deployment.
Otherwise those access tokens deliberately receive 401 and a fresh login/token
exchange may be necessary. This amendment is a recorded compatibility change,
not proof that any external issuer has already migrated.

**One port method.** `replaceIdentityPassword({ userId, passwordHash, exceptSessionId })` replaces
`setIdentityPassword` and `revokeIdentitySessions`. Inside a single transaction, and in this order:

1. revoke every live session of the account except `exceptSessionId`;
2. write the new credential.

It returns `{ updated, revokedSessions }`. Sessions first: if the write cannot happen, the failure
looks like "the password did not change" with the owner's other devices already signed out — an
inconvenience, and a safe one. The reverse order is the defect.

`revokeIdentitySessions` is gone rather than left behind unused. A primitive whose only callers were
these two would invite the two-step dance straight back, and the primitive is the wrong shape: it
cannot express "the credential and the sign-out happen together". Multi-device management — list my
sessions, sign out that one — is a different
guarantee (end a device now, write no credential) and got port methods of its own in
[ADR 0019](0019-device-list-without-device-fingerprints.md).

## Consequences

- No browser contract change. Current issuer tokens still verify. The amendment
  intentionally rejects the obsolete no-`sid` shape and over-ceiling external
  tokens; the route surface, status codes and response bodies are unchanged.
- `PUT /api/v1/me/session` (logout) now blacklists the **token** id. It did so before by accident,
  because the token id was what `verifyBearerToken` handed out under the name `sessionId`.
- The password-change response still carries `revokedSessions`; it is now the count the transaction
  produced rather than the count of a second call.
- Tests: `authentication.test.ts` pins the two identifiers apart (a test token whose `sid` and `jti`
  are different strings, so a test that confuses them fails); the adapter contract asserts on both
  providers that a replacement spares the named session, that a reset spares none, and that a
  replacement whose write violates `NOT NULL` leaves every session signed in and the old credential
  in place; the identity service asserts one call, not two, and that a refused call changes nothing.
- No schema migration: `sid` is a claim, not a column. Before any separately
  authorized deployment, review independent issuers as described above. Tests
  explicitly reject missing/malformed `sid`, 901-second and 24-hour access
  tokens, and accept a correctly signed 900-second token even with a legacy
  `AUTH_JWT_MAX_TTL_SECONDS=86400` setting.
