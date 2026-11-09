/**
 * The reading page's view beacon (ADR 0035).
 *
 * A counter nobody tells the server about is a column of zeroes, so the page that
 * renders a work says so — once, after it has actually mounted, and never from
 * the server render. Three details make the difference between a number that
 * means something and one that flatters the site:
 *
 * - **After mount, not during render.** A server render happens for crawlers,
 *   prefetches and link previews. Nothing that never became a page a person
 *   looked at may be counted.
 * - **Once per page load.** React's development StrictMode invokes effects twice,
 *   and a client-side navigation back to the same work is a new mount. A module
 *   level set keyed by `(slug, locale)` keeps the first, which is the read; the
 *   API's own per-reader-per-day dedupe is the second line of defence, not the
 *   only one.
 * - **Failure is silent.** A view is telemetry about a page that already worked.
 *   A rejected beacon must not show an error, retry in a loop, or log a message a
 *   reader could see.
 */

/** The proxy path the beacon posts to. Same-origin, so the session cookie rides along. */
export function articleViewBeaconPath(slug: string, locale: string): string {
  return `/api/articles/${encodeURIComponent(slug)}/views?locale=${encodeURIComponent(locale)}`;
}

export type ViewBeacon = (slug: string, locale: string) => Promise<void>;

/**
 * Build a beacon bound to one page-load's memory.
 *
 * `fetchImpl` is injected so the guard can be tested without a network, and
 * `sent` starts empty per call — which is what makes this a page-load guard
 * rather than a process-wide one.
 */
export function createViewBeacon(
  fetchImpl: (input: string, init?: RequestInit) => Promise<unknown> = (input, init) => fetch(input, init),
): ViewBeacon {
  const sent = new Set<string>();
  return async (slug: string, locale: string) => {
    const key = `${locale}:${slug}`;
    if (sent.has(key)) return;
    sent.add(key);
    try {
      await fetchImpl(articleViewBeaconPath(slug, locale), {
        method: "POST",
        headers: { accept: "application/json" },
        credentials: "same-origin",
        cache: "no-store",
        // No body: the work and the locale are the whole request.
      });
    } catch {
      // A view is about a page that already rendered. Nothing here may surface.
    }
  };
}
