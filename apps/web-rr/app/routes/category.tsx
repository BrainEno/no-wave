import { data, useLoaderData } from "react-router";
import type { HeadersFunction, LoaderFunctionArgs, MetaFunction } from "react-router";
import { loadCategoryDetailPage } from "@/lib/public-pages.ts";
import { parsePage } from "@/lib/work-types.ts";
import { CategoryDetailContent } from "@/components/discovery-pages.tsx";
import { PUBLIC_PAGE_HEADERS } from "../lib/http-policy.ts";
import { entityNotFound, upstreamUnavailable } from "../lib/loader-errors.ts";
import { localeFor } from "../lib/locale.ts";
import { titleWithSite } from "../lib/meta.ts";

/**
 * Category detail for `/categories/:slug` and `/en/categories/:slug`.
 *
 * The category and its article page are fetched together: one round trip on the
 * happy path, and an unknown slug still answers 404 before any HTML is sent.
 */
export async function loader({ params, url }: LoaderFunctionArgs) {
  const locale = localeFor(url);

  let loaded;
  try {
    loaded = await loadCategoryDetailPage({
      locale,
      slug: params.slug ?? "",
      page: parsePage(url.searchParams.get("page") ?? undefined),
    });
  } catch (error: unknown) {
    throw upstreamUnavailable(error);
  }
  // Unknown slug: 404 before any HTML is committed, never a soft 404.
  if (!loaded.category) throw entityNotFound("category-not-found");
  // Narrowed: the view requires a category, and the route has already answered
  // 404 when there is none.
  return { locale: loaded.locale, category: loaded.category, articles: loaded.articles, page: loaded.page, hasNextPage: loaded.hasNextPage };
}

export const headers: HeadersFunction = () => PUBLIC_PAGE_HEADERS;

export const meta: MetaFunction<typeof loader> = ({ loaderData }) => {
  if (!loaderData) return [{ title: titleWithSite(undefined) }];
  return [
    { title: titleWithSite(loaderData.category.name) },
    { name: "description", content: loaderData.category.description || `浏览「${loaderData.category.name}」分类中的已发表作品。` },
  ];
};

export default function CategoryRoute() {
  const { locale, category, articles, page, hasNextPage } = useLoaderData<typeof loader>();
  return <CategoryDetailContent locale={locale} category={category} articles={articles} page={page} hasNextPage={hasNextPage} />;
}
