import type { Metadata } from "next";
import { ForgotPasswordForm } from "@/components/auth/forgot-password-form.tsx";

export const metadata: Metadata = { title: "找回密码", robots: { index: false, follow: false } };

/**
 * Ask for a recovery link.
 *
 * The page says the same thing whether or not the address has an account, and
 * so does the API. A form that could tell the two apart would hand an attacker
 * a cheaper enumeration oracle than registration's `409` — and this is the one
 * endpoint anyone would automate.
 */
export default function ForgotPasswordPage() {
  return <main className="nw-w nw-head"><ForgotPasswordForm /></main>;
}
