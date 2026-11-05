import { redirect, useLoaderData, type LoaderFunctionArgs } from "react-router";
import type { HeadersFunction, MetaFunction } from "react-router";
import { hasUsableSession, sessionMarkerFrom } from "@bot-thk/web-http";
import { FeedView } from "@/components/public/feed-view.tsx";
import { localeFor } from "../lib/locale.ts";
import { PRIVATE_PAGE_HEADERS } from "../lib/http-policy.ts";

/**
 * 关注流 — `/feed` and `/en/feed`.
 *
 * A private page, so it follows `/account` exactly: the loader decides between
 * "redirect to sign-in" and "render the shell" using the session **marker**, not
 * the token. The access token is `HttpOnly` and scoped below `/`, so this loader
 * cannot read it and must not try; the marker carries no credential and grants
 * nothing, it only says whether a session is still renewable (ADR 0025).
 *
 * The list itself is fetched by `FeedView` from `/api/authoring/feed`, within
 * the access-cookie path. That split matters beyond
 * taste: it means nothing rendered here has to be trusted, and it keeps the feed
 * out of any shared cache — the loader returns the same body to every signed-in
 * reader, and `no-store` is what stops a shared cache from handing a reader
 * somebody else's list.
 */
export async function loader({ request }: LoaderFunctionArgs) {
  const locale = localeFor(request);
  const target = locale === "zh-CN" ? "/feed" : `/${locale}/feed`;
  if (!hasUsableSession(sessionMarkerFrom(request))) {
    // The redirect is per-visitor too, so the headers travel with it and not
    // only with the rendered page.
    throw redirect(`/sign-in?next=${encodeURIComponent(target)}`, { headers: PRIVATE_PAGE_HEADERS });
  }
  return { locale };
}

export const headers: HeadersFunction = () => PRIVATE_PAGE_HEADERS;

export const meta: MetaFunction = () => [
  { title: "关注流 | 无浪潮" },
  // A private page: never indexed, and never shared.
  { name: "robots", content: "noindex, nofollow" },
];

export default function FeedRoute() {
  const { locale } = useLoaderData<typeof loader>();
  return <FeedView locale={locale} />;
}
