import { Link as RouterLink } from "react-router";
import type { AnchorHTMLAttributes, ReactNode } from "react";

/**
 * The navigation seam (`@/lib/framework/link.tsx`), React Router edition.
 *
 * Everything in `components/` asks for a `Link` and never for a router, so this
 * directory is the only place the UI is tied to one. React Router names the
 * target `to` rather than `href` and has no `prefetch`, which is what this
 * adapter absorbs; a different router would be a different pair of files here
 * and nothing else in the package would change.
 *
 * `prefetch` is accepted and ignored rather than honoured: it is part of the
 * call sites, and the router prefetches through its own API.
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
