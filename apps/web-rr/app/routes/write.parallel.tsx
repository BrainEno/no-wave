import {
  redirect,
  type HeadersFunction,
  type LoaderFunctionArgs,
  type MetaFunction,
} from "react-router";
import { LocalWritingParallel } from "@/components/authoring/writing-parallel-workbench.tsx";
import { PRIVATE_PAGE_HEADERS } from "../lib/http-policy.ts";

/** Empty local shell: no URL selects a source or changes analysis policy. */
export function loader({ request }: LoaderFunctionArgs) {
  const url = new URL(request.url);
  if (url.pathname !== "/write/parallel" || url.search)
    throw redirect("/write/parallel", { headers: PRIVATE_PAGE_HEADERS });
  return null;
}

export const headers: HeadersFunction = () => PRIVATE_PAGE_HEADERS;

export const meta: MetaFunction = () => [
  { title: "本机双语与平行文稿对照审阅 | 无浪潮" },
  { name: "robots", content: "noindex, nofollow" },
];

export default function WriteParallelRoute() {
  return (
    <main
      id="top"
      tabIndex={-1}
      className="nw-w nw-head nw-private-page"
      data-route="write-parallel"
    >
      <LocalWritingParallel />
    </main>
  );
}
