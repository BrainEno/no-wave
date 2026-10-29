import { data, useLoaderData } from "react-router";
import type { HeadersFunction, LoaderFunctionArgs, MetaFunction } from "react-router";
import { loadCategoryDetailPage } from "@/lib/public-pages.ts";
import { parsePage } from "@/lib/work-types.ts";
import { CategoryDetailContent } from "@/components/discovery-pages.tsx";
import { PUBLIC_PAGE_HEADERS } from "../lib/http-policy.ts";
import { upstreamUnavailable } from "../lib/loader-errors.ts";
import { localeFor } from "../lib/locale.ts";

/**
 * Category detail for `/categories/:slug` and `/en/categories/:slug`.
 *
 * The category and its article page are fetched together: one round trip on the
 * happy path, and an unknown slug still answers 404 before any HTML is sent.
 */
export async function loader({ params, request }: LoaderFunctionArgs) {
  const locale = localeFor(request);
  const url = new URL(request.url);

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
  if (!loaded.category) throw data({ reason: "category-not-found", slug: params.slug ?? null }, { status: 404 });
  // Narrowed: the view requires a category, and the route has already answered
  // 404 when there is none.
  return { locale: loaded.locale, category: loaded.category, articles: loaded.articles, page: loaded.page, hasNextPage: loaded.hasNextPage };
}

export const headers: HeadersFunction = () => PUBLIC_PAGE_HEADERS;

export const meta: MetaFunction<typeof loader> = ({ data }) => {
  if (!data) return [{ title: "页面未找到 | 无浪潮" }];
  return [
    { title: data.category.name },
    { name: "description", content: data.category.description || `浏览「${data.category.name}」分类中的已发表作品。` },
  ];
};

export default function CategoryRoute() {
  const { locale, category, articles, page, hasNextPage } = useLoaderData<typeof loader>();
  return <CategoryDetailContent locale={locale} category={category} articles={articles} page={page} hasNextPage={hasNextPage} />;
}
