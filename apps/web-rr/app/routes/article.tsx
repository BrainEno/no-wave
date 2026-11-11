import { useLoaderData } from "react-router";
import type { HeadersFunction, LoaderFunctionArgs, MetaFunction } from "react-router";
import { articleMetadata } from "@/lib/content.ts";
import { loadArticleDetailPage } from "@/lib/public-pages.ts";
import { ArticlePageView } from "@/components/public/article-view.tsx";
import { PUBLIC_PAGE_HEADERS } from "../lib/http-policy.ts";
import { entityNotFound, isPublicEntitySlug, upstreamUnavailable } from "../lib/loader-errors.ts";
import { metaDescriptors, siteUrlFromMatches, titleWithSite } from "../lib/meta.ts";
import { localeFor } from "../lib/locale.ts";

/**
 * Public article route, served for both `/articles/:slug` and `/en/articles/:slug`.
 *
 * Phase 4a: this route used to hand-write a reduced body, because the App
 * Router's `ArticleDetailContent` is an async server component and could not be
 * imported here. The result was a page that looked right and was quietly
 * missing its reader toolbar, table of contents and comment section — none of
 * which any HTML comparison can see, because the markup was never rendered.
 *
 * The load/render split removes the reason for the shortcut: the loader calls
 * the shared `loadArticleDetailPage`, and `ArticlePageView` is the shared view,
 * interactive parts included.
 */
export async function loader({ params, url }: LoaderFunctionArgs) {
  const locale = localeFor(url);
  if (!isPublicEntitySlug(params.slug)) throw entityNotFound("article-not-found");
  let page: Awaited<ReturnType<typeof loadArticleDetailPage>>;
  try {
    page = await loadArticleDetailPage({ slug: params.slug ?? "", locale });
  } catch (error: unknown) {
    throw upstreamUnavailable(error);
  }
  // Throwing keeps the framework from committing a 200 shell before the status is
  // known, so an unknown article is a hard 404 rather than a soft 404 page.
  if (!page) throw entityNotFound("article-not-found");
  return page;
}

export const headers: HeadersFunction = () => PUBLIC_PAGE_HEADERS;

export const meta: MetaFunction<typeof loader> = ({ loaderData: loaded, matches }) => {
  if (!loaded) return [{ title: titleWithSite(undefined) }];
  return metaDescriptors(articleMetadata(loaded.article, siteUrlFromMatches(matches)));
};

export default function ArticleRoute() {
  return <ArticlePageView {...useLoaderData<typeof loader>()} />;
}
