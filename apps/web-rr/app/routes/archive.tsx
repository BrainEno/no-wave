import { useLoaderData } from "react-router";
import type { HeadersFunction, LoaderFunctionArgs, MetaFunction } from "react-router";
import { archiveMetadata } from "@/lib/content.ts";
import { loadArchivePage } from "@/lib/public-pages.ts";
import { parsePage, parseWorkType } from "@/lib/work-types.ts";
import { ArchivePageView } from "@/components/public/archive-view.tsx";
import { PUBLIC_PAGE_HEADERS } from "../lib/http-policy.ts";
import { upstreamUnavailable } from "../lib/loader-errors.ts";
import { localeFor } from "../lib/locale.ts";
import { metaDescriptors } from "../lib/meta.ts";
import { siteUrl } from "../lib/runtime.ts";

/**
 * Public archive (作品目录) for `/articles` and `/en/articles`.
 *
 * The route is deliberately thin: `loadArchivePage` performs the (at most two)
 * API calls and `ArchivePageView` renders the result. Both are shared with the
 * Next.js application, so the two frameworks cannot drift in either direction —
 * they would have to drift in the shared module.
 */
export async function loader({ request }: LoaderFunctionArgs) {
  const locale = localeFor(request);
  const url = new URL(request.url);
  try {
    return await loadArchivePage({
      locale,
      query: url.searchParams.get("q") ?? "",
      page: parsePage(url.searchParams.get("page") ?? undefined),
      type: parseWorkType(url.searchParams.get("type") ?? undefined),
    });
  } catch (error: unknown) {
    throw upstreamUnavailable(error);
  }
}

export const headers: HeadersFunction = () => PUBLIC_PAGE_HEADERS;

export const meta: MetaFunction<typeof loader> = ({ data }) =>
  metaDescriptors(archiveMetadata(data?.locale ?? "zh-CN", siteUrl()));

export default function ArchiveRoute() {
  return <ArchivePageView {...useLoaderData<typeof loader>()} />;
}
