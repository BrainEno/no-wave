import { useLoaderData } from "react-router";
import type { HeadersFunction, LoaderFunctionArgs, MetaFunction } from "react-router";
import { ResetPasswordForm } from "@/components/auth/reset-password-form.tsx";
import { MailDisabledNotice } from "@/components/auth/mail-disabled-notice.tsx";
import { isMailEnabled } from "@/lib/mail-feature.ts";
import { titleWithSite } from "../lib/meta.ts";

/**
 * Where a recovery link lands.
 *
 * The token arrives in the query string because that is what a mail can carry,
 * and it leaves in a **request body**: paths are logged by proxies, CDNs and
 * browsers, and a reset link in an access log is a reset link anyone can use.
 * Reading it server-side also means the client component never has to subscribe
 * to the URL itself.
 *
 * An absent token is *not* an error the loader throws: the shared component
 * already renders "链接不完整" for it, and that wording is the same in both
 * applications.
 */
export async function loader({ request }: LoaderFunctionArgs) {
  const url = new URL(request.url);
  const token = url.searchParams.get("token")?.trim() ?? "";
  // A reset link can only have arrived by mail, so with mail off there is no
  // token to redeem and the form would only ever answer "invalid link".
  return { token, mailEnabled: isMailEnabled() };
}

/**
 * Private, and for a stronger reason than the other two: the URL *is* the
 * credential until the token is spent. A shared cache that stored this page
 * would store a working password reset.
 */
export const headers: HeadersFunction = () => ({ "Cache-Control": "no-store, max-age=0" });

export const meta: MetaFunction = () => [
  { title: titleWithSite("设置新密码") },
  { name: "robots", content: "noindex, nofollow" },
];

export default function ResetPasswordRoute() {
  const { token, mailEnabled } = useLoaderData<typeof loader>();
  return (
    <main className="nw-w nw-head" data-route="reset-password">
      {mailEnabled ? <ResetPasswordForm token={token} /> : <MailDisabledNotice />}
    </main>
  );
}
