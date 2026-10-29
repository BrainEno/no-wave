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
/**
 * The site title template.
 *
 * Mirrors `apps/web/src/app/layout.tsx` (`title.template: "%s | 无浪潮"`), so a
 * page that is rendered by either application carries the same `<title>` — this
 * is part of the SEO parity the migration is required to preserve.
 */
export const SITE_TITLE_SUFFIX = " | 无浪潮";
export const DEFAULT_TITLE = "无浪潮 · No Wave";

export function titleWithSite(title: string | undefined): string {
  if (!title) return DEFAULT_TITLE;
  if (title === DEFAULT_TITLE || title.endsWith(SITE_TITLE_SUFFIX)) return title;
  return `${title}${SITE_TITLE_SUFFIX}`;
}

export type SharedMetadata = {
  title: string;
  description?: string;
  alternates?: { canonical?: string; languages?: Record<string, string> };
  openGraph?: { type?: string; title?: string; description?: string; url?: string; locale?: string };
};

/**
 * @param absoluteTitle — render the page title without the site suffix.
 *
 * The App Router applies its root layout's `title.template` to descendant
 * segments only, so `/` is served with the bare home title while `/en` (one
 * segment deeper) carries " | 无浪潮". The prototype mirrors both exactly.
 */
export function metaDescriptors(
  metadata: SharedMetadata,
  options: { absoluteTitle?: boolean } = {},
): MetaDescriptor[] {
  const descriptors: MetaDescriptor[] = [
    { title: options.absoluteTitle ? metadata.title ?? DEFAULT_TITLE : titleWithSite(metadata.title) },
  ];
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
