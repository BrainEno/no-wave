import {
  redirect,
  type HeadersFunction,
  type LoaderFunctionArgs,
  type MetaFunction,
} from "react-router";
import { LocalWritingTerms } from "@/components/authoring/writing-terms-workbench.tsx";
import { PRIVATE_PAGE_HEADERS } from "../lib/http-policy.ts";

/** Empty anonymous local shell: URL parameters never select inputs or establish identity. */
export function loader({ request }: LoaderFunctionArgs) {
  const url = new URL(request.url);
  if (url.pathname !== "/write/terms" || url.search)
    throw redirect("/write/terms", { headers: PRIVATE_PAGE_HEADERS });
  return null;
}
export const headers: HeadersFunction = () => PRIVATE_PAGE_HEADERS;
export const meta: MetaFunction = () => [
  { title: "本机术语一致性审阅 | 无浪潮" },
  { name: "robots", content: "noindex, nofollow" },
];
export default function WriteTermsRoute() {
  return (
    <main
      id="top"
      tabIndex={-1}
      className="nw-w nw-head nw-private-page"
      data-route="write-terms"
    >
      <LocalWritingTerms />
    </main>
  );
}
