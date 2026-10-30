import type { Metadata } from "next";
import { VerifyEmailPanel } from "@/components/auth/verify-email-panel.tsx";

export const metadata: Metadata = { title: "验证邮箱", robots: { index: false, follow: false } };

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
  return <main className="nw-w nw-head"><VerifyEmailPanel token={token} /></main>;
}
