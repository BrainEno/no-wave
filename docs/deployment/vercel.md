# Vercel deployment

This repository is configured for a single Vercel Services deployment containing the Next.js web app, the HTTP API container, and the notification outbox daemon.

## Service layout and public routing

- `web` builds from `apps/web` and receives the catch-all public route `/(.*)`.
- `api` is built from the repository root so its container can use the shared `pnpm-lock.yaml`. Its runtime image contains only the API workspace dependencies and source.
- Only the documented REST prefix `/api/v1/*` is routed publicly to `api`. The Next.js route `/api/spike/events` therefore remains with `web`.
- The GraphQL endpoint (`/graphql`), `/health`, and `/ready` are not exposed by public rewrites. The web server reaches GraphQL through the private `API_SERVICE_URL` binding.
- `notifications` runs `apps/api/src/persistence/notification-worker.ts` as a Vercel Daemon. It uses PostgreSQL directly and does not need a service binding.

The Vercel project framework preset must be **Services**. If the preset remains Next.js, Vercel may ignore the multi-service configuration.

## Environment variables

Configure these in Vercel's environment-variable settings for the environments where they are needed. Never commit production values.

- `DATABASE_PROVIDER=postgres`
- `DATABASE_URL`: connection URL for the PostgreSQL database. Configure it for the API and notification worker.
- `AUTH_JWT_SECRET`, `AUTH_JWT_ISSUER`, `AUTH_JWT_AUDIENCE`: JWT verification settings that must match the token issuer.
- `NEXT_PUBLIC_SITE_URL`: the canonical public website URL for metadata.

Do not manually set `API_SERVICE_URL`; Vercel injects it from the service binding. Leave `API_GRAPHQL_URL` unset when using this binding. An explicit `API_GRAPHQL_URL`, if present, takes precedence and must already be the complete GraphQL endpoint URL.

## Database and worker operations

- Provision an external PostgreSQL database; this repository does not provision one automatically.
- Run `pnpm --filter @bot-thk/api migrate` against the intended non-production database to validate migrations before a reviewed production rollout. Migrations are not run automatically during build or startup.
- The outbox worker needs the same `DATABASE_URL` and polls durable outbox rows. The confirmed configuration starts one `notifications` Daemon instance in `hkg1` (Hong Kong). Keep this region unless the PostgreSQL location or latency measurements justify changing it.
- Vercel Daemons are currently in public beta and run in production deployments only; preview deployments do not start the daemon. Test the worker image separately with Docker and verify production logs before relying on notification delivery. Do not run two independent worker deployments against the same outbox unless duplicate-processing behavior has been reviewed.
- The worker persists in-app notifications; external push/email delivery is not configured.

## Validation

The GitHub Actions workflow runs the repository's unit tests, TypeScript checks, web build, route smoke tests, and PostgreSQL integration tests. Also run `vercel dev` with Docker available to validate service routing, the API container, and the runtime binding locally. `vercel dev` does not run Daemons; validate the worker separately with Docker and a disposable database. No deployment or database migration is triggered by these files.
