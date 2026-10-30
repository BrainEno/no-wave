# Neon deployment and operations

This repository uses Neon's PostgreSQL as the durable database, Neon Object Storage
for private uploaded media, and a small Neon Function as a database connectivity
probe. The existing product REST API remains the standalone API service in
`apps/api` (currently wired to the Vercel service binding); the probe does not
replace or duplicate the business API. Neon Realtime is provisioned, but the Web
client does not subscribe to live queries yet. Before exposing subscriptions, define
authorization rules for private messages and other user-owned rows.

## Resources and region

The expected Neon targets are:

- Organization: `org-divine-wind-26313065`
- Project: `crimson-rain-84686659`
- Branch: `production`

Neon Functions, Object Storage, and Realtime require a supported project region:
`aws-us-east-2`, `aws-us-east-1`, `aws-eu-central-1`, or `aws-ap-southeast-1`.
If the existing project is in another region, the CLI cannot provision all requested
services there. Review the region before changing or creating resources.

## Link the local checkout and provision resources

Use Node.js 24 and pnpm 10.20.0 for this repository. In the repository root:

```sh
npm i -g neon@latest
neon init -y --org-id org-divine-wind-26313065 --project-id crimson-rain-84686659 --branch production
```

The checked-in `neon.ts` already declares the private `media` bucket, `health`
Function, and Realtime. Do not regenerate or overwrite it with an empty starter
configuration. The `neon init` command links the local checkout, installs the Neon
agent tooling, writes the ignored `.neon` context, and pulls Neon-managed env vars
into `.env.local` (or `.env` if that file exists).

If the CLI reports that you are not authenticated, complete its authentication flow
in your terminal (`neon auth`; use `neon login` only if your installed CLI presents
that legacy command). If a browser sign-in opens, finish authorization in that browser
and rerun the command. Do not paste an API key, database URL, or storage secret into
GitHub or into this PR.

Inspect the proposed infrastructure changes before applying them:

```sh
neon status
neon config plan
neon deploy
neon env pull
```

Review the plan carefully before `neon deploy`: it applies the service policy to the
linked production branch. `neon deploy` is an infrastructure operation, not a
build-only command. The CLI should pull the pooled and unpooled PostgreSQL URLs plus
S3-compatible credentials for the declared bucket. Do not share `.env.local` contents
in issues, logs, chats, or commits.

## Environment variables

The repository's `.gitignore` protects `.env`, `.env.local`, other dotenv files,
and the CLI's `.neon` context. `.env.example` contains only placeholders and is safe
to commit.

Neon provides these variables after provisioning:

| Variable | Used for |
| --- | --- |
| `DATABASE_URL` | Pooled PostgreSQL connection for normal API traffic. |
| `DATABASE_URL_UNPOOLED` | Direct connection for schema migrations. The migration command prefers this value. |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | Branch-scoped private Object Storage credentials. |
| `AWS_ENDPOINT_URL_S3`, `AWS_REGION` | S3-compatible endpoint and region. |

The app-specific `MEDIA_S3_*` aliases take precedence over the standard `AWS_*`
variables. Set `MEDIA_S3_BUCKET=media` explicitly: the bucket name is app configuration,
not one of the injected credentials. Neon Object Storage requires S3 path-style
addressing, so keep `MEDIA_S3_FORCE_PATH_STYLE=true` when overriding the default.

The adapter in `apps/api/src/infrastructure/media-storage.ts` stays a generic S3
client; three details make it work against Neon Object Storage without any
provider-specific code:

- `requestChecksumCalculation: "WHEN_REQUIRED"` is set on the client. The
  flexible-checksum trailer the AWS SDK adds by default is rejected by
  S3-compatible stores.
- Throttling (`503 SlowDown`) and timeouts are retried a bounded three times with
  100/200 ms backoff on the idempotent operations (`putObject`, `getObject`,
  `deleteObject`). Credential, key and checksum errors are *not* retried.
- Stored objects are normalized WebP images capped at 8 MiB, far below Neon's
  5 GiB single-request upload limit, so multipart upload is never needed.

Generate a strong JWT key locally (do not commit the generated result):

