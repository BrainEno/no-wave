import { useLoaderData } from "react-router";
import type { HeadersFunction, LoaderFunctionArgs, MetaFunction } from "react-router";
// Unmodified shared component: its `useRouter` comes from the navigation seam,
// which this app answers from `app/framework/navigation.ts`.
import { SignInForm } from "@/components/auth/sign-in-form.tsx";
import { safeRedirectPath } from "@/lib/authoring-proxy-policy.ts";
import { isMailEnabled } from "@/lib/mail-feature.ts";
import { PRIVATE_PAGE_HEADERS } from "../lib/http-policy.ts";

/**
 * Sign-in route.
 *
 * The form keeps its client-side behavior (pending state, validation errors, API
 * failures) and posts to `/api/auth/:action`, which this app implements as a
 * resource route over the framework-neutral handler in `app/lib/auth-proxy.ts`.
 */
export async function loader({ url }: LoaderFunctionArgs) {
  // Read at request time, not build time: switching mail on must not require a
  // rebuild.
  return { nextPath: safeRedirectPath(url.searchParams.get("next") ?? "/account"), mailEnabled: isMailEnabled() };
}

/**
 * Private, for two reasons that are both per-visitor.
 *
 * The URL carries `?next=<path>`, so the HTML differs by request; and the
 * loader's `mailEnabled` answer is read per request, so a shared cache holding
 * this page would keep serving the wrong recovery policy after the switch is
 * flipped. It is also the page every other private route redirects *to*, which
 * makes a cacheable sign-in screen the beginning of a signed-in reader being
 * handed somebody else's copy of it.
 */
export const headers: HeadersFunction = () => PRIVATE_PAGE_HEADERS;

export const meta: MetaFunction = () => [
  { title: "进入写作 | 无浪潮" },
  { name: "robots", content: "noindex" },
];

export default function SignInRoute() {
  const { nextPath, mailEnabled } = useLoaderData<typeof loader>();
  return (
    <main id="top" tabIndex={-1} className="nw-w" data-route="sign-in">
      <SignInForm nextPath={nextPath} mailEnabled={mailEnabled} />
    </main>
  );
}
