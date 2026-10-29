import { useLoaderData } from "react-router";
import type { HeadersFunction, LoaderFunctionArgs, MetaFunction } from "react-router";
import { getMessages, type Locale } from "@/lib/content.ts";
import { loadCategoryIndexPage } from "@/lib/public-pages.ts";
import { parsePage } from "@/lib/work-types.ts";
import { CategoryIndexContent } from "@/components/discovery-pages.tsx";
import { PUBLIC_PAGE_HEADERS } from "../lib/http-policy.ts";
import { upstreamUnavailable } from "../lib/loader-errors.ts";
import { localeFor } from "../lib/locale.ts";

/**
 * Category index for `/categories` and `/en/categories`.
 *
 * `CategoryIndexContent` is a synchronous shared component, so this route
 * reuses it unmodified — the only migration work was moving the data access
 * into `loadCategoryIndexPage`.
 */
export async function loader({ request }: LoaderFunctionArgs) {
  const locale = localeFor(request);
  const url = new URL(request.url);
  try {
    return await loadCategoryIndexPage({
      locale,
      query: url.searchParams.get("q") ?? "",
      page: parsePage(url.searchParams.get("page") ?? undefined),
    });
  } catch (error: unknown) {
    throw upstreamUnavailable(error);
  }
}

export const headers: HeadersFunction = () => PUBLIC_PAGE_HEADERS;

export const meta: MetaFunction<typeof loader> = ({ data }) => {
  const locale: Locale = data?.locale ?? "zh-CN";
  const messages = getMessages(locale);
  return [
    { title: locale === "en" ? "Categories" : "作品分类" },
    { name: "description", content: messages.blogDescription },
  ];
};

export default function CategoriesRoute() {
  const { locale, categories, query, page, hasNextPage } = useLoaderData<typeof loader>();
  return <CategoryIndexContent locale={locale} categories={categories} query={query} page={page} hasNextPage={hasNextPage} />;
}
