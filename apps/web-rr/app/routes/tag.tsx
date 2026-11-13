import { useLoaderData } from "react-router";
import type { HeadersFunction, LoaderFunctionArgs, MetaFunction } from "react-router";
import { TagDetailView } from "@/components/public/tag-view.tsx";
import { loadTagDetailPage } from "@/lib/tag-pages.ts";
import { isTagSlug, tagDetailMetadata, tagPage } from "@/lib/tag-discovery.ts";
import { tagFeedLinks } from "@/lib/tag-feed.ts";
import { PUBLIC_PAGE_HEADERS } from "../lib/http-policy.ts";
import { entityNotFound, upstreamUnavailable } from "../lib/loader-errors.ts";
import { localeFor } from "../lib/locale.ts";
import { metaDescriptors, siteUrlFromMatches } from "../lib/meta.ts";

export async function loader({ params, url }: LoaderFunctionArgs) {
  if (!isTagSlug(params.slug)) throw entityNotFound("tag-not-found");
  let loaded;
  try {
    loaded = await loadTagDetailPage({ locale: localeFor(url), slug: params.slug, page: tagPage(url.searchParams.get("page") ?? undefined) });
  } catch (error: unknown) {
    throw upstreamUnavailable(error);
  }
  if (!loaded.tag) throw entityNotFound("tag-not-found");
  return { ...loaded, tag: loaded.tag };
}

export const headers: HeadersFunction = () => PUBLIC_PAGE_HEADERS;

export const meta: MetaFunction<typeof loader> = ({ loaderData, matches }) => {
  if (!loaderData) return [];
  const metadata = tagDetailMetadata(loaderData.tag, loaderData.locale, loaderData.page, siteUrlFromMatches(matches));
  return [...metaDescriptors(metadata), ...tagFeedLinks(loaderData.tag.slug, loaderData.locale).map((link) => ({
    tagName: "link" as const, rel: "alternate", type: link.type, title: link.title,
    href: new URL(link.href, metadata.alternates.canonical).toString(),
  }))];
};

export default function TagRoute() {
  return <TagDetailView {...useLoaderData<typeof loader>()} />;
}
