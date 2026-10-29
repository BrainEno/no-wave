# Browser-level tests (Playwright)

## Why this layer exists

`pnpm test` covers domain rules, persistence, HTTP contracts and SSR parity. All
of it can be green while an author cannot save an article — that happened: the
editor sent Lexical state the API adapter rejected, and the only symptom was one
opaque message in the UI. A unit test cannot type into a `contenteditable`, an
API test cannot click 保存草稿.

So this layer exists for **complete journeys**, and only for those. Everything
that can be asserted more cheaply must be asserted more cheaply.

## Layout

| Path | Purpose |
| --- | --- |
| `playwright.config.ts` | Two chromium projects — `app-router` and `prototype` — one worker; `webServer` starts the API (`node scripts/dev.ts --api-only`) and the **production** builds of both frameworks (`pnpm --filter @bot-thk/web start`, `pnpm --filter @bot-thk/web-rr start`) |
| `e2e/authoring.spec.ts` | Register → write → save draft → publish → read the public page, run once per framework |

Conventions:

- Selectors follow the **accessibility tree** (`getByRole`, `getByLabel`), never
  CSS classes, so a styling change cannot break the suite.
- Every spec **creates its own account**; the suite never depends on seed data or
  on another test's article.
- One worker, `fullyParallel: false`: both projects share one real SQLite-backed
  stack, which has a single writer.
- Tests must not need `waitForTimeout`. Wait on a role, a text or a URL.
- **The spec never names its framework.** Both projects run the same file against
  the same API and the same database, so a hardcoded port or origin would make
  one of them a lie. The origin comes from the project's `baseURL`
  (`currentOrigin()`), and every route the spec uses is one both frameworks
  serve.

## Running it

```sh
pnpm test:e2e:install                     # once per machine: downloads the Chromium build
pnpm build                                # production App Router build
pnpm --filter @bot-thk/web-rr build       # production prototype build
pnpm test:e2e                             # starts whatever is not already running
pnpm test:e2e --project=app-router        # or one framework at a time
```

The suite runs against the **production** builds rather than the dev servers: on
a cold CI runner `next dev` needs longer to compile the editor than a test should
wait, and the production servers are what readers actually use. Both builds are
therefore required before a local run.

`reuseExistingServer` is on outside CI, so a developer who already has
`pnpm dev` running keeps the API and the App Router and only the prototype is
started. In CI the job builds both and starts its own stack.

`DATABASE_PATH` decides where the SQLite file lives. CI points it at
`${{ runner.temp }}/no-wave-e2e.sqlite`, so every run starts from an empty
database — the journeys create real accounts and real articles, and nothing they
write outlives the runner. Locally it defaults to the development database; point
it somewhere temporary for a clean run:

```sh
DATABASE_PATH=/tmp/no-wave-e2e.sqlite pnpm db:migrate
DATABASE_PATH=/tmp/no-wave-e2e.sqlite pnpm test:e2e
```

Browsers are downloaded from `cdn.playwright.dev` into Playwright's cache — not
from the npm registry and not into the repository. A machine with no access to
that host can install and typecheck the suite but cannot execute it; run it in CI
(`pnpm exec playwright install --with-deps chromium && pnpm test:e2e`).

Set `E2E_APP_ROUTER_URL` (default `http://127.0.0.1:3000`),
`E2E_PROTOTYPE_URL` (default `http://127.0.0.1:3100`) or `E2E_API_BASE_URL`
(default `http://127.0.0.1:4000`) to point the suite at a stack on other ports.

## CI

`.github/workflows/ci.yml` has an `e2e` job that migrates a **disposable**
SQLite database (`runner.temp`), builds both frameworks, installs Chromium and
runs `pnpm test:e2e`, uploading `playwright-report/` as an artifact (traces and
screenshots on failure, 7-day retention).

It is **not** in `required-checks` yet. Browser suites are the flakiest layer by
construction; the job runs on every push and pull request so its stability can be
observed before it is allowed to block merges. Promote it once it has a clean
run history, and keep `retries: 1` as the buffer against dev-server cold starts.
