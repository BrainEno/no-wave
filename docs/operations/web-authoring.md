# Web article authoring

## Current scope

The authenticated writing desk is available at `/write`. It supports create, draft save, continue editing a saved draft, update an already-published article, and publish through the existing REST contract. The editor supports paragraph text, h2–h4 headings, quotes without attributions, flat ordered/unordered lists, bold/italic/underline/strikethrough, links, and code blocks.

Image blocks and quotes with attribution are rejected before loading the editor. The UI does not remove or replace unsupported blocks silently. Media upload is intentionally not emulated with a fake endpoint; storage provider selection, signed upload authorization, content-type/size limits, image re-encoding, EXIF removal, persistence and cleanup need their own reviewed implementation. Comment composition is also out of scope for this increment.

## Authentication boundary

The browser never receives the access or refresh token in JSON. The Next.js same-origin auth route writes them to HttpOnly cookies; the access cookie is scoped to `/api/authoring`, and the refresh cookie is scoped to `/api`. Cookies use SameSite=Lax and Secure on HTTPS. Mutating requests require the exact request origin and an application/json body; write bodies are size-limited. The server-side proxy attaches the Bearer token, rotates refresh tokens on an API 401, retries once, and clears cookies after an invalid or expired refresh token.

This does not complete the account lifecycle: email verification, password recovery, operational abuse controls and full production security review remain separate work. Deploy only over HTTPS outside local development, configure `API_BASE_URL` or the Vercel service binding, and keep the API reachable only via the intended network boundary.

## Contract

Article writes send a Lexical `editorState` plus `contentBlocksVersion: 1` to `POST /api/v1/articles` or `PUT /api/v1/articles/:id`. The existing API adapter validates and converts the state into the application-owned `contentBlocks` contract; the database does not store Lexical's internal state format. The writer lists its own drafts/published posts through `GET /api/v1/me/articles`. Browser routes are same-origin server proxies, not a replacement for API-side authorization.

Lexical packages are all pinned to the same release. API-side compatibility tests ensure the state produced by the Web block adapter is accepted by the existing backend adapter.
