import { useLoaderData } from "react-router";
import type { HeadersFunction, LoaderFunctionArgs, MetaFunction } from "react-router";
import type { Locale } from "@/lib/content.ts";
import { loadAuthorIndexPage } from "@/lib/public-pages.ts";
import { parsePage } from "@/lib/work-types.ts";
import { AuthorIndexContent } from "@/components/discovery-pages.tsx";
import { PUBLIC_PAGE_HEADERS } from "../lib/http-policy.ts";
import { upstreamUnavailable } from "../lib/loader-errors.ts";
import { localeFor } from "../lib/locale.ts";
import { titleWithSite } from "../lib/meta.ts";

/**
 * The author directory (`/authors`, `/en/authors`) — ADR 0024.
 *
 * A thin loader, like every other public route: the data access lives in
 * `loadAuthorIndexPage` so the next framework inherits it, and the page itself
 * is a shared component that names no framework either.
 *
 * `q` and `page` are both in the URL, so a filtered or paged directory is a link
 * a reader can send to somebody.
 */
export async function loader({ url }: LoaderFunctionArgs) {
  const locale = localeFor(url);
  try {
    return await loadAuthorIndexPage({
      locale,
      query: (url.searchParams.get("q") ?? "").slice(0, 200),
      page: parsePage(url.searchParams.get("page") ?? undefined),
    });
  } catch (error: unknown) {
    throw upstreamUnavailable(error);
  }
}

export const headers: HeadersFunction = () => PUBLIC_PAGE_HEADERS;

export const meta: MetaFunction<typeof loader> = ({ loaderData }) => {
  const locale: Locale = loaderData?.locale ?? "zh-CN";
  const english = locale === "en";
  return [
    { title: titleWithSite(english ? "Authors" : "作者") },
    {
      name: "description",
      content: english
        ? "Every writer published on No Wave, and what they have written."
        : "无浪潮全部发表过作品的作者，以及他们写了些什么。",
    },
  ];
};

export default function AuthorsRoute() {
  const { locale, authors, query, page, hasNextPage } = useLoaderData<typeof loader>();
  return <AuthorIndexContent locale={locale} authors={authors} query={query} page={page} hasNextPage={hasNextPage} />;
}
