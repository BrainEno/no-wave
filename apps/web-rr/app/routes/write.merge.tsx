import {
  redirect,
  type HeadersFunction,
  type LoaderFunctionArgs,
  type MetaFunction,
} from "react-router";
import { LocalWritingMerge } from "@/components/authoring/writing-merge-workbench.tsx";
import { PRIVATE_PAGE_HEADERS } from "../lib/http-policy.ts";

/** An empty anonymous local tool; no file, account or work is selected by the server. */
export function loader({ request }: LoaderFunctionArgs) {
  if (new URL(request.url).search)
    throw redirect("/write/merge", { headers: PRIVATE_PAGE_HEADERS });
  return null;
}
export const headers: HeadersFunction = () => PRIVATE_PAGE_HEADERS;
export const meta: MetaFunction = () => [
  { title: "本机三方文稿合并 | 无浪潮" },
  { name: "robots", content: "noindex, nofollow" },
];
export default function WriteMergeRoute() {
  return (
    <main
      id="top"
      tabIndex={-1}
      className="nw-w nw-head nw-private-page"
      data-route="write-merge"
    >
      <LocalWritingMerge />
    </main>
  );
}
