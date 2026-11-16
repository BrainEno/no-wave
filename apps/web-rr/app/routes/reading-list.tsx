import type { HeadersFunction, LoaderFunctionArgs, MetaFunction } from "react-router";
import { useLoaderData } from "react-router";
import { ReadingListPage } from "@/components/reader/reading-list.tsx";
import { readingShelfCopy } from "@/lib/reading-shelf-copy.ts";
import { localeFor } from "../lib/locale.ts";
import { PRIVATE_PAGE_HEADERS } from "../lib/http-policy.ts";
import { titleWithSite } from "../lib/meta.ts";

/** Anonymous and signed-in readers get the same empty shell; no cookie or API read. */
export function loader({ url }: LoaderFunctionArgs) {
  return { locale: localeFor(url) };
}
export const headers: HeadersFunction = () => PRIVATE_PAGE_HEADERS;
export const meta: MetaFunction<typeof loader> = ({ loaderData }) => [
  { title: titleWithSite(readingShelfCopy(loaderData?.locale ?? "zh-CN").title) },
  { name: "robots", content: "noindex, nofollow" },
];
export default function ReadingListRoute() {
  return <ReadingListPage {...useLoaderData<typeof loader>()} />;
}
