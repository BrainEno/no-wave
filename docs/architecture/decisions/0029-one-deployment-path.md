# ADR 0029: One deployment path — the repository ships no platform manifest

- Status: Accepted
- Date: 2026-11-07

## Context

`vercel.json` declared the API, the Web application and the notification worker as
Vercel Services, with a private service binding between the two tiers and a
single-instance Daemon for the outbox worker. It was written while the Web app
was still Next.js, rewritten for containers when
[ADR 0017](0017-nextjs-retired-one-web-application.md) retired it, and never
deployed: no Vercel project was ever pointed at this repository, so the file
described an architecture nobody had run.

That is the worst state for a configuration file to be in. It is not
documentation — it looks authoritative, it is machine-readable, and a reader
plans around it. It is also not configuration — nothing in CI reads it, so
`apps/api/Dockerfile.vercel` could be renamed, a rewrite could point at a service
that no longer existed, and the first signal would be a failing deploy on the day
someone chose that host.

Two paths existed and only one was exercised. The container images are built,
started on one network and probed over HTTP by the `container-image` CI job; the
same three processes run without Docker under `pnpm stack:check`. The Vercel
manifest's only verification was the file's own existence.

The engineering review's F-25 asked whether the configuration was still
supported. On 2026-11-07 the owner answered that it is not maintained.

## Decision

1. **`vercel.json` is deleted**, and with it `docs/deployment/vercel.md`. The
   repository no longer ships a platform manifest of any kind.
2. **The deployment surface is the two container images and the three
   processes**: `apps/api/Dockerfile` (renamed from `Dockerfile.vercel` — the file
   never contained anything platform-specific), `apps/web-rr/Dockerfile`, and the
   API / Web / outbox-worker processes that
   [the portable stack](../../operations/portable-stack.md) starts without Docker.
   Both are exercised in CI.
3. **A host is a place to run that image**, not a configuration in this
   repository. Reintroducing a platform manifest is allowed, but only together
   with a deployment that proves the manifest works — the CI guard for the images
   (the `docker build -f …` paths in the workflow) is the standard the new file
   would have to meet.
4. **Nothing in the application changes.** The runtime still reads
   `API_SERVICE_URL` as a fallback for the Web tier's API origin and still treats
   the `VERCEL*` variables as unset-by-construction
   ([ADR 0012](0012-portable-web-framework-migration.md)); a deployment that sets
   them gets the documented precedence, and the portable stack keeps stripping
   them so it cannot accidentally pass for a deployment.

## Consequences

- **Vercel stops being a supported deployment from this repository.** Anyone who
  wants it writes the manifest and runs the deploy; the container images it would
  reference are the ones CI already builds.
- **The `container-image` job keeps its value**: two images built from the single
  lockfile, run on one network, probed from outside. Its API image now has the
  plain name.
- **Documentation stops offering a path nobody walked.**
  `docs/operations/neon-deployment.md` lists the environment a container needs
  instead of a Vercel project's settings; the README names one deployment path.
- **The audit's F-25 is closed** with "not supported" as the answer, not "kept and
  annotated".
- A future platform decision has a cost this ADR makes explicit: a manifest alone
  is not evidence, and this round deleted one for being exactly that.
