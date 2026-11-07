import { useLoaderData } from "react-router";
import type { HeadersFunction, LoaderFunctionArgs, MetaFunction } from "react-router";
import { VerifyEmailPanel } from "@/components/auth/verify-email-panel.tsx";
import { MailDisabledNotice } from "@/components/auth/mail-disabled-notice.tsx";
import { isMailEnabled } from "@/lib/mail-feature.ts";
import { titleWithSite } from "../lib/meta.ts";
import { PRIVATE_PAGE_HEADERS } from "../lib/http-policy.ts";

/**
 * Where a verification link lands.
 *
 * Same shape as the reset page, for the same reason: the token comes out of the
 * query string and goes back in a request body. Verification is a stamp, not a
 * gate (ADR 0014), so nothing on this page promises the visitor anything their
 * account could not already do.
 *
 * The panel spends the token on arrival rather than on a button press; that is
 * the shared component's behaviour and it is unchanged here.
 */
export async function loader({ url }: LoaderFunctionArgs) {
  const token = url.searchParams.get("token")?.trim() ?? "";
  return { token, mailEnabled: isMailEnabled() };
}

/** Private: the URL carries a single-use token until it is spent. */
export const headers: HeadersFunction = () => PRIVATE_PAGE_HEADERS;

export const meta: MetaFunction = () => [
  { title: titleWithSite("验证邮箱") },
  { name: "robots", content: "noindex, nofollow" },
];

export default function VerifyEmailRoute() {
  const { token, mailEnabled } = useLoaderData<typeof loader>();
  return (
    <main className="nw-w nw-head" data-route="verify-email">
      {mailEnabled ? <VerifyEmailPanel token={token} /> : <MailDisabledNotice />}
    </main>
  );
}
