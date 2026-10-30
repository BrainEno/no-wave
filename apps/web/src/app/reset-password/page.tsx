import type { Metadata } from "next";
import { ResetPasswordForm } from "@/components/auth/reset-password-form.tsx";
import { MailDisabledNotice } from "@/components/auth/mail-disabled-notice.tsx";
import { isMailEnabled } from "@/lib/mail-feature.ts";

export const metadata: Metadata = { title: "设置新密码", robots: { index: false, follow: false } };
/**
 * Rendered per request, because the page decides from `MAIL_ENABLED` and that is
 * an operator's switch, not a build input.
 *
 * Without this the page was prerendered at build time (`○` in the build output)
 * and served as frozen HTML: flipping the switch in the environment changed
 * nothing until the site was rebuilt, which is the same trap F4 caught for
 * `NEXT_PUBLIC_SITE_URL`. These pages are noindex and cost nothing to render.
 */
export const dynamic = "force-dynamic";
export const revalidate = 0;


/**
 * Where a recovery link lands.
 *
 * The token arrives in the query string because that is what a mail can carry,
 * and it leaves in a **request body**: paths are logged by proxies, CDNs and
 * browsers, and a reset link in an access log is a reset link anyone can use.
 * The token is read here, on the server, so the client component never has to
 * subscribe to the URL itself.
 */
export default async function ResetPasswordPage({ searchParams }: { searchParams: Promise<{ token?: string | string[] }> }) {
  const params = await searchParams;
  const raw = Array.isArray(params.token) ? params.token[0] : params.token;
  const token = typeof raw === "string" ? raw.trim() : "";
  // A reset link can only have arrived by mail, so with mail off there is no
  // token to redeem and the form would only ever answer "invalid link".
  if (!isMailEnabled()) return <main className="nw-w nw-head"><MailDisabledNotice /></main>;
  return <main className="nw-w nw-head"><ResetPasswordForm token={token} /></main>;
}
