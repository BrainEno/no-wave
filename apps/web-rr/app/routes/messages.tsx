import { redirect, useLoaderData, type LoaderFunctionArgs } from "react-router";
import type { HeadersFunction, MetaFunction } from "react-router";
import { hasUsableSession, sessionMarkerFrom } from "@bot-thk/web-http";
import { MessagesView } from "@/components/public/messages-view.tsx";
import { localeFor } from "../lib/locale.ts";
import { PRIVATE_PAGE_HEADERS } from "../lib/http-policy.ts";

/**
 * 私信收件箱 — `/messages` and `/en/messages`.
 *
 * Private, and built the same way as `/feed` and `/account`: the loader reads the
 * session **marker** (no credential, only "is this still renewable") and chooses
 * between a redirect and the shell. The conversation list comes from `/api/inbox`
 * with the browser's own cookie, which is the only request that can present the
 * access token.
 *
 * `no-store` on the shell matters here more than anywhere else on the site: every
 * signed-in reader gets byte-identical HTML, and a shared cache that kept it
 * would show one reader another reader's page.
 */
export async function loader({ request }: LoaderFunctionArgs) {
  const locale = localeFor(request);
  const target = locale === "zh-CN" ? "/messages" : `/${locale}/messages`;
  if (!hasUsableSession(sessionMarkerFrom(request))) {
    throw redirect(`/sign-in?next=${encodeURIComponent(target)}`, { headers: PRIVATE_PAGE_HEADERS });
  }
  return { locale };
}

export const headers: HeadersFunction = () => PRIVATE_PAGE_HEADERS;

export const meta: MetaFunction = () => [
  { title: "私信 | 无浪潮" },
  { name: "robots", content: "noindex, nofollow" },
];

export default function MessagesRoute() {
  const { locale } = useLoaderData<typeof loader>();
  return <MessagesView locale={locale} />;
}
