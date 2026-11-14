import { useBlocker, useLocation, useNavigate, useRevalidator } from "react-router";
import { useMemo } from "react";

/**
 * The navigation hooks half of the seam (`@/lib/framework/navigation.ts`).
 *
 * Companion to `link.tsx`: the router is spoken to here and nowhere else in the
 * package. `usePathname` drives the language switch and the active-nav state,
 * and `useRouter` carries the `replace`/`push`/`refresh` a form performs once it
 * succeeds — `refresh` being a React Router revalidation, the same operation for
 * loader data.
 */
export function usePathname(): string {
  return useLocation().pathname;
}

type AppRouter = {
  push(href: string): void;
  replace(href: string): void;
  refresh(): void;
  back(): void;
  forward(): void;
  prefetch(href: string): void;
};

export function useRouter(): AppRouter {
  const navigate = useNavigate();
  const { revalidate } = useRevalidator();
  return useMemo(() => ({
    push: (href) => navigate(href),
    replace: (href) => navigate(href, { replace: true }),
    refresh: () => revalidate(),
    back: () => navigate(-1),
    forward: () => navigate(1),
    // React Router prefetches through its own APIs; keep the call site working
    // rather than pretending this does something.
    prefetch: () => {},
  }), [navigate, revalidate]);
}

/** Block client-side navigation while the caller holds an unconfirmed write. */
export function useNavigationBlocker(when: boolean | (() => boolean)) {
  return useBlocker(when);
}