```sh
node -e "console.log(require('node:crypto').randomBytes(48).toString('base64url'))"
```

Put the result in the ignored `.env.local` as `AUTH_JWT_SECRET`. Also configure
`AUTH_JWT_ISSUER` and `AUTH_JWT_AUDIENCE`. In production, the issuer must be the
stable public issuer expected by this application; do not leave it as localhost.
Do not use a user-facing `NEXT_PUBLIC_*` prefix for any credentials.

## Run and validate the API locally

After linking and provisioning the Neon branch, confirm `.env.local` has both
database URLs and all four `AWS_*` values before proceeding. Keep actual values only
in your ignored local env file.

```sh
pnpm install --frozen-lockfile
pnpm --filter @bot-thk/api migrate
pnpm --filter @bot-thk/api start
```

The migration script selects `DATABASE_URL_UNPOOLED` first and otherwise falls back
to `DATABASE_URL`; the live API uses the pooled `DATABASE_URL`. A successful migration
reports how many migrations were discovered and newly applied.

In another terminal, call:

```sh
curl http://127.0.0.1:4000/health
curl http://127.0.0.1:4000/ready
```

`/health` proves the API process is running; `/ready` proves its configured database
adapter is ready. To test media storage end to end, authenticate with a test account,
upload a small JPEG/PNG/WebP image through the existing authoring API, read it through
the API's media endpoint, and verify the stored metadata/checksum. CI tests env
resolution and storage configuration but do not contact Neon.

The deployed Neon Function `health` is a separate smoke endpoint. Retrieve its live
invocation URL with `neon functions get health`, then call its `/health` path. It
returns `200` only if its injected `DATABASE_URL` can execute `SELECT 1`; failures
return a sanitized `503`.

## Vercel environment

This repository's `vercel.json` continues to deploy the existing Web app and
standalone API service. Neon provisioning does not automatically copy local credentials
into Vercel's environment settings. Add the following **server-only** variables to the
Vercel project for the environments that should connect to this Neon branch:

- `DATABASE_PROVIDER=postgres`
- `DATABASE_URL` (Neon's pooled URL)
- `DATABASE_URL_UNPOOLED` (direct URL, used by explicit migration steps)
- `AUTH_JWT_SECRET`, `AUTH_JWT_ISSUER`, `AUTH_JWT_AUDIENCE`
- `MEDIA_S3_BUCKET=media`
- `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_ENDPOINT_URL_S3`, `AWS_REGION`
- `MAIL_ENABLED` — set it to `true` on **both** the API and the Web service to switch account mail
  on. Everything below does nothing until you do: while it is off, recovery and verification answer
  `409 MAIL_DISABLED` and the Web app hides the pages that lead to them.
- `MAIL_SMTP_HOST`, `MAIL_SMTP_PORT`, `MAIL_SMTP_SECURITY`, `MAIL_SMTP_USER`, `MAIL_SMTP_PASSWORD`,
  `MAIL_FROM`, `MAIL_FROM_NAME` — optional, but until `MAIL_ENABLED` is on **and** `MAIL_SMTP_HOST`
  and `MAIL_FROM` are set, the API logs account mail instead of delivering it, so password recovery
  stays a dead letter. Generic SMTP submission, so any relay works; TLS is required by default
  (ADR 0015).

Use values from the linked Neon branch, not from a preview branch. Never add secrets to
`vercel.json`, GitHub Actions YAML, a tracked dotenv file, or the browser bundle. After
adding Vercel variables, redeploy the API/Web services and verify `/health` and
`/ready` on the deployed application. Run database migrations as a separate reviewed
release step with a backup/cutover plan; do not run production migrations automatically
on every server start.

## Current boundary

- PostgreSQL and S3-compatible media are wired into the existing API.
- The Neon Function validates access to the branch database but is not the product REST API.
- Realtime is provisioned but intentionally not yet used by the browser/API. A later
  feature should select live queries and enforce ownership/authorization for conversations,
  messages, notifications, and private account data before subscribing.
- Neon CLI login, provisioning, live DB migrations, and live Object Storage tests require
  authorization in the user's Neon account and have not run in CI.
