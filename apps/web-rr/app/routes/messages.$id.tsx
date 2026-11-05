import { redirect, useLoaderData, type LoaderFunctionArgs } from "react-router";
import type { HeadersFunction, MetaFunction } from "react-router";
import { hasUsableSession, sessionMarkerFrom } from "@bot-thk/web-http";
import { ThreadView } from "@/components/public/thread-view.tsx";
import { localeFor } from "../lib/locale.ts";
import { PRIVATE_PAGE_HEADERS } from "../lib/http-policy.ts";

/**
 * One conversation — `/messages/:id` and `/en/messages/:id`.
 *
 * The loader decides only that there is a session and hands the id through; it
 * does not check membership, because it cannot: that answer needs the access
 * token, which lives in an `HttpOnly` cookie scoped below `/`. The thread asks
 * `/api/inbox/:id/messages` and renders the answer — including the `404`/`403`
 * that means "not yours to read", which is a real answer and not a failure.
 */
export async function loader({ request, params }: LoaderFunctionArgs) {
  const locale = localeFor(request);
  const base = locale === "zh-CN" ? "/messages" : `/${locale}/messages`;
  const target = `${base}/${params.id ?? ""}`;
  if (!hasUsableSession(sessionMarkerFrom(request))) {
    throw redirect(`/sign-in?next=${encodeURIComponent(target)}`, { headers: PRIVATE_PAGE_HEADERS });
  }
  return { locale, conversationId: params.id ?? "" };
}

export const headers: HeadersFunction = () => PRIVATE_PAGE_HEADERS;

export const meta: MetaFunction = () => [
  { title: "私信 | 无浪潮" },
  { name: "robots", content: "noindex, nofollow" },
];

export default function ThreadRoute() {
  const { locale, conversationId } = useLoaderData<typeof loader>();
  return <ThreadView key={conversationId} locale={locale} conversationId={conversationId} />;
}
