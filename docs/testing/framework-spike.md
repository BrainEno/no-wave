# Framework Portability Spike — Execution Checklist

Status: Minimal source scaffold committed. GitLab CI has passed unit tests, typecheck and production build; route-level HTTP smoke checks are now included in CI. Docker image build/runtime verification remains pending.

## Baseline versions

- Framework target: Next.js App Router.
- Next.js stable version selected for the spike: 16.4.2, checked against release listings on 2026-10-23. Re-check security advisories before production release.
- Next.js documentation requires Node.js 20.9 or newer; use Node.js 24 LTS for this spike and pin the exact CI/container runtime.
- Use pnpm workspaces with a committed `pnpm-lock.yaml`; CI and Docker install with `--frozen-lockfile`.

## Implemented in the initial slice

- Public home and article fixture routes.
- Public author fixture route.
- Article title/description/canonical/Open Graph metadata helper with unit tests.
- A private account placeholder that denies by default and redirects until real server-side auth exists; route is dynamic and marked no-store.
- A server action form with field validation and a deterministic in-process mock API success/failure adapter.
- A small SSE response fixture with no-store headers; it emits a refresh hint only and is not a durable event service.
- Sitemap and robots metadata helpers.
- Multi-stage Dockerfile and GitLab CI verify job.

## Validation checklist

- [x] Unit tests pass from a clean CI checkout (4 tests).
- [x] Typecheck passes.
- [x] Production build passes.
- [ ] Route smoke checks pass in the newest frozen-lockfile CI pipeline.
- [x] Public article returns crawlable HTML and canonical/Open Graph metadata in the route smoke test.
- [x] Unknown article and author routes are asserted as 404 by the route smoke test.
- [x] Anonymous account access redirect and no-store cache policy are asserted by the route smoke test.
- [x] SSE fixture event-stream/no-store headers, robots.txt and sitemap.xml are asserted by the route smoke test.
- [ ] Docker build/run works without vendor-specific services.

## Known limitations

- There is no production authentication/session verifier, GraphQL client or real API call yet.
- The SSE fixture closes immediately and does not test browser reconnect behavior.
- Content is fixture data, not connected to a database.
- Docker build/runtime has not yet been verified.
- Interactive form states still need browser-level coverage.

## Exit report

Record exact runtime/package versions, commit SHA, CI job URL, commands and results, route behavior, cache headers, deployment target and unresolved limitations. If the spike fails, update ADR 0002 before scaffolding the production app.
