import { redirect, type HeadersFunction, type LoaderFunctionArgs, type MetaFunction } from "react-router";
import { hasUsableSession, sessionMarkerFrom } from "@bot-thk/web-http";
import { NotionImport } from "@/components/authoring/notion-import.tsx";
import { PRIVATE_PAGE_HEADERS } from "../lib/http-policy.ts";

/**
 * The Notion import (ADR 0036, phase 4).
 *
 * Private and unindexed, like every screen under `/write`, and gated the same way
 * the media library is: the loader decides only between "render the shell" and
 * "go and sign in", from the session marker — a cookie that carries no credential
 * — so the page never has to trust the browser about who is signed in. The import
 * itself is a request the API verifies, and it writes only what the session owns.
 */
export async function loader({ request }: LoaderFunctionArgs) {
  if (!hasUsableSession(sessionMarkerFrom(request))) {
    throw redirect("/sign-in?next=%2Fwrite%2Fnotion", { headers: PRIVATE_PAGE_HEADERS });
  }
  return null;
}

export const headers: HeadersFunction = () => PRIVATE_PAGE_HEADERS;

export const meta: MetaFunction = () => [
  { title: "从 Notion 导入 | 无浪潮" },
  { name: "robots", content: "noindex, nofollow" },
];

export default function WriteNotionRoute() {
  return (
    <main id="top" tabIndex={-1} className="nw-w nw-head" data-route="write-notion">
      <NotionImport />
    </main>
  );
}
