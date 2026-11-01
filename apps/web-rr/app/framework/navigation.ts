import { useLocation, useNavigate, useRevalidator } from "react-router";

/**
 * The React Router half of the navigation hooks (`@/lib/framework/navigation.ts`).
 *
 * `usePathname` drives the language switch and the active-nav state; `useRouter`
 * carries the `replace`/`push`/`refresh` a form performs once it succeeds.
 * `refresh` maps to a React Router revalidation, which is the equivalent
 * operation for loader data.
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
  const revalidator = useRevalidator();
  return {
    push: (href) => navigate(href),
    replace: (href) => navigate(href, { replace: true }),
    refresh: () => revalidator.revalidate(),
    back: () => navigate(-1),
    forward: () => navigate(1),
    // React Router prefetches through its own APIs; keep the call site working
    // rather than pretending this does something.
    prefetch: () => {},
  };
}
