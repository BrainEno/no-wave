/**
 * `WEB_DEV_ALLOWED_ORIGINS` -> Next.js `allowedDevOrigins`.
 *
 * The Next.js dev server only serves development assets to hostnames it trusts.
 * `localhost`/`127.0.0.1` are trusted implicitly; anything else (a LAN address, a
 * TLS-terminating preview proxy, a browser on a phone) has to be declared or its
 * `/_next/*` requests are rejected and the page loads without styles or hydration.
 *
 * Entries are matched as host[:port] patterns, so a scheme or path is stripped:
 * `http://192.168.1.10:3000` and `192.168.1.10:3000` are the same declaration.
 * Wildcards such as `*.preview.example` are passed through unchanged.
 */
export function parseAllowedDevOrigins(value: string | undefined): string[] {
  if (typeof value !== "string") return [];
  const origins: string[] = [];
  for (const rawEntry of value.split(",")) {
    const entry = rawEntry.trim();
    if (entry.length === 0) continue;
    let host = entry;
    if (/^https?:\/\//i.test(entry)) {
      try {
        host = new URL(entry).host;
      } catch {
        continue;
      }
    } else if (entry.includes("://")) {
      // Any other scheme is not an HTTP origin the dev server can serve.
      continue;
    } else {
      host = entry.replace(/\/.*$/, "");
    }
    host = host.toLowerCase();
    if (host.length === 0) continue;
    if (!/^[a-z0-9.*:[\]-]+$/.test(host)) continue;
    if (!origins.includes(host)) origins.push(host);
  }
  return origins;
}
