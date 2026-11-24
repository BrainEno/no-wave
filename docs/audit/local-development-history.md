# 本地开发链历史记录

Status: archived

从操作指南移出的历史叙事，所述复现基线为 `9f4da47`；不是当前缺陷清单或现行安全策略。
当前操作以[本地开发指南](../development/local-development.md)、[共享 BFF 规则](../architecture/bff-routes.md)及当前代码为准。旧模块路径只保留历史上下文。

## 当时缺口

Each row was reproduced on the commit this document was written against
(`9f4da47`), not inferred from the code.

| # | Gap | How it showed up | Now |
| --- | --- | --- | --- |
| G1 | No local PostgreSQL orchestration. The README asked for a hand-written `docker run`, a manual `pg_isready` loop and a hand-typed `TEST_DATABASE_URL`. | Every developer invented their own container, port and database name. | `compose.yaml` + `pnpm db:up/db:down/db:reset`; the volume also creates `bot_thk_test`. |
| G2 | `.env.example` set `DATABASE_PROVIDER=postgres` with an empty `DATABASE_URL`, contradicting the SQLite-first default (ADR 0010). | Copying the template made the API exit at startup with `DATABASE_URL is required when DATABASE_PROVIDER=postgres.` | Template is SQLite-first, PostgreSQL is a documented switch, and `pnpm setup:local` writes a valid file. |
| G3 | A repository-root `.env.local` was read by the API but ignored by the Web app (Next.js only read `.env*` from `apps/web`). | `API_BASE_URL` set "in the project env" had no effect on the Web app, which silently kept rendering fixtures. | `apps/web-rr/vite.config.ts` loads the same root file via `process.loadEnvFile`, with the same precedence rules as the API. |
| G4 | No single command for the API. Root `pnpm dev` started only the Web app. | Two terminals, two working directories, and an easy way to forget the API entirely. | `pnpm dev` starts API/worker/Web with readiness gates; `dev:api` includes the worker, `dev:web` starts only Web. |
| G5 | `AUTH_JWT_SECRET` shorter than 32 bytes or absent was only reported as `503 SERVICE_UNAVAILABLE` / "Identity is not configured." on auth routes. | Sign-in looked like an outage on a fresh clone; the message names neither the variable nor the length. | `evaluateAuthSecret` blocks `pnpm dev` before any process starts, with the exact remedy. |
| G6 | No way to test the chain. `pnpm test:routes` covers the Web app in fixture mode only. | "It works" was a manual browser opinion. | `pnpm check:local` (10 probes) and `pnpm dev --check`. |
| G7 | The publish precondition was hidden. | An account without a profile returned `author: null`, so the public article 404s and the Web page 404s. | Registration now creates a default profile in the same transaction; the probe verifies it and the writing desk can edit the pen name. |
| G8 | An empty database and a missing API look identical in the UI (both render an empty site). | Hours lost to "the frontend is not connecting". | The probe asserts the API title appears in the server-rendered HTML. |
| G9 | Next.js only serves dev assets to trusted hostnames. | Opening the dev server from a phone or a preview proxy produced an unstyled page. | `WEB_DEV_ALLOWED_ORIGINS` -> `allowedDevOrigins`. |
| G10 | The local chain was not exercised in CI. | Regressions in the wiring were only found by developers. | A `local-dev-chain` CI job boots SQLite *and* PostgreSQL legs through the same scripts. |
| G11 | `DATABASE_PATH` is resolved against the API's working directory, not the repository root. | `data/no-wave.sqlite` could land in two different places depending on how the API was started. | The dev banner prints the resolved repository-relative path, without leaking the developer's home directory. |

## 当时验证发现的缺陷

The new probe failed its Web auth step with `403 ORIGIN_REJECTED` even though the
request was same-origin. Root cause: the dev server builds `request.url` from the
hostname it was started with, so `--host 0.0.0.0` (and the
Web image's `HOSTNAME=0.0.0.0`) produces `http://0.0.0.0:3000/...`, while the
browser sends `Origin: http://127.0.0.1:3000`. `isSameOriginMutation` compared
against the first value and therefore rejected every legitimate sign-in,
logout, authoring write, media upload and comment mutation for any hostname other
than the listen address.

Fix: compare the browser `Origin` against the request's `Host` header (the
authority the browser actually addressed), falling back to `request.url` when the
header is missing or malformed. The comparison remains exact origin equality —
scheme, host and port — so a foreign origin, a different port or a scheme
downgrade is still rejected. See
`packages/web-ui/src/lib/authoring-proxy-policy.ts` and its regression test.
