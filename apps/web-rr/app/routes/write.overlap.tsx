import {
  redirect,
  type HeadersFunction,
  type LoaderFunctionArgs,
  type MetaFunction,
} from "react-router";
import { LocalWritingOverlap } from "@/components/authoring/writing-overlap-workbench.tsx";
import { PRIVATE_PAGE_HEADERS } from "../lib/http-policy.ts";

/** Anonymous empty shell; URL input never selects a local file or grants server identity. */
export function loader({ request }: LoaderFunctionArgs) {
  const url = new URL(request.url);
  if (url.pathname !== "/write/overlap" || url.search)
    throw redirect("/write/overlap", { headers: PRIVATE_PAGE_HEADERS });
  return null;
}
export const headers: HeadersFunction = () => PRIVATE_PAGE_HEADERS;
export const meta: MetaFunction = () => [
  { title: "本机文稿重复段落审阅 | 无浪潮" },
  { name: "robots", content: "noindex, nofollow" },
];
export default function WriteOverlapRoute() {
  return (
    <main
      id="top"
      tabIndex={-1}
      className="nw-w nw-head nw-private-page"
      data-route="write-overlap"
    >
      <LocalWritingOverlap />
    </main>
  );
}
