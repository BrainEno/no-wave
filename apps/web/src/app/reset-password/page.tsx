import type { Metadata } from "next";
import { ResetPasswordForm } from "@/components/auth/reset-password-form.tsx";

export const metadata: Metadata = { title: "设置新密码", robots: { index: false, follow: false } };

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
  return <main className="nw-w nw-head"><ResetPasswordForm token={token} /></main>;
}
