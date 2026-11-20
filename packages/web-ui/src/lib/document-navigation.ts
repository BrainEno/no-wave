/** A CSP capability belongs to a Document, not to a client-side route transition. */
export function requiresDocumentNavigation(currentPath: string, href: string): boolean {
  if (href.startsWith("#")) return false;
  const vault = (path: string) => {
    try { return decodeURIComponent(path).replace(/\/+$/, "") === "/write/vault"; }
    catch { return false; }
  };
  try {
    const target = new URL(href, `https://navigation.invalid${currentPath}`);
    if (target.protocol !== "https:" && target.protocol !== "http:") return false;
    return vault(currentPath) || vault(target.pathname);
  } catch { return false; }
}
