# ADR 0015: Transactional mail over a generic SMTP relay

- Status: Accepted
- Date: 2026-10-31
- Scope: the last mile of ADR 0014 — how an account mail leaves the API

## Context

ADR 0014 implemented password recovery and email verification and deliberately
stopped one step short: the mailer was a port (`IdentityMailer`) whose only
implementation wrote a structured log line. The reason was ADR 0012 — no
provider-specific code until a hosting candidate has passed the zero-cost/no-card
gate. That gate has now been asked of mail itself and passes on published terms
for Brevo (see [hosting qualification §6](../roadmap/hosting-qualification.md)):
300 emails/day, no payment method, no expiry.

So the last mile is allowed, and the question is which shape it takes:

1. **A provider SDK or REST client.** Brevo and Resend both have REST APIs, and
   Resend's is about sixty lines to call. It is the smallest amount of code.
2. **A dependency that already speaks mail** — `nodemailer`, the de-facto Node
   SMTP client. Battle-tested, no protocol code of our own.
3. **A generic SMTP submission client of our own**, on `node:net`/`node:tls`.

What is actually being sent is narrow and fixed: one sender, one recipient, a
plain-text body containing a link, a few dozen messages a day at most.

## Decision

**3. A generic SMTP submission client, behind the existing port, with no new
dependency.**

1. **Submission (RFC 5321), not a provider API.** Every transactional provider
   speaks it — Brevo, Resend, SMTP2GO, a mailbox host — so the relay is an
   environment variable (`MAIL_SMTP_HOST` and friends) and not a line of code.
   Nobody has to rewrite the mailer to change provider, and no provider name
   appears in business logic, which is what ADR 0012 asks for.
2. **No new dependency.** The client is ~330 lines of `node:net`/`node:tls` in
   `apps/api/src/infrastructure/smtp-client.ts`, next to the S3 client that ADR
   0011 already accepted on the same reasoning. `nodemailer` would be less code
   *of ours* and far more code *in the process* — its surface (streams, plugins,
   DKIM signing, connection pooling) is an order of magnitude larger than one
   sender, one recipient and a text body.
3. **TLS is mandatory by default.** `MAIL_SMTP_SECURITY` defaults to `starttls`,
   and a server that does not advertise STARTTLS is refused before any credential
   is sent. An unrecognized value falls back to `starttls`, not to `none`: a typo
   must not quietly put a password on the wire. Certificate verification is never
   disabled, so a relay reached by IP address fails rather than being trusted.
4. **Only ASCII goes on the wire.** The subject is an RFC 2047 encoded word and
   the body is base64, so Chinese subjects survive without negotiating 8BITMIME or
   SMTPUTF8, and a newline in the body cannot become a header.
5. **Addresses are re-validated at the boundary.** `MAIL FROM` and `RCPT TO` are
   where SMTP injection lives: a newline in an address is arbitrary commands on
   the socket. The identity service already validated the address; the client
   checks it again, and rejects control characters before it checks the shape.
6. **The log mailer remains the default.** Without `MAIL_SMTP_HOST` and
   `MAIL_FROM` the API still logs instead of sending. An instance that has not
   finished setting up recovery must not start mailing people.
7. **A delivery failure is logged, never fatal.** The token is already committed
   when the mail is sent, so a relay outage must not turn into a failed request —
   but it is now logged as `identity_mail_failed` with the purpose and the error
   code, because before a relay existed a swallowed error cost nothing and now it
   would hide a broken recovery flow for weeks. The address is deliberately absent
   from that line.

## Consequences and remaining gates

- **The protocol code is ours.** It implements only EHLO, STARTTLS, AUTH
  PLAIN/LOGIN, MAIL FROM, RCPT TO, DATA and QUIT; anything a relay says that it
  does not expect is an error, not a surprise. There is no pipelining, no
  connection reuse, no `BDAT`.
- **No queue, no retry, no bounce handling.** A send either succeeds on the
  socket or is logged and dropped. Recovery survives that — the user asks again
  and gets a fresh link — but a relay that is down is only visible in the logs.
- **Deliverability is the provider's job and the operator's.** SPF, DKIM and
  DMARC, a verified sender address, and a real `MAIL_FROM` domain are
  configuration, not code, and account mail will land in spam without them.
- **Brevo's free ceiling is 300/day.** The identity throttle (5/hour per address,
  20/hour per peer) keeps this site far below it, but a burst of retries during a
  mail outage is a daily quota, not a monthly one — that is why Brevo was chosen
  over Resend's 100/day cap.
- **A real delivery has still not been observed.** The gate passed on published
  terms; no account was created and no credential ever enters the repository. The
  first real send is a deployment step, not a code step.
