import { useLoaderData } from "react-router";
import type { HeadersFunction, LoaderFunctionArgs, MetaFunction } from "react-router";
import { TagIndexView } from "@/components/public/tag-view.tsx";
import { loadTagIndexPage } from "@/lib/tag-pages.ts";
import { tagIndexMetadata, tagPage } from "@/lib/tag-discovery.ts";
import { PRIVATE_PAGE_HEADERS } from "../lib/http-policy.ts";
import { upstreamUnavailable } from "../lib/loader-errors.ts";
import { localeFor } from "../lib/locale.ts";
import { metaDescriptors, siteUrlFromMatches } from "../lib/meta.ts";

export async function loader({ url }: LoaderFunctionArgs) {
  try {
    return await loadTagIndexPage({ locale: localeFor(url), query: url.searchParams.get("q") ?? "", page: tagPage(url.searchParams.get("page") ?? undefined) });
  } catch (error: unknown) {
    throw upstreamUnavailable(error);
  }
}

// Queries are unbounded URL variants even though each individual read is bounded.
export const headers: HeadersFunction = () => PRIVATE_PAGE_HEADERS;

export const meta: MetaFunction<typeof loader> = ({ loaderData, matches }) => {
  if (!loaderData) return [];
  const metadata = tagIndexMetadata(loaderData.locale, loaderData.query, loaderData.page, siteUrlFromMatches(matches));
  return [...metaDescriptors(metadata), { name: "robots", content: metadata.robots }];
};

export default function TagsRoute() {
  return <TagIndexView {...useLoaderData<typeof loader>()} />;
}
