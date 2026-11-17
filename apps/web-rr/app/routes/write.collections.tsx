import { redirect, type HeadersFunction, type LoaderFunctionArgs, type MetaFunction } from "react-router";
import { WritingCollections } from "@/components/authoring/writing-collections.tsx";
import { PRIVATE_PAGE_HEADERS } from "../lib/http-policy.ts";

/** Empty local-file tool only: a chosen backup never grants server account/work access. */
export function loader({ request }: LoaderFunctionArgs) {
  if (new URL(request.url).search) throw redirect("/write/collections", { headers: PRIVATE_PAGE_HEADERS });
  return null;
}
export const headers: HeadersFunction = () => PRIVATE_PAGE_HEADERS;
export const meta: MetaFunction = () => [{ title: "本机文稿集合 | 无浪潮" }, { name: "robots", content: "noindex, nofollow" }];
export default function WriteCollectionsRoute() {
  return <main id="top" tabIndex={-1} className="nw-w nw-head nw-private-page" data-route="write-collections"><WritingCollections /></main>;
}
