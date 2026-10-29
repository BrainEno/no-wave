# ADR 0011: Server-mediated uploads to S3-compatible media storage

- Status: Accepted
- Date: 2026-10-29

## Context

Issue #60 requires article image insertion with real storage, MIME and size validation, image normalization and metadata persistence. The application supports SQLite-first local installs and PostgreSQL deployments, and provider cutover depends on the existing transactional change journal. The Web and API may be deployed as separate services. Browser-side storage credentials or an unauthenticated upload endpoint would not be acceptable.

The first authoring increment deliberately did not fake media upload. This decision closes that gap with a provider-neutral metadata model and an S3-compatible object adapter.

## Decision

1. **Use S3-compatible object storage for image bytes.** Support AWS S3 and compatible services through `MEDIA_S3_BUCKET`, `MEDIA_S3_REGION`, `MEDIA_S3_ACCESS_KEY_ID`, `MEDIA_S3_SECRET_ACCESS_KEY`, and optional `MEDIA_S3_ENDPOINT` / `MEDIA_S3_FORCE_PATH_STYLE`. Credentials are server-only; never add them to client-visible `NEXT_PUBLIC_*` variables. The service bucket must block public object access.
2. **Use a server-mediated upload, not a browser-to-bucket presigned upload in this increment.** The Web sends a bounded binary body to a same-origin route; the API authenticates the writer, validates the content, normalizes the image, and writes only the normalized bytes to object storage. This means untrusted source bytes and metadata do not bypass the normalizer, and the bucket key and credentials remain private.
3. **Accept only JPEG, PNG and WebP, up to 8 MiB.** Reject unsupported and animated/multipage formats, verify the detected file type against the request media type, cap decoded pixels and source dimensions, honor orientation, resize to at most 2560×2560, and re-encode to WebP. The normalized output, not the original upload, is persisted; re-encoding strips source metadata such as EXIF.
4. **Persist portable metadata in SQL, never image bytes.** The `media_assets` table contains an opaque UUID, owner, unique object key, `image/webp` type, byte size, dimensions, SHA-256 and creation time. SQLite and PostgreSQL have provider-specific migrations, and writes go through their persistence adapters so opt-in provider migration capture records the asset row within the same database transaction.
5. **Serve assets by an opaque same-origin UUID route.** `/api/media/:uuid` proxies to the API; the API verifies stored size and SHA-256 before responding. Responses use WebP, ETag, immutable caching and `X-Content-Type-Options: nosniff`. Storage keys are never returned to the browser.
6. **Fail closed when storage is not configured.** If all `MEDIA_S3_*` variables are absent, text authoring remains usable and upload returns `503 MEDIA_STORAGE_UNAVAILABLE`. A partial configuration fails API startup. Production deployments must configure private storage and TLS for the Web/API endpoints.

## Consequences and operational limits

- Bucket data is separate from SQLite/PostgreSQL backups. Back up and retain it according to the deployment's media-retention policy.
- If SQL metadata creation fails after a successful object write, the service attempts to delete the object before returning the original database error. If object deletion itself is unavailable, the object can remain orphaned; a reconciler/garbage-collection job is a future operational improvement.
- There is not yet an application-level media delete or replacement workflow. Do not manually delete bucket objects while their metadata may still be referenced by published content.
- Comment composition is intentionally text-only with a reduced Lexical feature set; comments do not embed images.

## Validation contract

- Web and API enforce request-origin, body-size and media-type boundaries independently.
- API image normalization tests verify byte signatures, bounded dimensions/output size and rejection of mismatched types.
- SQLite and PostgreSQL integration coverage verifies the portable metadata schema and adapter behavior.
- The public media endpoint checks object size and SHA-256 before serving normalized content.
