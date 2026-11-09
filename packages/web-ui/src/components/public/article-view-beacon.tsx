import { useEffect } from "react";
import { createViewBeacon } from "@/lib/article-views.ts";
import type { Locale } from "@/lib/content.ts";

/**
 * The reading page's view beacon (ADR 0035) — renders nothing.
 *
 * The page-load guard lives in a module, not in the component: React's
 * development StrictMode mounts effects twice and an in-component ref would
 * still be created twice on that pass. One module-level beacon per page load is
 * exactly the granularity the API expects, and its own per-reader-per-day
 * dedupe covers the cases this cannot see (a refresh, a second tab).
 */
const beacon = createViewBeacon();

export function ArticleViewBeacon({ slug, locale }: { slug: string; locale: Locale }) {
  useEffect(() => {
    // Fire and forget: the beacon reports a page that has already rendered, and
    // `createViewBeacon` swallows its own failures.
    void beacon(slug, locale);
  }, [slug, locale]);
  return null;
}
