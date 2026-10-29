import type { Metadata } from "next";
import { SignInForm } from "@/components/auth/sign-in-form.tsx";
import { safeRedirectPath } from "@/lib/authoring-proxy-policy.ts";

export const metadata: Metadata = { title: "登录", robots: { index: false, follow: false } };

export default async function SignInPage({ searchParams }: { searchParams: Promise<{ next?: string | string[] }> }) {
  const params = await searchParams;
  const raw = Array.isArray(params.next) ? params.next[0] : params.next;
  const nextPath = safeRedirectPath(raw);
  return <main className="nw-w nw-head"><SignInForm nextPath={nextPath} /></main>;
}
