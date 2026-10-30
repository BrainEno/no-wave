import { redirect, useLoaderData, type LoaderFunctionArgs } from "react-router";
import type { HeadersFunction, MetaFunction } from "react-router";
import { AccountPanel } from "@/components/auth/account-panel.tsx";
import { SESSION_MARKER_COOKIE, hasUsableSession, sessionMarkerFrom } from "@bot-thk/web-http";
import { isMailEnabled } from "@/lib/mail-feature.ts";

/**
 * Private route.
 *
 * The token cookies are scoped below `/`, so this loader cannot read them and
 * must not try. What it *can* read is the session marker: an `HttpOnly` cookie
 * scoped to `/` whose value is the moment the session can no longer be renewed.
 * It carries no credential and grants nothing — it decides only between
 * "redirect to sign-in" and "render the shell".
 *
 * The account itself is resolved by `AccountPanel` from
 * `/api/authoring/session`, which is the request that can present the access
 * token to the API. Everything the visitor sees therefore comes from a response
 * the API verified, and nothing here has to trust the browser.
 */
export async function loader({ request }: LoaderFunctionArgs) {
  if (!hasUsableSession(sessionMarkerFrom(request))) throw redirect("/sign-in?next=%2Faccount");
  return { mailEnabled: isMailEnabled() };
}

/** Private: no shared cache may keep a copy, and the page is never indexed. */
export const headers: HeadersFunction = () => ({ "Cache-Control": "no-store, max-age=0" });

export const meta: MetaFunction = () => [
  { title: "我的账户 | 无浪潮" },
  { name: "robots", content: "noindex, nofollow" },
];

export default function AccountRoute() {
  const { mailEnabled } = useLoaderData<typeof loader>();
  return (
    <main className="nw-w nw-head" data-route="account">
      <AccountPanel mailEnabled={mailEnabled} />
    </main>
  );
}

/** Re-exported so tests can name the marker without importing the package. */
export { SESSION_MARKER_COOKIE };
