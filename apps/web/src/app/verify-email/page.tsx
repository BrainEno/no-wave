import type { Metadata } from "next";
import { VerifyEmailPanel } from "@/components/auth/verify-email-panel.tsx";
import { MailDisabledNotice } from "@/components/auth/mail-disabled-notice.tsx";
import { isMailEnabled } from "@/lib/mail-feature.ts";

export const metadata: Metadata = { title: "验证邮箱", robots: { index: false, follow: false } };
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
 * Where a verification link lands.
 *
 * Same shape as the reset page, for the same reason: the token comes out of the
 * query string and goes back in a request body. Verification is a stamp, not a
 * gate — see ADR 0014 — so nothing on this page promises the visitor anything
 * their account could not already do.
 */
export default async function VerifyEmailPage({ searchParams }: { searchParams: Promise<{ token?: string | string[] }> }) {
  const params = await searchParams;
  const raw = Array.isArray(params.token) ? params.token[0] : params.token;
  const token = typeof raw === "string" ? raw.trim() : "";
  if (!isMailEnabled()) return <main className="nw-w nw-head"><MailDisabledNotice /></main>;
  return <main className="nw-w nw-head"><VerifyEmailPanel token={token} /></main>;
}
