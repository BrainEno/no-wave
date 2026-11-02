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
| `playwright.config.ts` | One chromium project — `web` — one worker; `webServer` starts the API (`node scripts/dev.ts --api-only`) and the **production** build of the Web application (`pnpm --filter @bot-thk/web-rr start`). Until 2026-11-01 there were two projects, `app-router` and `prototype`, running the same spec against both frameworks; the App Router is gone, so the suite runs once. |
| `e2e/authoring.spec.ts` | Register → write → save draft → publish → read the public page → withdraw it → delete it → restore it from the recycle bin |
| `e2e/devices.spec.ts` | Sign in → read the list of signed-in devices → end the other one → keep reading on this one; end the device you are holding → land on the sign-in page |
| `e2e/read-aloud.spec.ts` | Read a published work aloud paragraph by paragraph → the mark follows the spoken paragraph → 停止 takes it off; a browser that cannot speak is given no control |
| `e2e/passages.spec.ts` | Select a passage → 划线 → it is painted, listed and still there after a reload; write a note beside it and change it; 朗读这段 reads just that passage and takes the voice from a reading of the whole work; 删除 takes it off the page and out of the browser; 分享 writes it into a link, which a reader in a fresh browser opens and keeps for themselves, and a link whose words are not in the work says so and marks nothing |
| `e2e/support/works.ts` | Not a spec: publishes a work over HTTP for the journeys that need one, and drags a selection across part of the page |
| `e2e/support/speech.ts` | Not a spec: replaces the browser's speech engine with one that can be driven, because a headless browser has no voices installed |
| `e2e/support/accounts.ts` | Not a spec: opens an account through the sign-in form, in the browser, so a private screen is visited with a session the journey made |
| `e2e/media-library.spec.ts` | An anonymous visit is sent to sign in and pointed back; a signed-in author is told when image storage is unconfigured rather than shown an empty library; the desk links to the library |

Conventions:

- Selectors follow the **accessibility tree** (`getByRole`, `getByLabel`), never
  CSS classes, so a styling change cannot break the suite.
- Every spec **creates its own account**; the suite never depends on seed data or
  on another test's article.
- One worker, `fullyParallel: false`: both projects share one real SQLite-backed
  stack, which has a single writer.
- Tests must not need `waitForTimeout`. Wait on a role, a text or a URL.
- **The spec never names its framework.** The origin comes from the project's
  `baseURL` (`currentOrigin()`), so the suite can be pointed at any stack —
  which is what let the same file run against two frameworks while there were
  two, and lets it run against a different port now.

## Running it

```sh
pnpm test:e2e:install                     # once per machine: downloads the Chromium build
pnpm build                                # production build of the Web application
pnpm test:e2e                             # starts whatever is not already running
pnpm test:e2e --project=web               # the only project
```

The suite runs against the **production** build rather than the dev server: on a
cold CI runner a dev server needs longer to compile the editor than a test should
wait, and the production server is what readers actually use. The build is
therefore required before a local run.

`reuseExistingServer` is on outside CI, so a developer who already has
`pnpm dev` running keeps the API and the Web app. In CI the job builds and starts
its own stack.

`DATABASE_PATH` decides where the SQLite file lives. CI points it at
`/tmp/no-wave-e2e.sqlite`, so every run starts from an empty database — the journeys create real accounts and real articles, and nothing they
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

Set `E2E_WEB_URL` (default `http://127.0.0.1:3000`) or `E2E_API_BASE_URL`
(default `http://127.0.0.1:4000`) to point the suite at a stack on other ports.

## CI

`.github/workflows/ci.yml` has an `e2e` job that migrates a **disposable**
SQLite database (`/tmp/no-wave-e2e.sqlite`, discarded with the runner), builds the
Web application, installs Chromium and runs `pnpm test:e2e`, uploading
`playwright-report/` as an artifact (traces and screenshots on failure, 7-day
retention).

**It is part of `required-checks`** (2026-11-01), so a red browser journey blocks
a merge. That is the point: this is the only layer that can see the authoring
round trip, and a signal nobody has to act on is a signal that decays. It ran
outside the gate first for exactly the reason promotion was deferred — browser
suites are the flakiest layer by construction — and it was promoted on its record:
seven consecutive green runs across PRs 140 to 143.

What that buys, and what it costs:

- `retries: 1` in `playwright.config.ts` absorbs a single flake — a cold server, a
  download, an animation that runs a beat longer on a busy runner. One retry, not
  three: a genuinely broken journey fails twice and still blocks, and the failed
  attempt stays in the report with its trace.
- The job has `timeout-minutes: 25`, roughly five times its observed cold cost. A
  hang would otherwise hold the gate for the six hours GitHub's default allows.
- A failure here is worth reading before it is worth re-running. Open the
  `playwright-report` artifact on the run: it carries the trace of the failed
  attempt. If it reproduces locally (`pnpm test:e2e` against a migrated
  `/tmp/no-wave-e2e.sqlite`), it is a real regression.

Whether `required-checks` actually blocks a merge is a branch-protection setting
managed in GitHub, not in this workflow file — see the README. If a merge goes
through with this check red, that setting is the thing to look at first.
