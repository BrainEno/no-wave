import { Link as RouterLink } from "react-router";
import type { AnchorHTMLAttributes, ReactNode } from "react";

/**
 * The React Router half of the navigation seam (`@/lib/framework/link.tsx`).
 *
 * The shared components ask for a `Link`; this is the one this application
 * answers with. React Router exposes the same capability under a different prop
 * name (`to` rather than `href`) and without `prefetch`, so one thin adapter is
 * enough to render those components unchanged. Prefetch is deliberately absent
 * from the contract rather than a silent no-op: the two applications prefetch
 * through different mechanisms, and a shared component that asked for one would
 * be asking for something that does not exist here.
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

export function Link({ href, prefetch, replace, scroll, children, ...rest }: NextLinkProps) {
  void prefetch;
  return (
    <RouterLink to={toHref(href)} replace={replace} preventScrollReset={scroll === false} {...rest}>
      {children}
    </RouterLink>
  );
}
