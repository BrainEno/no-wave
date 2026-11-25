import { redirect, useLoaderData, type HeadersFunction, type LoaderFunctionArgs, type MetaFunction } from "react-router";
import { hasUsableSession, sessionMarkerFrom } from "@no-wave/web-http";
import { NotificationInbox } from "@/components/authoring/notification-inbox.tsx";
import { inboxFilterHref, parseInboxFilters } from "@/lib/notification-inbox-model.ts";
import { readNotificationSelection } from "@/lib/notification-selection.ts";
import { notificationInboxCopy } from "@/lib/notification-inbox-copy.ts";
import { localeFor } from "../lib/locale.ts";
import { PRIVATE_PAGE_HEADERS } from "../lib/http-policy.ts";

/** Only the browser's existing actor-fenced transport can read private rows. */
export function loader({ request, url }: LoaderFunctionArgs) {
  const locale = localeFor(url);
  const target = inboxFilterHref(locale, parseInboxFilters(url.searchParams), readNotificationSelection(url.searchParams));
  if (!hasUsableSession(sessionMarkerFrom(request))) {
    throw redirect(`/sign-in?next=${encodeURIComponent(target)}`, { headers: PRIVATE_PAGE_HEADERS });
  }
  return { locale };
}

export const headers: HeadersFunction = () => PRIVATE_PAGE_HEADERS;
export const meta: MetaFunction<typeof loader> = ({ loaderData }) => [
  { title: loaderData?.locale === "en" ? "Notifications | No Wave" : "通知 | 无浪潮" },
  { name: "robots", content: "noindex, nofollow" },
];

export default function NotificationsRoute() {
  const { locale } = useLoaderData<typeof loader>();
  const copy = notificationInboxCopy(locale);
  return (
    <main id="top" tabIndex={-1} className="nw-w nw-head nw-private-page" data-route="notifications">
      <header><h1>{copy.title}</h1><p>{copy.introduction}</p></header>
      <NotificationInbox locale={locale} fullPage />
    </main>
  );
}
