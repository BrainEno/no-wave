import type { MetadataRoute } from "next";
import { configuredSiteUrl, loadSitemapEntries } from "@/lib/site-metadata.ts";

export const dynamic = "force-dynamic";

/**
 * The URL set is built by the shared, framework-neutral loader; this file only
 * adapts it to Next's `sitemap` convention so the React Router prototype can
 * serve the same list.
 */
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  return (await loadSitemapEntries({ siteUrl: configuredSiteUrl() })) as MetadataRoute.Sitemap;
}
