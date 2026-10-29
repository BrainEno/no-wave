import { useLocation, useNavigate, useRevalidator, useSearchParams as useRouterSearchParams } from "react-router";

/**
 * `next/navigation` adapter.
 *
 * Only the hooks the shared components actually use are provided:
 * `usePathname` (language switching and active-nav state) and `useRouter`
 * (`replace`/`push`/`refresh` after a successful sign-in). `refresh` maps to a
 * React Router revalidation, which is the equivalent operation for loader data.
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

export function useSearchParams(): [URLSearchParams, (next: URLSearchParams | Record<string, string>) => void] {
  return useRouterSearchParams();
}
