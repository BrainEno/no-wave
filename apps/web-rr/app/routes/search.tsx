import { useLoaderData } from "react-router";
import type { HeadersFunction, LoaderFunctionArgs, MetaFunction } from "react-router";
import type { Locale } from "@/lib/content.ts";
import { loadSearchPage, parseTab } from "@/lib/public-pages.ts";
import { parseWorkType } from "@/lib/work-types.ts";
import { SearchPageView } from "@/components/public/search-view.tsx";
import { PRIVATE_PAGE_HEADERS } from "../lib/http-policy.ts";
import { upstreamUnavailable } from "../lib/loader-errors.ts";
import { localeFor } from "../lib/locale.ts";
import { titleWithSite } from "../lib/meta.ts";

/**
 * Site search (`/search`, `/en/search`).
 *
 * Like the App Router version it is `no-store` and `robots: noindex, follow`:
 * results depend on an arbitrary query string, so a shared cache would only
 * collect low-hit-rate entries.
 */
export async function loader({ request }: LoaderFunctionArgs) {
  const locale = localeFor(request);
  const url = new URL(request.url);
  try {
    return await loadSearchPage({
      locale,
      query: (url.searchParams.get("q") ?? "").slice(0, 100),
      tab: parseTab(url.searchParams.get("tab") ?? undefined),
      type: parseWorkType(url.searchParams.get("type") ?? undefined),
    });
  } catch (error: unknown) {
    throw upstreamUnavailable(error);
  }
}

export const headers: HeadersFunction = () => PRIVATE_PAGE_HEADERS;

export const meta: MetaFunction<typeof loader> = ({ data }) => {
  const locale: Locale = data?.locale ?? "zh-CN";
  // Same strings as `app/search/page.tsx` and `app/en/search/page.tsx`: the title
  // and description are part of what the migration must not change.
  const english = locale === "en";
  return [
    { title: titleWithSite(english ? "Search" : "搜索") },
    {
      name: "description",
      content: english
        ? "Search works, authors and categories published on No Wave."
        : "按作品、作者与分类搜索无浪潮发表的文学作品。",
    },
    { name: "robots", content: "noindex, follow" },
  ];
};

export default function SearchRoute() {
  return <SearchPageView {...useLoaderData<typeof loader>()} />;
}
