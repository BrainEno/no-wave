import { publicContentSource } from "../lib/runtime.ts";
import { useLoaderData } from "react-router";
import type { HeadersFunction, LoaderFunctionArgs, MetaFunction } from "react-router";
import type { Locale } from "@/lib/content.ts";
import { loadCategoryIndexPage } from "@/lib/public-pages.ts";
import { CategoryIndexContent } from "@/components/discovery-pages.tsx";
import { PUBLIC_PAGE_HEADERS } from "../lib/http-policy.ts";
import { upstreamUnavailable } from "../lib/loader-errors.ts";
import { localeFor } from "../lib/locale.ts";
import { titleWithSite } from "../lib/meta.ts";

/**
 * `/categories` and `/en/categories`: the three genres, 小说 / 诗歌 / 其他文体
 * (ADR 0054), with their counts. `?q` and `?page` belonged to the old list of
 * editor categories and are ignored now.
 */
export async function loader({ request, url }: LoaderFunctionArgs) {
  const locale = localeFor(url);
  try {
    return await loadCategoryIndexPage({ locale }, publicContentSource(request));
  } catch (error: unknown) {
    throw upstreamUnavailable(error);
  }
}

export const headers: HeadersFunction = () => PUBLIC_PAGE_HEADERS;

export const meta: MetaFunction<typeof loader> = ({ loaderData }) => {
  const locale: Locale = loaderData?.locale ?? "zh-CN";
  const english = locale === "en";
  return [
    { title: titleWithSite(english ? "Genres" : "作品分类") },
    {
      name: "description",
      content: english
        ? "Fiction, poetry and other forms: the three genres of No Wave."
        : "小说、诗歌与其他文体：按三种体裁浏览无浪潮的作品。",
    },
  ];
};

export default function CategoriesRoute() {
  const { locale, genres } = useLoaderData<typeof loader>();
  return <CategoryIndexContent locale={locale} genres={genres} />;
}
