import { useLoaderData } from "react-router";
import type { HeadersFunction, MetaFunction } from "react-router";
// Unmodified shared components: they import the navigation seam, which this
// app answers from `app/framework/link.tsx`.
import { ForgotPasswordForm } from "@/components/auth/forgot-password-form.tsx";
import { MailDisabledNotice } from "@/components/auth/mail-disabled-notice.tsx";
import { isMailEnabled } from "@/lib/mail-feature.ts";
import { titleWithSite } from "../lib/meta.ts";

/**
 * Ask for a recovery link.
 *
 * The switch is read in the loader, per request, for two reasons: it is an
 * operator's decision and must be changeable without a rebuild, and a form that
 * collects an address in order to send nothing is worse than a page that says
 * so. Mail is read per request (`isMailEnabled`), and every render here is per
 * request by default, which is why
 * that trap has no framework-shaped fix to copy.
 */
export async function loader() {
  return { mailEnabled: isMailEnabled() };
}

/**
 * Private: a page reached while trying to prove ownership of an account must
 * never be held by a shared cache, and it must never be indexed.
 */
export const headers: HeadersFunction = () => ({ "Cache-Control": "no-store, max-age=0" });

export const meta: MetaFunction = () => [
  { title: titleWithSite("找回密码") },
  { name: "robots", content: "noindex, nofollow" },
];

export default function ForgotPasswordRoute() {
  const { mailEnabled } = useLoaderData<typeof loader>();
  return (
    <main className="nw-w nw-head" data-route="forgot-password">
      {mailEnabled ? <ForgotPasswordForm /> : <MailDisabledNotice />}
    </main>
  );
}
