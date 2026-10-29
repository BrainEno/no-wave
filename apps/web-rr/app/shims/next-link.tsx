import { Link as RouterLink } from "react-router";
import type { AnchorHTMLAttributes, ReactNode } from "react";

/**
 * `next/link` adapter.
 *
 * The shared components in `apps/web/src` import `next/link` for client-side
 * navigation. React Router exposes the same capability with a different prop
 * name (`to` instead of `href`) and without `prefetch`, so one thin adapter is
 * enough to render those components unchanged. Prefetch is intentionally a no-op:
 * React Router prefetches through its own data APIs, and pretending otherwise
 * would hide a behavior difference between the two applications.
 */
type NextLinkProps = Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href"> & {
  href: string | { pathname?: string; query?: Record<string, string>; hash?: string };
  children: ReactNode;
  prefetch?: boolean | null;
  replace?: boolean;
  scroll?: boolean;
};

function toHref(href: NextLinkProps["href"]): string {
  if (typeof href === "string") return href;
  const search = href.query ? `?${new URLSearchParams(href.query).toString()}` : "";
  return `${href.pathname ?? "/"}${search}${href.hash ? `#${href.hash}` : ""}`;
}

export default function Link({ href, prefetch, replace, scroll, children, ...rest }: NextLinkProps) {
  void prefetch;
  return (
    <RouterLink to={toHref(href)} replace={replace} preventScrollReset={scroll === false} {...rest}>
      {children}
    </RouterLink>
  );
}
