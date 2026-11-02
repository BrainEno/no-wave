import type { MetaDescriptor } from "react-router";

/**
 * Adapter from the project's framework-neutral metadata objects
 * (`articleMetadata`, `archiveMetadata`, `homeMetadata` in
 * `@bot-thk/web-ui`'s `lib/content.ts`) to React Router's `meta` descriptor
 * array.
 *
 * Keeping the conversion here means the SEO contract — canonical URL, hreflang
 * alternates, Open Graph fields — stays in one shared, framework-free place
 * while the framework-specific spelling lives in one 40-line file.
 */
/**
 * The site title template.
 *
 * The title template the whole site is rendered with, so a page carries the
 * same `<title>` wherever it is served from — part of the SEO contract the
 * migration set out to preserve.
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
 * A URL as the site publishes it.
 *
 * `new URL("/", origin).toString()` ends in a slash, while the site root is
 * published as the bare origin (`https://site.example`). Both identify the same
 * resource, so this is cosmetic — but canonical URLs are compared byte for byte
 * in the tests, and one spelling in one adapter is cheaper than a permanent
 * exception.
 */
function routerUrl(href: string): string {
  if (!href.endsWith("/")) return href;
  try {
    return new URL(href).pathname === "/" ? href.slice(0, -1) : href;
  } catch {
    return href;
  }
}

/**
 * The site origin published by the root loader, read back inside `meta`.
 *
 * `meta` runs in the browser as well as on the server, so it must not touch
 * `process.env`; the root loader is what reads the environment. See the comment
 * on `loader()` in `app/root.tsx` for what went wrong when it did.
 *
 * Returns `undefined` rather than a guess when the root loader has not run — an
 * error boundary render, for instance — and the metadata helpers then fall back
 * to their own default. A canonical URL that is wrong is worse than the
 * documented placeholder, because the placeholder is at least recognisable.
 */
export function siteUrlFromMatches(
  matches: readonly { id: string; loaderData?: unknown }[] | undefined,
): string | undefined {
  const root = matches?.find((match) => match.id === "root");
  const data = root?.loaderData as { siteUrl?: unknown } | undefined;
  return typeof data?.siteUrl === "string" && data.siteUrl.trim() ? data.siteUrl.trim() : undefined;
}

/**
 * @param absoluteTitle — render the page title without the site suffix.
 *
 * The site's title template applies to descendant segments only, so `/` is
 * served with the bare home title while `/en` (one segment deeper) carries
 * " | 无浪潮". `metaDescriptors` mirrors both, and the home route passes
 * `absoluteTitle` for the root.
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
  if (canonical) descriptors.push({ tagName: "link", rel: "canonical", href: routerUrl(canonical) });

  for (const [locale, href] of Object.entries(metadata.alternates?.languages ?? {})) {
    descriptors.push({ tagName: "link", rel: "alternate", hrefLang: locale, href: routerUrl(href) });
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
