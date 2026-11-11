import { isIP } from "node:net";
import { pathToFileURL } from "node:url";

/** Only the official Ubuntu archive domains that the hosted runner uses. */
export const UBUNTU_HOSTS = ["archive.ubuntu.com", "security.ubuntu.com", "azure.archive.ubuntu.com"] as const;
const resolvers = ["https://dns.google/resolve", "https://cloudflare-dns.com/dns-query"] as const;

type DnsResponse = { Status?: unknown; Answer?: unknown };

/** Parse an HTTPS DNS response without allowing arbitrary hosts, shell text or IPv6. */
export function ipv4Answers(value: unknown): string[] {
  if (typeof value !== "object" || value === null) return [];
  const response = value as DnsResponse;
  if (response.Status !== 0 || !Array.isArray(response.Answer)) return [];
  const addresses = new Set<string>();
  for (const entry of response.Answer) {
    if (typeof entry !== "object" || entry === null || !("type" in entry) || !("data" in entry)) continue;
    if (entry.type === 1 && typeof entry.data === "string" && isIP(entry.data) === 4) addresses.add(entry.data);
  }
  return [...addresses];
}

/**
 * Resolve only missing Ubuntu hosts using HTTPS-authenticated public DNS.
 * This is a temporary CI runner workaround, not an application resolver. Apt
 * continues to enforce the Ubuntu archive's repository signatures.
 */
export async function resolveUbuntuHosts(
  hosts: readonly string[],
  lookup: typeof fetch = fetch,
): Promise<string[]> {
  const unique = [...new Set(hosts)];
  if (unique.some((host) => !(UBUNTU_HOSTS as readonly string[]).includes(host))) throw new Error("Unexpected DNS hostname");
  const lines: string[] = [];
  for (const host of unique) {
    let addresses: string[] = [];
    for (const resolver of resolvers) {
      try {
        const url = new URL(resolver);
        url.searchParams.set("name", host);
        url.searchParams.set("type", "A");
        const response = await lookup(url, { headers: { accept: "application/dns-json" }, signal: AbortSignal.timeout(10_000) });
        if (!response.ok) continue;
        addresses = ipv4Answers(await response.json());
        if (addresses.length) break;
      } catch { /* Try the other HTTPS resolver. */ }
    }
    if (!addresses.length) throw new Error(`Unable to resolve ${host} using HTTPS DNS`);
    // Use all current A records, but do not output anything until all names have
    // resolved: a partial result must not modify /etc/hosts.
    for (const address of addresses) lines.push(`${address} ${host}`);
  }
  return lines;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const lines = await resolveUbuntuHosts(process.argv.slice(2));
    if (lines.length) process.stdout.write(`${lines.join("\n")}\n`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Ubuntu DNS fallback failed");
    process.exitCode = 1;
  }
}
