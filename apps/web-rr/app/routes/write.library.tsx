import { redirect, type HeadersFunction, type LoaderFunctionArgs, type MetaFunction } from "react-router";
import { hasUsableSession, sessionMarkerFrom } from "@bot-thk/web-http";
import { AuthoringCatalogue } from "@/components/authoring/authoring-catalogue.tsx";
import { PRIVATE_PAGE_HEADERS } from "../lib/http-policy.ts";

/** The marker only chooses a shell; all catalogue data is independently owner-checked by the API. */
export function loader({ request }: LoaderFunctionArgs) {
  if (!hasUsableSession(sessionMarkerFrom(request))) throw redirect("/sign-in?next=%2Fwrite%2Flibrary", { headers: PRIVATE_PAGE_HEADERS });
  return null;
}
export const headers: HeadersFunction = () => PRIVATE_PAGE_HEADERS;
export const meta: MetaFunction = () => [{ title: "作品管理 | 无浪潮" }, { name: "robots", content: "noindex, nofollow" }];

export default function WriteLibraryRoute() {
  return <main id="top" tabIndex={-1} className="nw-w nw-head nw-private-page" data-route="write-library"><AuthoringCatalogue /></main>;
}
