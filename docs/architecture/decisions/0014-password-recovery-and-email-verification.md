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

- **Mail is a switch, and it is off by default.** `MAIL_ENABLED` gates every
  feature that would put a link in an inbox. Off, the API answers `503
  MAIL_DISABLED` for `POST /api/v1/auth/forgot-password` and `POST
  /api/v1/me/email-verification` — no token issued, no rate limit spent, and the
  same answer for every address, so a switched-off recovery cannot become an
  enumeration oracle — and the Web tier stops rendering the pages and buttons
  that lead to them. Both processes read the same variable, at request time, so
  they cannot disagree and switching it needs no rebuild. The reason it exists
  is that the rest of this decision deliberately gates nothing: an unverified
  account already signs in, writes and publishes, so "mail is off" must mean
  "these two buttons are gone", not "this account is broken". A configured relay
  is not consent — `MAIL_SMTP_HOST` alone never switches mail on.
- **Recovery was shipped without the last mile and now has one.** Until ADR 0015 the mails were log
  lines: deliberate, because ADR 0012 forbids provider code before the zero-cost/no-card gate, and
  the gate had not been asked of a mail provider. It has now ([hosting qualification
  §6](../roadmap/hosting-qualification.md)), and [ADR 0015](0015-transactional-mail-over-a-generic-smtp-relay.md)
  wires a generic SMTP submission client behind the port. What remains is an operator's step, not a
  developer's: configure a relay, verify a sender, and send a real mail.
- **Every device signs out on a password change.** This is intended and must be explained to users:
  the page that confirms the change should say so.
- **A reset link is live for thirty minutes and works once**; verification links last a day and work
  once. Issuing a new link supersedes the outstanding one for that purpose, so there is never more
  than one live link per purpose per account.
- **Account enumeration at registration is unchanged**, and remains open (ADR 0008).
- Still open, unchanged by this decision: MFA, account disablement, signing-key rotation, audit and
  alerting, and the provider adapter itself.

## Web surface

The API is only half of a recovery: the mail has to land somewhere a person can
use. Three pages close the loop, at the paths `identityLink()` already emits.

| Page | What it does |
|---|---|
| `/forgot-password` | asks for a link. Says the same thing whatever the address is, because the API does. With mail off, says that instead of showing the form. |
| `/reset-password?token=…` | sets a new password, then tells the visitor they have been signed out everywhere |
| `/verify-email?token=…` | redeems the link once, on arrival |
| `/account` | the account's own page: email, verification state, "send the mail again" (with mail on), sign out — reachable from the site navigation |

- **The token comes out of the query string and goes back in a request body.**
  Mail can only carry a URL, so the query string is forced on us; the path the
  browser then posts to is not, and paths are what proxies and browsers log.
- **Redeeming is a POST, never a page render.** A verification link that worked
  because someone merely loaded a page would also work for a mail scanner, a
  link previewer and a corporate proxy that fetches links "for safety".
- **`/account` is the account's own page, and the desk keeps its account line.**
  It used to deny every request on the correct grounds that a client-supplied
  header is not proof of identity; what was missing was anything that *is*. The
  token cookies are scoped below `/`, so a page render cannot read them, and the
  page now gates on `nw_session` — an `HttpOnly` cookie scoped to `/` that
  carries the moment the session can no longer be renewed and no credential at
  all. It decides only between "redirect to sign-in" and "render the shell"; the
  account itself is read from `GET /api/authoring/session` by the shared
  `AccountPanel`, which is the request that can actually present the token to the
  API. Both frameworks render the same component, so the verification state and
  its "send the mail again" action exist in one place.
- **The proxy shuttles these through the shared `web-http` seam**, so the React
  Router prototype's one-line `api.auth.ts` supports them without being touched.
  Recovery and verification are deliberately *not* put through the token
  machinery: they answer `{ data: { ok: true } }`, not a token envelope, and the
  envelope check would turn every one of them into a 502. The one cookie rule
  they do have is that a **successful** reset clears the session cookies — the
  API just revoked those sessions, and leaving them behind turns a recovery into
  "still signed in as whoever refetched first". A *rejected* reset clears
  nothing, because nothing was revoked.
- **Not yet in the prototype, therefore not yet in `e2e`.** The e2e spec runs
  one file against both frameworks and only uses routes both serve, so a browser
  test for this journey waits for the pages to exist in `apps/web-rr` — a
  separate decision, since the prototype exists to de-risk the public SSR
  migration and these are noindex account pages. Until then the journey is
  covered by the proxy contract tests, the route smoke checks (each page renders,
  with and without a token) and the manual loop below.

**How to walk the whole loop locally** without a mail provider: start the API
with `AUTH_IDENTITY_MAIL_LOG_LINK=1` and `AUTH_IDENTITY_BASE_URL` pointing at the
web app; the log mailer then writes the link itself as a structured `identity_mail`
line. Copy the token out of the log, open the page, and the rest is the real
journey — including the parts that only exist once mail is real (single use,
expiry, superseded links, session revocation).

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
- Switch: `MAIL_ENABLED` — `isMailEnabled` in `apps/api/src/application/identity-mailer.ts` and
  `apps/web/src/lib/mail-feature.ts` (two copies on purpose: the API must not depend on a Web
  package; both are tested against the same contract). Covered by identity unit tests, HTTP tests
  over `/api/v1/auth/forgot-password` and `/api/v1/me/email-verification`, the route smoke checks
  (mail off and, on a second server, mail on) and the prototype's switch tests.
  `/forgot-password`, `/reset-password` and `/verify-email` are `force-dynamic`: as static
  prerenders they baked the build's answer into the HTML, so flipping the switch changed
  nothing until a rebuild — the F4 trap (`NEXT_PUBLIC_SITE_URL`) again, one layer down.
- Web: `/forgot-password`, `/reset-password`, `/verify-email`, `/account` (shared `AccountPanel`:
  email, verification state, resend, sign-out), the account line in the writing desk,
  the widened `/api/auth/[action]` family and `POST /api/authoring/email-verification`, covered by
  `web-http` proxy contract tests, the prototype's account tests and the route smoke checks.
- Session marker: `nw_session` (`packages/web-http/src/cookies.ts`) — `Path=/`, `HttpOnly`,
  `SameSite=Lax`, value = the refresh expiry in unix seconds, set and cleared with the token
  cookies. Covered by `packages/web-http/test/cookies.test.ts`.
- Delivery: `apps/api/src/infrastructure/smtp-client.ts` (submission client) and
  `createSmtpMailer`/`resolveSmtpMailerConfig` in `application/identity-mailer.ts`, covered by unit
  tests over a scripted peer and by an end-to-end test against a loopback relay that decodes the
  delivered message. The default is still the log mailer.
