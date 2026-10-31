import type { Metadata } from "next";
import { ForgotPasswordForm } from "@/components/auth/forgot-password-form.tsx";
import { MailDisabledNotice } from "@/components/auth/mail-disabled-notice.tsx";
import { isMailEnabled } from "@/lib/mail-feature.ts";

export const metadata: Metadata = { title: "找回密码", robots: { index: false, follow: false } };
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
 * Ask for a recovery link.
 *
 * The page says the same thing whether or not the address has an account, and
 * so does the API. A form that could tell the two apart would hand an attacker
 * a cheaper enumeration oracle than registration's `409` — and this is the one
 * endpoint anyone would automate.
 */
export default function ForgotPasswordPage() {
  // Mail is off unless an operator switches it on, and a form that collects an
  // address in order to send nothing is worse than a page that says so: the API
  // would answer 503 `MAIL_DISABLED`, and this is the same answer in words.
  if (!isMailEnabled()) return <main className="nw-w nw-head"><MailDisabledNotice /></main>;
  return <main className="nw-w nw-head"><ForgotPasswordForm /></main>;
}
