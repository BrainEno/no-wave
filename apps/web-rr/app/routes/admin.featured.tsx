import { redirect, type LoaderFunctionArgs } from "react-router";
import type { HeadersFunction, MetaFunction } from "react-router";
import { FeaturedShelfPanel } from "@/components/admin/featured-shelf-panel.tsx";
import { SESSION_MARKER_COOKIE, hasUsableSession, sessionMarkerFrom } from "@bot-thk/web-http";
import { PRIVATE_PAGE_HEADERS } from "../lib/http-policy.ts";

/**
 * Private route: the featured shelf's editorial screen (ADR 0016).
 *
 * The token cookies are scoped below `/`, so this loader cannot read them and
 * must not try. The session marker decides only between "redirect to sign-in"
 * and "render the shell"; whether the visitor may curate is resolved inside the
 * panel from `/api/authoring/session`, the request that can present the access
 * token to the API.
 */
/** Private: no shared cache may keep a copy, and the page is never indexed. */
const PRIVATE_HEADERS = PRIVATE_PAGE_HEADERS;

export async function loader({ request }: LoaderFunctionArgs) {
  // Per-visitor for the same reason as `/account`: the answer depends on a
  // cookie, so a shared cache must not keep it.
  if (!hasUsableSession(sessionMarkerFrom(request))) {
    throw redirect("/sign-in?next=%2Fadmin%2Ffeatured", { headers: PRIVATE_HEADERS });
  }
  return {};
}

export const headers: HeadersFunction = () => PRIVATE_HEADERS;

export const meta: MetaFunction = () => [
  { title: "编辑精选 | 无浪潮" },
  { name: "robots", content: "noindex, nofollow" },
];

export default function AdminFeaturedRoute() {
  return (
    <main id="top" tabIndex={-1} className="nw-w nw-head" data-route="admin-featured">
      <FeaturedShelfPanel />
    </main>
  );
}

/** Re-exported so tests can name the marker without importing the package. */
export { SESSION_MARKER_COOKIE };
