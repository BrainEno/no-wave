import type { MetaDescriptor } from "react-router";

/**
 * Adapter from the project's framework-neutral metadata objects
 * (`articleMetadata`, `archiveMetadata`, `homeMetadata` in `apps/web/src/lib/content.ts`)
 * to React Router's `meta` descriptor array.
 *
 * Keeping the conversion here means the SEO contract — canonical URL, hreflang
 * alternates, Open Graph fields — stays in one shared, framework-free place
 * while the framework-specific spelling lives in one 40-line file.
 */
export type SharedMetadata = {
  title: string;
  description?: string;
  alternates?: { canonical?: string; languages?: Record<string, string> };
  openGraph?: { type?: string; title?: string; description?: string; url?: string; locale?: string };
};

export function metaDescriptors(metadata: SharedMetadata): MetaDescriptor[] {
  const descriptors: MetaDescriptor[] = [{ title: metadata.title }];
  if (metadata.description) descriptors.push({ name: "description", content: metadata.description });

  const canonical = metadata.alternates?.canonical;
  if (canonical) descriptors.push({ tagName: "link", rel: "canonical", href: canonical });

  for (const [locale, href] of Object.entries(metadata.alternates?.languages ?? {})) {
    descriptors.push({ tagName: "link", rel: "alternate", hrefLang: locale, href });
  }

  const openGraph = metadata.openGraph;
  if (openGraph) {
    if (openGraph.type) descriptors.push({ property: "og:type", content: openGraph.type });
    if (openGraph.title) descriptors.push({ property: "og:title", content: openGraph.title });
    if (openGraph.description) descriptors.push({ property: "og:description", content: openGraph.description });
    if (openGraph.url) descriptors.push({ property: "og:url", content: openGraph.url });
    if (openGraph.locale) descriptors.push({ property: "og:locale", content: openGraph.locale });
  }

  return descriptors;
}
