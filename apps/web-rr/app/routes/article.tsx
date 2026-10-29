import { useLoaderData } from "react-router";
import type { HeadersFunction, LoaderFunctionArgs, MetaFunction } from "react-router";
import { articleMetadata } from "@/lib/content.ts";
import { loadArticleDetailPage } from "@/lib/public-pages.ts";
import { ArticlePageView } from "@/components/public/article-view.tsx";
import { PUBLIC_PAGE_HEADERS } from "../lib/http-policy.ts";
import { entityNotFound, upstreamUnavailable } from "../lib/loader-errors.ts";
import { metaDescriptors, titleWithSite } from "../lib/meta.ts";
import { localeFor } from "../lib/locale.ts";
import { siteUrl } from "../lib/runtime.ts";

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
 * the shared `loadArticleDetailPage`, and `ArticlePageView` is the same
 * component the App Router renders, interactive parts included.
 */
export async function loader({ params, request }: LoaderFunctionArgs) {
  const locale = localeFor(request);
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

export const meta: MetaFunction<typeof loader> = ({ data: loaded }) => {
  if (!loaded) return [{ title: titleWithSite(undefined) }];
  return metaDescriptors(articleMetadata(loaded.article, siteUrl()));
};

export default function ArticleRoute() {
  return <ArticlePageView {...useLoaderData<typeof loader>()} />;
}
