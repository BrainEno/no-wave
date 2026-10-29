import { data, useLoaderData } from "react-router";
import type { HeadersFunction, LoaderFunctionArgs, MetaFunction } from "react-router";
import { authorMetadata } from "@/lib/content.ts";
import { getPublicAuthor } from "@/lib/api-content.ts";
import { loadAuthorPage } from "@/lib/public-pages.ts";
import { parsePage, parseWorkType } from "@/lib/work-types.ts";
import { AuthorPageView } from "@/components/public/author-view.tsx";
import { PUBLIC_PAGE_HEADERS } from "../lib/http-policy.ts";
import { entityNotFound, upstreamUnavailable } from "../lib/loader-errors.ts";
import { localeFor } from "../lib/locale.ts";
import { metaDescriptors, titleWithSite } from "../lib/meta.ts";
import { siteUrl } from "../lib/runtime.ts";

/**
 * Public author profile for `/authors/:username` and `/en/authors/:username`.
 *
 * An unknown author is a hard 404 thrown from the loader: the status must be
 * decided before any HTML is committed, or a search engine would index a soft
 * 404. The two API calls (author, then their works) are sequential because the
 * second is meaningless without the first.
 */
export async function loader({ params, request }: LoaderFunctionArgs) {
  const locale = localeFor(request);
  const url = new URL(request.url);

  let author;
  try {
    author = await getPublicAuthor(params.username ?? "", locale);
  } catch (error: unknown) {
    throw upstreamUnavailable(error);
  }
  // Thrown outside the try block on purpose: a 404 must reach the boundary as a
  // 404, not be re-labelled as an upstream failure.
  if (!author) throw entityNotFound("author-not-found");

  try {
    return await loadAuthorPage({
      locale,
      author,
      page: parsePage(url.searchParams.get("page") ?? undefined),
      type: parseWorkType(url.searchParams.get("type") ?? undefined),
    });
  } catch (error: unknown) {
    throw upstreamUnavailable(error);
  }
}

export const headers: HeadersFunction = () => PUBLIC_PAGE_HEADERS;

export const meta: MetaFunction<typeof loader> = ({ data }) => {
  if (!data) return [{ title: titleWithSite(undefined) }];
  return metaDescriptors(authorMetadata(data.author, siteUrl()));
};

export default function AuthorRoute() {
  return <AuthorPageView {...useLoaderData<typeof loader>()} />;
}
