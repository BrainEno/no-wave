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
| `playwright.config.ts` | One chromium project — `web` — one worker; `webServer` starts the API and the **production** build of the Web application. An isolated run starts the API directly, without loading a developer's `.env.local`; targeted runs use `node scripts/dev.ts --api-only`. |
| `scripts/e2e-runner.ts` | The no-argument `pnpm test:e2e` runs four sequential shards, each with a fresh disposable SQLite database and independent local stack. Explicit Playwright arguments or external E2E URLs retain the targeted/external behavior. |
| `e2e/authoring.spec.ts` | Register → write → save draft → publish → read the public page → withdraw it → delete it → restore it from the recycle bin; first-save lost-response replay, edits during an uncertain save, account switching, navigation protection, and English/legacy Traditional Chinese editions across reload and restore |
| `e2e/devices.spec.ts` | Sign in → read the list of signed-in devices → end the other one → keep reading on this one; end the device you are holding → land on the sign-in page |
| `e2e/engagement.spec.ts` | Real browser cookies, save and follow persistence, optimistic rollback, private feed isolation, refresh, failed reads and retry, CSRF rejection, late responses during client navigation, and return to the English edition after sign-in |
| `e2e/read-aloud.spec.ts` | Read a published work aloud paragraph by paragraph → the mark follows the spoken paragraph → 停止 takes it off; a browser that cannot speak is given no control |
| `e2e/passages.spec.ts` | Select a passage → 划线 → it is painted, listed and still there after a reload; write a note beside it and change it; 朗读这段 reads just that passage and takes the voice from a reading of the whole work; 删除 takes it off the page and out of the browser; 分享 writes it into a link, which a reader in a fresh browser opens and keeps for themselves, and a link whose words are not in the work says so and marks nothing |
| `e2e/support/works.ts` | Not a spec: publishes a work over HTTP for the journeys that need one, and drags a selection across part of the page after fonts and layout have settled |
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
- The API limits article creation to 30 requests per IP per hour, including
  idempotent replays. The lost-response, cross-account and current-version
  journeys exercise real creates; other editor error-state journeys simulate
  responses, so the single shared stack does not exhaust that production limit.
  If the suite grows past that budget, isolate stacks rather than relaxing the
  production policy or hiding a `429`.
- **A drag is not a selection.** `selectPartOf` scrolls its target into view,
  waits (with a cap) for the webfonts, then checks that a real, non-collapsed
  selection overlaps that element before returning. A Chinese webfont
  swapping in after `boundingBox()` moves the paragraph, and a drag at the old
  coordinates leaves nothing selected; a fixed `waitForTimeout` hides that
  instead of fixing it. One re-measured retry absorbs the remaining layout
  shift, and a drag that still selects nothing fails with its own message.

### A cold-load selection race (2026-11-04)

The first `passages.spec.ts` journey once timed out for 60s waiting for
`[data-passage-tools]` on the `main` merge run, while the other 32 journeys
passed and a rerun of the same commit was green. No single cause was proven;
two contributing causes were plausible, and the changes below address both:

- The shelf renders before React flushes its passive effects. On a cold runner
  a reader's drag can end in that gap; the selection survives its `mouseup`,
  but the component had no listener yet. `PassageAnnotations` now reads the
  selection once when its listener goes live as well as on each `mouseup` /
  `touchend`, so an already-existing selection is treated like a fresh one.
- The drag used coordinates measured before the webfonts settled. The helper
  now waits for fonts and verifies the selection, as described above.

The DOM-independent part of that decision — which words a mark covers, trimming
whitespace, refusing over-long selections — is a pure function in
`packages/web-ui/src/lib/passage-selection.ts`, covered by `pnpm test` without a
browser. The timing itself can only be observed in a browser: the six 划线
journeys in CI are the regression check, and local runs need Chromium installed.

## Running it

```sh
pnpm test:e2e:install                     # once per machine: downloads the Chromium build
pnpm build                                # production build of the Web application
pnpm test:e2e                             # all journeys, four disposable local stacks
pnpm test:e2e --grep 'save'                # targeted Playwright run (see below)
```

The suite runs against the **production** build rather than the dev server: on a
cold CI runner a dev server needs longer to compile the editor than a test should
wait, and the production server is what readers actually use. The build is
therefore required before a local run.

With no arguments or external E2E URLs, `pnpm test:e2e` creates four fresh
SQLite databases in a temporary directory, migrates each, selects local ports,
starts its own servers, and removes the directory afterwards. It supplies a
short-lived test secret, does not reuse an existing server, and does not pass a
developer's database, mail or object-storage settings to the API. Each shard
has its own 30/IP/hour article budget; no production rate limit is changed.
The inventory now uses four stacks: adding private-message journeys changed
Playwright's file-level shard boundaries and placed more than 30 real article
creates in the first of three shards. The fix adds another isolated budget,
not a larger limit, a hidden retry, or simulated publishing assertions.

With explicit Playwright arguments (for example `--grep` or a spec path), or
with `E2E_WEB_URL` / `E2E_API_BASE_URL` set, the command passes through to
Playwright instead. Outside CI that mode reuses an existing server if one is
listening. Otherwise, it uses the configured database: for a targeted local
run, point it at a fresh disposable file and provide the usual local JWT
configuration before starting:

```sh
DATABASE_PROVIDER=sqlite DATABASE_PATH=/tmp/no-wave-e2e-focused.sqlite pnpm db:migrate
DATABASE_PROVIDER=sqlite DATABASE_PATH=/tmp/no-wave-e2e-focused.sqlite AUTH_REGISTER_IP_LIMIT=80 pnpm test:e2e --grep 'save'
```

The registration override applies only to the disposable API and matches CI.
A full pass-through run on one stack can exhaust the separate article-creation
limit; use the no-argument isolated runner or run the four Playwright shards on
separate freshly migrated stacks.

Browsers are downloaded from `cdn.playwright.dev` into Playwright's cache — not
from the npm registry and not into the repository. A machine with no access to
that host can install and typecheck the suite but cannot execute it; run it in CI
(`pnpm exec playwright install --with-deps chromium && pnpm test:e2e`).

Set `E2E_WEB_URL` (default `http://127.0.0.1:3000`) or `E2E_API_BASE_URL`
(default `http://127.0.0.1:4000`) to point the suite at a stack on other ports.

## CI

`.github/workflows/ci.yml` has an `e2e` matrix: each of its four shards runs on
its own runner with a **disposable** SQLite database (`/tmp/no-wave-e2e.sqlite`,
discarded with the runner). Each builds the Web application, installs Chromium,
runs its Playwright shard and uploads `playwright-report-1` through
`playwright-report-4` (traces and screenshots on failure, 7-day retention).
The aggregate job succeeds only if all four shards succeed.

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
  attempt. If it reproduces locally with `pnpm test:e2e` (or a targeted run
  against a fresh migrated SQLite file), it is a real regression.

Whether `required-checks` actually blocks a merge is a branch-protection setting
managed in GitHub, not in this workflow file — see the README. If a merge goes
through with this check red, that setting is the thing to look at first.
