import { useLoaderData } from "react-router";
import type { HeadersFunction, LoaderFunctionArgs, MetaFunction } from "react-router";
import { getMessages, type Locale } from "@/lib/content.ts";
import { loadSearchPage, parseTab } from "@/lib/public-pages.ts";
import { parseWorkType } from "@/lib/work-types.ts";
import { SearchPageView } from "@/components/public/search-view.tsx";
import { PRIVATE_PAGE_HEADERS } from "../lib/http-policy.ts";
import { upstreamUnavailable } from "../lib/loader-errors.ts";
import { localeFor } from "../lib/locale.ts";

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
  const messages = getMessages(locale);
  return [
    { title: messages.searchLabel },
    { name: "robots", content: "noindex, follow" },
  ];
};

export default function SearchRoute() {
  return <SearchPageView {...useLoaderData<typeof loader>()} />;
}
