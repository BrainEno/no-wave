import { useLoaderData } from "react-router";
import type { LoaderFunctionArgs, MetaFunction } from "react-router";
// Unmodified shared component: its `useRouter` comes from the navigation seam,
// which this app answers from `app/framework/navigation.ts`.
import { SignInForm } from "@/components/auth/sign-in-form.tsx";
import { safeRedirectPath } from "@/lib/authoring-proxy-policy.ts";
import { isMailEnabled } from "@/lib/mail-feature.ts";

/**
 * Sign-in route.
 *
 * The form keeps its client-side behavior (pending state, validation errors, API
 * failures) and posts to `/api/auth/:action`, which this app implements as a
 * resource route over the framework-neutral handler in `app/lib/auth-proxy.ts`.
 */
export async function loader({ request }: LoaderFunctionArgs) {
  const url = new URL(request.url);
  // Read at request time, not build time: switching mail on must not require a
  // rebuild, and the App Router page reads the same variable the same way.
  return { nextPath: safeRedirectPath(url.searchParams.get("next") ?? "/account"), mailEnabled: isMailEnabled() };
}

export const meta: MetaFunction = () => [
  { title: "进入写作 | 无浪潮" },
  { name: "robots", content: "noindex" },
];

export default function SignInRoute() {
  const { nextPath, mailEnabled } = useLoaderData<typeof loader>();
  return (
    <main className="nw-w" data-route="sign-in">
      <SignInForm nextPath={nextPath} mailEnabled={mailEnabled} />
    </main>
  );
}
