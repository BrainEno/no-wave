/** CSP capabilities and URL-inert local shells cross Documents, not Router data-query transitions. */
export function requiresDocumentNavigation(currentPath: string, href: string): boolean {
  if (href.startsWith("#")) return false;
  const isolated = (path: string) => {
    try { return ["/write/vault", "/write/overlap", "/write/terms", "/write/cadence"].includes(decodeURIComponent(path).replace(/\/+$/, "")); }
    catch { return false; }
  };
  try {
    const target = new URL(href, `https://navigation.invalid${currentPath}`);
    if (target.protocol !== "https:" && target.protocol !== "http:") return false;
    return isolated(currentPath) || isolated(target.pathname);
  } catch { return false; }
}
