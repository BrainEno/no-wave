import type { HeadersFunction, MetaFunction } from "react-router";
// Unmodified shared client component: it fetches /api/authoring/session and
// /api/authoring/articles after it hydrates, both served by this app now.
import { AuthoringWorkspace } from "@/components/authoring/authoring-workspace.tsx";

/**
 * The writing desk (Phase 4b).
 *
 * Private and unindexed. There is no loader: the desk
 * is a client component that brings its own data, so the server render is the
 * shell and everything else happens in the browser — which is exactly why the
 * endpoints above had to be ported with it.
 */
export const meta: MetaFunction = () => [
  { title: "写作台 | 无浪潮" },
  { name: "robots", content: "noindex, nofollow" },
];

/**
 * The desk is private: a shared cache must not be able to keep it, exactly like
 * `/account`.
 */
export const headers: HeadersFunction = () => ({ "Cache-Control": "no-store, max-age=0" });

export default function WriteRoute() {
  return (
    <main className="nw-w nw-head" data-route="write">
      <AuthoringWorkspace />
    </main>
  );
}
