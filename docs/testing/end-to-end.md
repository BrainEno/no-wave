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
| `playwright.config.ts` | One chromium project, one worker; `webServer` starts the API (`node scripts/dev.ts --api-only`) and the **production** Web build (`pnpm --filter @bot-thk/web start`) |
| `e2e/authoring.spec.ts` | Register → write → save draft → publish → read the public page |

Conventions:

- Selectors follow the **accessibility tree** (`getByRole`, `getByLabel`), never
  CSS classes, so a styling change cannot break the suite.
- Every spec **creates its own account**; the suite never depends on seed data or
  on another test's article.
- One worker, `fullyParallel: false`: the suite drives the real SQLite-backed
  stack, which has a single writer.
- Tests must not need `waitForTimeout`. Wait on a role, a text or a URL.

## Running it

```sh
pnpm test:e2e:install   # once per machine: downloads the Chromium build
pnpm build              # the suite drives the production Web build
pnpm test:e2e           # starts the API and the Web server if they are not running
```

The suite runs against the **production** build rather than `next dev`: on a cold
CI runner the dev server needs longer to compile the editor than a test should
wait, and the production server is what readers actually use. `pnpm build` is
therefore required before a local run.

`reuseExistingServer` is on outside CI, so a developer who already has
`pnpm dev` running keeps it and pays for nothing. In CI the job builds, then
starts its own API and Web server.

Browsers are downloaded from `cdn.playwright.dev` into Playwright's cache — not
from the npm registry and not into the repository. A machine with no access to
that host can install and typecheck the suite but cannot execute it; run it in CI
(`pnpm exec playwright install --with-deps chromium && pnpm test:e2e`).

Set `E2E_BASE_URL` to point the suite at a stack on another port or host.

## CI

`.github/workflows/ci.yml` has an `e2e` job that migrates a SQLite database,
installs Chromium and runs `pnpm test:e2e`, uploading `playwright-report/` as an
artifact (traces and screenshots on failure, 7-day retention).

It is **not** in `required-checks` yet. Browser suites are the flakiest layer by
construction; the job runs on every push and pull request so its stability can be
observed before it is allowed to block merges. Promote it once it has a clean
run history, and keep `retries: 1` as the buffer against dev-server cold starts.
