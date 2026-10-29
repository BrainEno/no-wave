import { useLoaderData } from "react-router";
import type { HeadersFunction, LoaderFunctionArgs, MetaFunction } from "react-router";
import { homeMetadata, type Locale } from "@/lib/content.ts";
import { loadHomePage } from "@/lib/public-pages.ts";
import { HomePageView } from "@/components/public/home-view.tsx";
import { PUBLIC_PAGE_HEADERS } from "../lib/http-policy.ts";
import { upstreamUnavailable } from "../lib/loader-errors.ts";
import { localeFor } from "../lib/locale.ts";
import { metaDescriptors } from "../lib/meta.ts";
import { siteUrl } from "../lib/runtime.ts";

/**
 * Home (`/`, `/en`) — the last public page of Phase 3.
 *
 * It replaces the Phase 2 placeholder and renders the **shared** `HomePageView`,
 * the same component the App Router renders through `HomeContent`. The three
 * client components it composes (intro loader, WebGL hero, hover-switched latest
 * list) are framework-neutral apart from `next/link`, so they hydrate here
 * exactly as they do in Next.js; only their *behavior* belongs to Phase 4, which
 * is why the tests below assert server-rendered structure and not animation.
 */
export async function loader({ request }: LoaderFunctionArgs) {
  const locale = localeFor(request);
  try {
    return await loadHomePage({ locale });
  } catch (error: unknown) {
    throw upstreamUnavailable(error);
  }
}

export const headers: HeadersFunction = () => PUBLIC_PAGE_HEADERS;

export const meta: MetaFunction<typeof loader> = ({ data }) => {
  const locale: Locale = data?.locale ?? "zh-CN";
  // `/` is the root segment, where the App Router's title template does not
  // apply; `/en` is a segment deeper and does carry the suffix. Mirror both.
  return metaDescriptors(homeMetadata(locale, siteUrl()), { absoluteTitle: locale === "zh-CN" });
};

export default function HomeRoute() {
  return <HomePageView {...useLoaderData<typeof loader>()} />;
}
