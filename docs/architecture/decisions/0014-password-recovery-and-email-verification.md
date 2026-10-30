# ADR 0014: Password recovery and email verification

- Status: Accepted
- Date: 2026-10-30
- Scope: The two account transitions ADR 0008 left open, **except** outbound mail delivery

## Context

ADR 0008 chose project-owned account authentication in the standalone API and listed, in
"Consequences and remaining gates", what that decision does not solve: unverified registration,
password recovery, MFA, account disablement, key rotation and deployment. `behavior-baseline.md`
records the same gap: users can register, sign in, refresh and log out, while recovery and email
verification remain open.

Both transitions need the same three things, and none of them existed:

1. **A way to prove the request came from the mailbox.** A password reset is a credential handover;
   the only thing standing between "I forgot my password" and "I took over an account" is whether
   the link reached the address on the account.
2. **A place to put a one-time token.** Nothing in the schema holds a single-use credential other
   than the refresh family, which is scoped to sessions and must not be reused for this.
3. **A way to send the mail.** There is no outbound-mail infrastructure, and ADR 0012 forbids
   provider-specific code until a hosting candidate has passed the zero-cost/no-card gate.

## Decision

**1. One table serves both transitions.** `auth_identity_tokens` holds the digest of a token, its
purpose (`password_reset` or `email_verification`), the address it was issued for, an expiry and a
consumed stamp. Only the SHA-256 digest is stored, exactly as with refresh credentials: a dump of
this table must not let anyone reset a password.

**2. Recovery never reveals whether an address has an account.** `POST /api/v1/auth/forgot-password`
answers `202` with the same body whether or not the address exists, and only does the work (issue,
mail) when there is an account to do it for. Registration already answers a duplicate address with a
conflict and therefore leaks which addresses have accounts — this endpoint is the one an attacker
would actually automate, so it does not repeat the mistake.

**3. A recovered account is held to registration's password rules, and every session ends.**
`resetPassword` requires the twelve-character minimum (a recovered account is being handed a brand
new credential), and revokes every session of the user. The second half is the point of the whole
exercise: without it, changing the password leaves the session that was already stolen signed in for
the rest of the refresh lifetime.

**4. Verification is requested by the signed-in account holder, and the token is redeemed by
anyone who has the mail.** `POST /api/v1/me/email-verification` is authenticated and addressed to
the address already on the account — an unauthenticated version would let anyone aim mail at any
address in the database. `POST /api/v1/auth/verify-email` consumes the token.

**5. Verification gates nothing.** It records that an address was reachable, and that is all. ADR
0008 declares email an unverified login identifier; making proof of it a precondition for signing
in, publishing or commenting would lock every existing account out the moment the flag flipped.
What verification is for — and whether it should ever gate anything — is a product decision, not a
transport one.

**6. The token travels in a request body, never in a path.** Paths are logged by proxies, CDNs and
browsers. The mail links to a page (`/reset-password?token=…`, `/verify-email?token=…`), and the
page posts the token back.

**7. Outbound mail is a port, and the only implementation is a logging one.** `identity-mailer.ts`
defines `IdentityMailer`; `createLogMailer` writes a structured log line and, by default, **not the
link** — a log line that can reset somebody's password is a password reset waiting to be read by
whoever reads the logs. `AUTH_IDENTITY_MAIL_LOG_LINK=1` opts in for local development. No SMTP or
provider driver exists yet, by ADR 0012.

**8. Throttling reuses the identity service's existing keyed-digest limiter.** No new mechanism:
20/hour per address for recovery requests (5/hour per email), 20/15min per address for resets
(5/15min per token), 30/15min for verification redemptions, 5/hour per account for re-sending.

## Consequences and remaining gates

- **Recovery is not usable in production yet.** The mechanism is complete and tested; the last mile
  is not. Until a provider adapter exists behind the port, the mails are log lines. This is a
  deliberate, documented state rather than a stub — the alternative is provider code written before
  the hosting decision that would have to be rewritten.
- **Every device signs out on a password change.** This is intended and must be explained to users:
  the page that confirms the change should say so.
- **A reset link is live for thirty minutes and works once**; verification links last a day and work
  once. Issuing a new link supersedes the outstanding one for that purpose, so there is never more
  than one live link per purpose per account.
- **Account enumeration at registration is unchanged**, and remains open (ADR 0008).
- Still open, unchanged by this decision: MFA, account disablement, signing-key rotation, audit and
  alerting, and the provider adapter itself.

## Implementation status

- Migrations `0020_identity_verification.sql` and `sqlite/0012_identity_verification.sql`.
- Store port methods: `issueIdentityToken`, `consumeIdentityToken` (atomic single use),
  `setIdentityPassword`, `revokeIdentitySessions`, `markIdentityEmailVerified`,
  `findIdentityAccountByUserId`; expired tokens are swept by `pruneExpiredIdentityState`.
- Routes: `POST /api/v1/auth/forgot-password` (202), `POST /api/v1/auth/reset-password`,
  `POST /api/v1/auth/verify-email`, `POST /api/v1/me/email-verification` (202).
  `GET /api/v1/me` now returns `{ id, email, emailVerifiedAt }` — additive fields only.
- Covered by identity service unit tests, adapter-contract tests on SQLite and PostgreSQL, and HTTP
  tests for the enumeration answer, single use, session revocation and the unauthenticated case.
