# ADR 0018: An access token names its session, and a password change is one operation

- Status: Accepted
- Date: 2026-11-01
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

A token minted before `sid` existed is still accepted; its `sessionId` is `null`, which a caller
must read as *unknown*, never as a value that might match something. `changePassword` then spares
nothing: the safe direction, bounded by the access token's own lifetime.

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
sessions, sign out that one — remains unbuilt (see
[`docs/api/platform-capability-backlog.md`](../../api/platform-capability-backlog.md)) and will need
a port method of its own.

## Consequences

- No client change. The token format gained a claim; existing tokens still verify, and the route
  surface, status codes and response bodies are unchanged.
- `PUT /api/v1/me/session` (logout) now blacklists the **token** id. It did so before by accident,
  because the token id was what `verifyBearerToken` handed out under the name `sessionId`.
- The password-change response still carries `revokedSessions`; it is now the count the transaction
  produced rather than the count of a second call.
- Tests: `authentication.test.ts` pins the two identifiers apart (a test token whose `sid` and `jti`
  are different strings, so a test that confuses them fails); the adapter contract asserts on both
  providers that a replacement spares the named session, that a reset spares none, and that a
  replacement whose write violates `NOT NULL` leaves every session signed in and the old credential
  in place; the identity service asserts one call, not two, and that a refused call changes nothing.
- Additive migration, none needed: `sid` is a claim, not a column. Deploying is a restart, and no
  user is signed out — a token without `sid` keeps working to the end of its own TTL, which is at
  most `AUTH_JWT_MAX_TTL_SECONDS`.
