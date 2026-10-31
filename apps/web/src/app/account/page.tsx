import type { Metadata } from "next";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { AccountPanel } from "@/components/auth/account-panel.tsx";
import { SESSION_MARKER_COOKIE, hasUsableSession } from "@bot-thk/web-http";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";

export const metadata: Metadata = { title: "我的账户", robots: { index: false, follow: false } };

/**
 * The account page.
 *
 * It used to deny every request, on the correct grounds that a client-supplied
 * header is not proof of identity. What was missing was anything that *is*:
 * the token cookies are scoped below `/`, so a page render cannot read them,
 * and without them the only safe answer was "nobody is signed in".
 *
 * The session marker resolves that without weakening the cookie contract. It is
 * the one cookie scoped to `/`, it carries an expiry and no credential, and it
 * decides only between "redirect" and "render the shell". The shell itself is
 * empty: who the visitor is comes from `/api/authoring/session`, which is the
 * request that can actually present the token to the API.
 */
export default async function AccountPage() {
  const jar = await cookies();
  if (!hasUsableSession(jar.get(SESSION_MARKER_COOKIE)?.value)) {
    redirect("/sign-in?next=%2Faccount");
  }
  return (
    <main className="nw-w nw-head">
      <AccountPanel />
    </main>
  );
}
