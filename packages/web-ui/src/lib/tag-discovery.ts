import { siteUrl as fallbackSiteUrl, type Locale } from "./content.ts";
import { MAX_PAGE, parsePage } from "./work-types.ts";

export type TagReference = { slug: string; name: string };
export type TagView = TagReference & { description: string; locale: Locale; articleCount: number };
export const TAG_PAGE_SIZE = 20;
export const TAG_QUERY_LIMIT = 200;
/** Same bounded browsing window as the other Web directories, not an all-tags scan. */
export const TAG_MAX_PAGE = MAX_PAGE;

export function isTagSlug(value: unknown): value is string {
  return typeof value === "string" && value.length <= 160 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value);
}

/** The API counts UTF-16 units; never split a supplementary character at the cap. */
export function tagSearchQuery(value: string): string {
  const normalized = value.normalize("NFKC").trim().replace(/^#/, "").trim();
  let result = "";
  for (const character of normalized) {
    if (result.length + character.length > TAG_QUERY_LIMIT) break;
    result += character;
  }
  return result;
}

export function tagPage(value: string | number | undefined): number {
  return parsePage(typeof value === "number" ? String(value) : value);
}

export function tagIndexPath(locale: Locale): string {
  return locale === "en" ? "/en/tags" : "/tags";
}

/** A stored slug is identity. Never infer it from a Unicode display name. */
export function tagPath(slug: string, locale: Locale): string {
  if (!isTagSlug(slug)) throw new Error("Invalid public tag slug.");
  return `${tagIndexPath(locale)}/${encodeURIComponent(slug)}`;
}

export function tagIndexHref(locale: Locale, query = "", page = 1): string {
  const params = new URLSearchParams();
  const normalized = tagSearchQuery(query);
  if (normalized) params.set("q", normalized);
  const current = tagPage(page);
  if (current > 1) params.set("page", String(current));
  return `${tagIndexPath(locale)}${params.size ? `?${params}` : ""}`;
}

export function tagDetailHref(slug: string, locale: Locale, page = 1): string {
  const current = tagPage(page);
  return `${tagPath(slug, locale)}${current > 1 ? `?page=${current}` : ""}`;
}

/** Bad optional references degrade to readable labels, never guessed or external links. */
export function articleTagItems(names: readonly string[], references: readonly TagReference[] = []) {
  const byName = new Map<string, TagReference>();
  for (const reference of references) {
    if (isTagSlug(reference.slug) && !byName.has(reference.name)) byName.set(reference.name, reference);
  }
  const seen = new Set<string>();
  return names.flatMap((name) => {
    if (seen.has(name)) return [];
    seen.add(name);
    const reference = byName.get(name);
    return [{ name, slug: reference?.slug ?? null }];
  });
}

function absolute(href: string, siteUrl?: string): string {
  return new URL(href, siteUrl?.trim() || fallbackSiteUrl).toString();
}

export function tagIndexMetadata(locale: Locale, query = "", page = 1, siteUrl?: string) {
  const normalized = tagSearchQuery(query);
  const current = tagPage(page);
  const english = locale === "en";
  const title = english ? "Tags" : "标签";
  const description = english ? "Discover published writing through community hashtags." : "通过作者使用的标签，发现已经发表的文学作品。";
  const canonical = absolute(tagIndexHref(locale, normalized, current), siteUrl);
  return {
    title: current > 1 ? `${title} · ${english ? "Page" : "第"} ${current}${english ? "" : " 页"}` : title,
    description,
    alternates: { canonical },
    openGraph: { type: "website", title, description, url: canonical, locale: english ? "en_US" : "zh_CN" },
    // Arbitrary queries are useful links, not an infinite indexable URL space.
    robots: normalized ? "noindex, follow" : "index, follow",
  };
}

export function tagDetailMetadata(tag: TagView, locale: Locale, page = 1, siteUrl?: string) {
  const current = tagPage(page);
  const english = locale === "en";
  const title = `#${tag.name}`;
  const description = tag.description || (english ? `Published writing tagged #${tag.name}.` : `阅读标签「${tag.name}」下已经发表的作品。`);
  const canonical = absolute(tagDetailHref(tag.slug, locale, current), siteUrl);
  return {
    title: current > 1 ? `${title} · ${english ? "Page" : "第"} ${current}${english ? "" : " 页"}` : title,
    description,
    alternates: { canonical },
    // No invented hreflang: a tag's translation in another locale is not known here.
    openGraph: { type: "website", title, description, url: canonical, locale: english ? "en_US" : "zh_CN" },
  };
}
