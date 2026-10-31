# Host qualification: does the deployment survive the host?

[One portable command](portable-stack.md) proves the stack runs on plain Node.js
with only documented variables, and the CI `container-image` job proves both
images build and serve. What neither can prove is the part that only a host
exerts: cold starts after an idle period, sleep/wake, a log drain, and the
platform's own shutdown signal.

**No host has been used.** Nothing here is a deployment, a DNS entry or a
database change — this repository's environment has no host account, and the
step that needs one is written down as a procedure with the exact commands
instead of being reported as done.

## What is already proven, and where

| Property | Where it is proven | Evidence |
| --- | --- | --- |
| The image builds and serves | CI `container-image` | both images build; API `/health` and `/ready` 200 |
| Server-rendered output from the image | CI `container-image` | `/` → 200 with title, `nw-pill` + `nw-footer`, unknown route → 404 |
| Cold start (process) | `pnpm stack:check`, every run | `api ready in … ms` / `web ready in … ms` (spawn to first answered request); ~0.7 s on a warm laptop |
| Cold start (container) | CI `container-image` | `Web container cold start: … ms (docker run -> first 200)`, bounded at 60 s |
| Start again after being stopped | CI `container-image` | `docker stop` (SIGTERM) then `docker start` → 200 with the same title |
| Graceful shutdown | `apps/web-rr/test/server-lifecycle.test.ts` | SIGTERM with a request in flight: the request completes (201), the process exits 0, `server_shutdown_complete` logs `forced: false` |
| Log shape | `packages/web-http/test/log.test.ts`, `server-lifecycle.test.ts` | one JSON object per line; `timestamp`, `level`, `component: "web-rr"`, `event`, plus fields |
| No secret in the logs | `server-lifecycle.test.ts` | a request to `/reset-password?token=…` logs `/reset-password` and never the token |
| Health-check target | `server-lifecycle.test.ts` | `GET /healthz` → 200 `{"status":"ok"}`, `no-store`, `x-robots-tag: noindex` |
| Statelessness | by construction, asserted by every restart above | the server writes nothing to disk and keeps no state a restart needs; a fresh process serves the same HTML |

## What only a real host can prove

- **Sleep/wake timing.** A free instance sleeps after ~15 minutes idle and takes
  tens of seconds to wake (30–60 s is the published figure for the qualified
  candidate). No local run exercises that.
- **Log drain behaviour.** That the platform collects stdout and stderr
  separately, retains them, and does not mangle a line.
- **The platform's SIGTERM gap.** The server allows in-flight requests 8 s
  (see below); the host's own patience has to be longer than that.
- **TLS termination and the `Host` header** — canonical URLs, the origin check on
  mutations, and cookies are all derived from what the platform forwards.
- Rollout and rollback under real traffic; region; the cost/no-card gate.

## The procedure to run once a host exists

Everything below needs only the public origin and, for the last two steps,
access to the host's dashboard or CLI.

```sh
ORIGIN=https://your-host.example

# 1. Cold start: after at least 20 idle minutes, time the very first request.
curl -sS -o /dev/null -w 'first byte: %{time_starttransfer}s\n' "$ORIGIN/"
curl -sS -o /dev/null -w 'warm:       %{time_starttransfer}s\n' "$ORIGIN/"

# 2. Health check: point the platform's health check at /healthz (cheap, no
#    rendering, not logged) and confirm it goes green.
curl -sS -D- -o /dev/null "$ORIGIN/healthz" | head -8

# 3. Shutdown: trigger a restart from the dashboard and watch for the two lines.
#    Expect `server_shutdown_started` then `server_shutdown_complete` with
#    `forced: false`, and no 5xx in the platform's own metrics.
```

What to record, and what each number means:

| Measurement | Good | Investigate when |
| --- | --- | --- |
| Cold start, first byte | a few hundred ms to a few s (process) | > 60 s: the image is being pulled every time, or the boot does work it should not |
| Warm request | < first request | warm is as slow as cold: something per-request is not cached and should be |
| Sleep/wake | tens of seconds on a free instance, once | every request pays it: the instance is being scaled to zero on a schedule you did not set |
| `server_shutdown_complete` `forced` | `false` | `true`: requests were still open after 8 s — check for a client that keeps a request open |
| Log lines per request | exactly one `http_request_completed` | zero: the request never reached the server; several: a retry storm |

`pnpm stack:check` gives the same cold-start numbers on any machine, so the
host can be compared against a laptop instead of against a guess.

## The server contract a host can rely on

**Signals.** `SIGTERM` and `SIGINT` stop accepting new work immediately (a
request that arrives during the drain gets `503` with `retry-after: 1`), drop
idle keep-alive sockets, and let accepted requests finish. The grace window is
**8 s**; after it, remaining connections are closed and the process exits 0. Both
ends are logged — `server_shutdown_started` (`signal`, `inFlight`) and
`server_shutdown_complete` (`signal`, `inFlight`, `durationMs`, `forced`).

**Logs.** One JSON object per line, `info` to stdout and `warn`/`error` to
stderr, with `timestamp`, `level`, `component: "web-rr"` and `event`:

| Event | Fields | When |
| --- | --- | --- |
| `server_listening` | `host`, `port`, `pid`, `node`, `buildDir` | once, when the server accepts connections |
| `http_request_completed` | `method`, `path`, `status`, `durationMs` | once per request, excluding `/healthz` |
| `server_shutdown_started` | `signal`, `inFlight` | on SIGTERM/SIGINT |
| `server_shutdown_complete` | `signal`, `inFlight`, `durationMs`, `forced` | when the process leaves |

A request is described by its **path**: query strings are dropped before
anything is written, because that is where password-reset and email-verification
tokens live. Bounded paths, no headers, no bodies.

**Health.** `GET /healthz` → `200 {"status":"ok"}`, `cache-control: no-store`,
`x-robots-tag: noindex`. It is deliberately not logged: a host probes it every
few seconds and it would otherwise be the loudest line in the drain.

**Environment.** `PORT` (default 3100), `HOST` (default `0.0.0.0`),
`API_BASE_URL`, `NEXT_PUBLIC_SITE_URL` — all documented in `.env.example`. A
host supplies `PORT`; nothing else is required to boot.

**Statelessness.** The process writes nothing to disk and keeps nothing in
memory that a restart needs, so putting it to sleep and starting it again is
safe by construction — which is the property the restart check in CI exercises.

## What this document does not claim

No measurement here comes from a real host. The numbers in the table above are
from a laptop and from GitHub-hosted runners; the sleep/wake behaviour is the
candidate's published description, not an observation. Until someone runs the
procedure in the section above against a deployed origin, cold starts,
sleep/wake, log drain and the platform's shutdown gap remain **unverified**, and
the Phase 6 exit gate stays open.
