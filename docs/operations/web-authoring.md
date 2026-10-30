# Web article authoring

## Article authoring

The authenticated writing desk is available at `/write`. It supports draft creation/saving, reopening work, editing published articles and publishing through the existing REST contract. The Lexical editor supports paragraph text, h2–h4 headings, quotes without attributions, flat ordered/unordered lists, inline marks, links, code blocks and approved image nodes.

## Image storage and upload

Uploads use an S3-compatible object store; the API never stores source image bytes in SQLite or PostgreSQL. Configure all four required server-only variables:

- `MEDIA_S3_BUCKET`: bucket name.
- `MEDIA_S3_REGION`: bucket region.
- `MEDIA_S3_ACCESS_KEY_ID`: restricted service credential.
- `MEDIA_S3_SECRET_ACCESS_KEY`: restricted service secret.

Optional configuration: `MEDIA_S3_ENDPOINT` for an S3-compatible service or local development endpoint, and `MEDIA_S3_FORCE_PATH_STYLE=true|false` (defaults to path-style when a custom endpoint is set). Never expose these variables with a `NEXT_PUBLIC_` prefix. Use a dedicated bucket with public object access blocked; requests are proxied through the API, so object keys and credentials are not exposed to browsers.

When all `MEDIA_S3_*` variables are unset, image uploads return `503 MEDIA_STORAGE_UNAVAILABLE` while text-only writing remains available. A partial required configuration fails during startup rather than silently disabling a partially configured store.

The API accepts JPEG, PNG and WebP bodies up to 8 MiB. It verifies declared MIME against file signatures, rejects animation/multipage files and unsafe dimensions, rotates according to orientation, scales to at most 2560×2560, and re-encodes as WebP. Re-encoding removes source metadata such as EXIF. The normalized output, checksum, dimensions and owner are recorded in `media_assets`; the object is removed best-effort if metadata persistence fails. API-side write-rate limits apply per socket IP and authenticated user.

Public image URLs use `/api/media/:uuid`; the Web same-origin proxy fetches media from the configured API service. This endpoint serves a normalized WebP object with immutable cache headers, an ETag and `nosniff`. The API validates stored bytes against persisted size and SHA-256 before serving them. Deploy both services with TLS in production.

Before deploying, run the versioned database migrations. SQLite uses `apps/api/src/persistence/migrations/sqlite/0007_media_assets.sql`; PostgreSQL uses `apps/api/src/persistence/migrations/0015_media_assets.sql`. The metadata rows participate in the provider migration change journal like other business entities. Ensure the object bucket is available and backed up separately from the SQL metadata.

## Comments

Article comments use a deliberately smaller Lexical configuration: paragraphs, bold, italic, underline, strikethrough and links only. The browser calls same-origin comment routes; create requests require an exact `Origin` match and use the authenticated API. Rich comment blocks are validated by the existing application-owned v1 comment contract. Images, headings, lists and code are not accepted in comments.

## Authentication boundary

The browser never receives the access or refresh token in JSON. The Next.js same-origin auth route writes them to HttpOnly cookies; the access cookie is scoped to `/api/authoring`, and the refresh cookie is scoped to `/api`. Cookies use SameSite=Lax and Secure on HTTPS. Mutating requests require the exact request origin. The server-side proxy attaches the Bearer token, rotates refresh tokens on an API 401, retries once, and clears cookies after an invalid or expired refresh token.

This does not complete the account lifecycle: email verification, password recovery, operational abuse controls and full production security review remain separate work. Configure `API_BASE_URL` or the Vercel service binding, and keep the API reachable only via the intended network boundary.

## Contract

Article writes send a Lexical `editorState` plus `contentBlocksVersion: 1` to `POST /api/v1/articles` or `PUT /api/v1/articles/:id`. The existing API adapter validates and converts the state into the application-owned `contentBlocks` contract; the database does not store Lexical's internal state format. Drafts and published work list through `GET /api/v1/me/articles`. API-side compatibility tests validate the Web serializer against the real content adapter.

Deletion is a tombstone, not a row removal: `DELETE /api/v1/articles/:id` stamps `deleted_at` and returns the work to draft, so every published read already excludes it, and releases its slug so rewriting the same title cannot collide with the tombstone. The desk shows the author's own tombstones under `GET /api/v1/me/articles/deleted`, each with the moment it will be swept, and `POST /api/v1/articles/:id/restore` brings one back — as a draft, never as published, because republishing is the author's decision to make again. `ARTICLE_TOMBSTONE_RETENTION_DAYS` (default 30) decides how long a tombstone survives; the sweep runs bounded and opportunistically on the desk's own writes, and the author has no "delete forever" action. Purging removes the row and, through the foreign keys, the translations, likes, comments and taxonomy links that referred to it — the one irreversible step in the slice.
