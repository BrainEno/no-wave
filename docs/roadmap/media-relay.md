# Media relay adapter (Phase 5a)

Status 2026-10-29: **landed and shared.** `packages/web-http/src/media.ts` is now
the only implementation of both media paths; `apps/web` and `apps/web-rr` call it,
and `packages/web-http/test/media.test.ts` is the contract.

## Why media goes through the app at all

The object store (Neon Object Storage, behind the S3-generic `MediaObjectStorage`
port) is private: the API holds the only credentials, and neither the bucket name
nor a key may reach a browser. So the browser-facing app relays bytes in both
directions. That makes the app responsible for everything *around* the bytes:

| Property | Rule | Where |
| --- | --- | --- |
| id validation | UUID shape, rejected locally before any upstream call | `MEDIA_ID_PATTERN` |
| cache policy | `public, max-age=31536000, immutable` — objects are content-addressed by SHA-256, so a stored object never changes | `MEDIA_IMMUTABLE_CACHE` |
| revalidation | `if-none-match` forwarded only when it is a well-formed SHA-256 ETag; a 304 is passed through with no body | `handlePublicMediaRequest` |
| content type | `image/webp` only; anything else is served as `application/octet-stream` so a stored object cannot be replayed as HTML | `handlePublicMediaRequest` |
| hardening | `x-content-type-options: nosniff`, `content-security-policy: default-src 'none'; sandbox` | both |
| size ceiling | 8 MiB, enforced on the declared length **and** on the bytes actually read — a lying `content-length` cannot overrun the process | `MEDIA_MAX_BYTES` + `readLimitedStream` |
| upload input | exact-Origin check, `image/jpeg|png|webp` only, then the bounded body read | `handleMediaUploadRequest` |
| error surface | upstream 4xx → 404, everything else → 503/502 with a fixed message; no upstream text, no bucket, no stack | both |

## Shared, not ported twice

Both halves were previously Next.js route handlers with the same rules written
inline (`app/api/media/[id]/route.ts` was ~110 lines of streaming and header
logic). They now live in the framework-neutral package, and the adapters are
three lines each:

- Next.js: `@/lib/authoring-proxy.ts` → `fetchPublicMedia` / `handleMediaPost`
  (resolves `API_BASE_URL`, converts the standard `Response`).
- React Router: `app/routes/api.media.ts` (loader) and
  `app/routes/api.authoring.media.ts` (action), both resource routes.

One more thing became shared by accident of good structure: `readLimitedStream`
extracts the bounded reader from `readLimitedBytes`, because a proxied *response*
body is just as untrusted as a request body. The failure now carries a `reason`
(`empty` / `too-large` / `unreadable`) so the media path can answer 502 for an
unusable upstream object while the request path still answers 400/413.

## Verification

| Claim | How it was checked |
| --- | --- |
| Immutable caching, ETag, 304, content-type lockdown, 8 MiB ceiling, error collapsing, upload origin/type/auth rules | `packages/web-http/test/media.test.ts` (8 tests, injected `fetchImpl`, no network) |
| Both frameworks behave identically in a real process | `pnpm test:prototype` (24 tests) for React Router; the Next.js handlers were exercised over HTTP against a stub API (200 + headers, 304, 404, 403, 415, 201) |
| The Next.js app still serves its other routes | `pnpm build` + `pnpm test:routes` |
| Real Neon Object Storage round trip | **not run** — no live bucket; the API-side adapter is covered by `media-storage.test.ts` (8 tests, fake S3 client) |
| Multipart upload (> 5 GiB) and presigned URLs | **not needed** — uploads are capped at 8 MiB and normalized before storage |
