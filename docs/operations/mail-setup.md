# Account mail: off until you switch it on

Password recovery and email verification are built, shipped and **switched off**. Nothing in
this repository sends mail until an operator sets `MAIL_ENABLED` in the repository-root
`.env.local`. The transport is finished (ADR 0015); what is missing is an account with a
relay provider, and a deployment must never look like it can mail when it cannot.

This page is the whole procedure: what the switch does, what visitors see while it is off,
how to turn it on once a relay exists, and how to tell from the logs which state you are in.

## The switch

| | |
|---|---|
| Variable | `MAIL_ENABLED` |
| Off (default) | unset, empty, or anything that is not one of `true`, `1`, `yes`, `on` |
| On | `true`, `1`, `yes`, `on` — trimmed, case-insensitive, so a hand-edited `TRUE ` works |
| Where | repository-root `.env.local`. Both processes read that one file: the API through `node --env-file-if-exists`, the Web server through `apps/web/next.config.ts`. A shell export wins over the file. |
| Read | per request, by both processes. Flipping it needs a restart of the two processes, **not** a rebuild. |
| Unknown values | mean off. A typo must not switch mail on. |

Two tiers read it, and each has its own copy of the predicate: `isMailEnabled` in
`apps/api/src/application/identity-mailer.ts` and in `apps/web/src/lib/mail-feature.ts`. The
API must not import a Web package, so the two are written against the same contract and each
is pinned by its own test rather than sharing an import. `.env.example` is the operator's
version of that contract.

It is deliberately **not** `NEXT_PUBLIC_*`. Those are inlined at build time, and being able to
switch mail off without rebuilding the site is the point — which is also why
`/forgot-password`, `/reset-password` and `/verify-email` are `force-dynamic`: as static
prerenders they baked the build's answer into the HTML, so changing the variable did nothing
until a rebuild.

**A configured relay is not consent.** `MAIL_SMTP_HOST` and `MAIL_FROM` alone do not switch
mail on. A deployment can hold working credentials with the feature off.

## While it is off

| | Behaviour |
|---|---|
| `POST /api/v1/auth/forgot-password`, `POST /api/v1/me/email-verification` | `409 MAIL_DISABLED`, `{"error":{"code":"MAIL_DISABLED","message":"Account mail is not enabled on this instance."}}` |
| Rate limits, tokens | untouched. The guard runs before the limit is spent and before a token is issued: a reset token nobody can receive would make the account look recoverable when it is not. |
| `POST /api/v1/auth/reset-password`, `POST /api/v1/auth/verify-email` | unaffected. A link already in somebody's hand must still redeem. |
| Register, sign in, write, publish | unaffected. Verification is a stamp, not a gate (ADR 0014): an unverified address loses nothing. |
| Observability | `outcome: "skipped"`, `durationMs: 0`, `code: "MAIL_DISABLED"`; log `identity_mail_skipped` — "No mail was sent because account mail is switched off." Not `identity_mail_failed`: nothing failed. |
| Web: `/sign-in` | no 找回密码 link |
| Web: `/forgot-password`, `/reset-password`, `/verify-email` | `未启用邮件功能` / "Mail is off" instead of a form; no address is collected for a mail that cannot be sent |
| Web: `/account` | email address and verification state, no 发送验证邮件 action |

The refusal is a 409 and not a 202 (which would claim a mail had been sent) and not a 503 (a
switched-off feature is not an outage, "try again later" is the wrong advice, and the Web
proxy replaces every 5xx upstream body with `SERVICE_UNAVAILABLE`, so as a 503 the reason
never reached the browser).

## Turning it on

1. **Get a relay.** Brevo's free plan is the documented default: 300 mails/day, no credit
   card, plain SMTP submission. Any relay that speaks SMTP works — nothing here is
   provider-specific. (Terms checked 2026-10; verify before relying on them.)
2. **Add and verify the sender address** you will use as `MAIL_FROM` (Brevo: *Senders,
   Domains & Dedicated IPs*). A relay refuses a sender it does not know.
3. **Copy the SMTP credential.** For Brevo that is the SMTP master key, not the API key; the
   user looks like `7xxxxx@smtp-brevo.com`.
4. **Write it to the repository-root `.env.local`** — never to a tracked file:

   ```dotenv
   MAIL_ENABLED=true
   MAIL_SMTP_HOST=smtp-relay.brevo.com
   MAIL_SMTP_PORT=587
   MAIL_SMTP_SECURITY=starttls
   MAIL_SMTP_USER=7xxxxx@smtp-brevo.com
   MAIL_SMTP_PASSWORD=<smtp master key>
   MAIL_FROM=no-reply@your-domain.example
   ```

   `MAIL_ENABLED` alone, with no relay, does not send anything either: without
   `MAIL_SMTP_HOST` and `MAIL_FROM` the API falls back to the log mailer of ADR 0015, which
   records the mail and delivers nothing.

5. **Restart both processes.** No rebuild.
6. **Verify.** `/forgot-password` shows the form; send one recovery mail to an address you
   control; the API logs `identity_mail` then `identity_mail_delivered`; `/account` offers
   发送验证邮件.

## Keeping the two readers in step

Both processes read the same file, so one value normally covers both. If they are edited out
of step:

- **Web on, API off:** the page offers the form, the API answers 409, and the form says
  `这个站点没有启用邮件功能，无法发送找回密码的链接。` in the visitor's language instead of
  echoing the API's English message.
- **API on, Web off:** the endpoints send mail, but no page links to them.

Keep them equal.

## Turning it back off

Set `MAIL_ENABLED=false` (or delete the line) and restart both processes. Credentials may
stay in the file: they are simply not used. No code change, no rebuild, no migration.

## Reading the logs

| You see | State |
|---|---|
| `identity_mail_skipped` with `code: MAIL_DISABLED` | off — somebody asked for mail this instance cannot send |
| `identity_mail` followed by `identity_mail_delivered` | on, relay accepted it |
| `identity_mail_failed` with an SMTP error code | on, but the relay refused or was unreachable |
| `identity_mail` with no `delivered` and no `failed` | on, but no relay configured: the log mailer of ADR 0015 ran |

With `API_METRICS_ENABLED=true`, `api_identity_mail_deliveries_total{purpose,outcome}` counts
the same three outcomes — `sent`, `failed`, `skipped` — and
`api_identity_mail_delivery_duration_ms` times one attempt including its retry. See
[API observability](api-observability.md).

## Related

- [ADR 0014 — password recovery and email verification](../architecture/decisions/0014-password-recovery-and-email-verification.md): why verification is a stamp and recovery is the only feature that genuinely needs a relay.
- [ADR 0015 — transactional mail over a generic SMTP relay](../architecture/decisions/0015-transactional-mail-over-a-generic-smtp-relay.md): the transport, the retry budget and the log-mailer default.
- `.env.example`: the mail block, commented and off by default.
- [`apps/api/README.md`](../../apps/api/README.md): the API's view of the switch.
- [Neon deployment and operations](neon-deployment.md): where the mail variables go in a hosted environment.

## Still open

- No relay account exists yet, so **no real delivery has been observed** — the same gate
  ADR 0015 records. Creating one is a deployment step, not a code step.
- The React Router prototype has no site chrome, so it has no navigation entry point to
  `/account`.
