import type { LoaderFunctionArgs } from "react-router";
import { loadSitemapEntries, renderSitemapXml } from "@/lib/site-metadata.ts";
import { siteUrl } from "../lib/runtime.ts";

/**
 * `GET /sitemap.xml` — resource route.
 *
 * The entry list and the XML come from the shared builder the App Router uses,
 * so both applications publish the same URLs. Crawled repeatedly by search
 * engines, so it is shared-cacheable and its article scan is bounded
 * (`SITEMAP_MAX_PAGES`).
 */
export async function loader(_args: LoaderFunctionArgs) {
  const entries = await loadSitemapEntries({ siteUrl: siteUrl() });
  return new Response(renderSitemapXml(entries), {
    status: 200,
    headers: {
      "content-type": "application/xml; charset=utf-8",
      "cache-control": "public, max-age=0, s-maxage=3600, stale-while-revalidate=86400",
    },
  });
}
