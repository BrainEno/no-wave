import type { HeadersFunction, MetaFunction } from "react-router";
import { NotionOAuthCallback } from "@/components/authoring/notion-oauth-callback.tsx";
import { PRIVATE_PAGE_HEADERS } from "../lib/http-policy.ts";

/**
 * Where Notion returns the authorization popup (ADR 0053).
 *
 * No loader and no sign-in redirect: the URL carries a one-time code, and a
 * redirect would either drop it or carry it further. The page clears it from the
 * address bar first thing; the exchange it then makes is a request the API checks
 * against the session, so a signed-out visitor only gets a sentence. The answer is
 * `no-store`, and `no-referrer` keeps the code out of any request the page makes
 * before it is cleared.
 */
export const headers: HeadersFunction = () => ({ ...PRIVATE_PAGE_HEADERS, "Referrer-Policy": "no-referrer" });

export const meta: MetaFunction = () => [
  { title: "Notion 授权 | 无浪潮" },
  { name: "robots", content: "noindex, nofollow" },
  { name: "referrer", content: "no-referrer" },
];

export default function WriteNotionOAuthCallbackRoute() {
  return (
    <main id="top" tabIndex={-1} className="nw-w nw-head" data-route="write-notion-oauth-callback">
      <NotionOAuthCallback />
    </main>
  );
}
