import type { Metadata } from "next";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { FeaturedShelfPanel } from "@/components/admin/featured-shelf-panel.tsx";
import { SESSION_MARKER_COOKIE, hasUsableSession } from "@bot-thk/web-http";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";

export const metadata: Metadata = { title: "编辑精选", robots: { index: false, follow: false } };

/**
 * The featured shelf's editorial screen (ADR 0016).
 *
 * Like every private page here, it decides only between "redirect" and "render
 * the shell": the token cookies are scoped below `/`, so a page render cannot
 * read them. Whether the visitor may curate at all is answered inside the shell
 * from `GET /api/authoring/session`, which is the request that can present the
 * token to the API — so an account without the role gets an explanation, never
 * a screen full of controls that would only answer 403.
 */
export default async function AdminFeaturedPage() {
  const jar = await cookies();
  if (!hasUsableSession(jar.get(SESSION_MARKER_COOKIE)?.value)) {
    redirect("/sign-in?next=%2Fadmin%2Ffeatured");
  }
  return (
    <main className="nw-w nw-head">
      <FeaturedShelfPanel />
    </main>
  );
}
