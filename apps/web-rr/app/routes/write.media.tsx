import { redirect, type HeadersFunction, type LoaderFunctionArgs, type MetaFunction } from "react-router";
import { hasUsableSession, sessionMarkerFrom } from "@bot-thk/web-http";
import { MediaLibrary } from "@/components/authoring/media-library.tsx";
import { PRIVATE_PAGE_HEADERS } from "../lib/http-policy.ts";

/**
 * The media library (ADR 0022).
 *
 * Private and unindexed, like every screen under `/write`. The loader decides
 * only between "render the shell" and "go and sign in", from the session marker
 * — a cookie that carries no credential — so the page never has to trust the
 * browser about who is signed in. What it shows comes from
 * `GET /api/authoring/media`, a request the API verifies.
 */
export async function loader({ request }: LoaderFunctionArgs) {
  if (!hasUsableSession(sessionMarkerFrom(request))) {
    throw redirect("/sign-in?next=%2Fwrite%2Fmedia", { headers: PRIVATE_PAGE_HEADERS });
  }
  return null;
}

export const headers: HeadersFunction = () => PRIVATE_PAGE_HEADERS;

export const meta: MetaFunction = () => [
  { title: "媒体库 | 无浪潮" },
  { name: "robots", content: "noindex, nofollow" },
];

export default function WriteMediaRoute() {
  return (
    <main id="top" tabIndex={-1} className="nw-w nw-head" data-route="write-media">
      <MediaLibrary />
    </main>
  );
}
