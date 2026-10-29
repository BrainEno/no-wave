/**
 * Cache policy for server-rendered pages.
 *
 * The target host (a free Render web service) sleeps when idle and wakes with a
 * cold start, so the only durable way to keep public pages fast is to let a
 * **shared** cache hold the HTML:
 *
 *   - `PUBLIC_PAGE_HEADERS` — pages whose HTML depends only on public data
 *     (home, article, archive, author, categories). `s-maxage` lets a CDN/edge
 *     reuse a response while the instance is asleep; `stale-while-revalidate`
 *     allows serving a known-stale copy during a cold start instead of making
 *     the visitor wait for the wake-up plus two API calls. `max-age=0` keeps
 *     browsers revalidating, so a stale copy can never be pinned in one client.
 *
 *   - `PRIVATE_PAGE_HEADERS` — anything rendered per user or per query
 *     (`/account`, `/search`). These stay `no-store` exactly as the App Router
 *     serves its dynamic pages; a shared cache must never hold them.
 *
 * Nothing is written to disk: the instance filesystem is ephemeral and the app
 * may be duplicated at any time, so there is no local page cache to rely on.
 */
export const PUBLIC_PAGE_HEADERS = {
  "Cache-Control": "public, max-age=0, s-maxage=60, stale-while-revalidate=300",
} as const;

export const PRIVATE_PAGE_HEADERS = {
  "Cache-Control": "no-store, max-age=0",
} as const;
