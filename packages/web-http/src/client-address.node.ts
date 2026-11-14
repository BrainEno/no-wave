import { AsyncLocalStorage } from "node:async_hooks";
import { createHmac } from "node:crypto";
import { BlockList, isIP } from "node:net";
import type { IncomingMessage } from "node:http";

type AddressRequest = { headers: IncomingMessage["headers"]; socket: Pick<IncomingMessage["socket"], "remoteAddress"> & { encrypted?: boolean } };
type ClientScope = Readonly<{ address: string; secret: string; now: () => number }>;
const scopes = new AsyncLocalStorage<ClientScope | null>();
const secureTransports = new AsyncLocalStorage<boolean>();

/** Native ingress evidence only: never infer TLS from a Fetch URL or browser header. */
export function currentWebRequestIsSecure(): boolean {
  return secureTransports.getStore() === true;
}
const ADDRESS = "x-nw-client-address";
const PROOF = "x-nw-client-address-proof";

/** Server-only entry point; never re-export this module from the browser-safe index. */
function normalizedAddress(value: string): string | null {
  let address = value.trim();
  if (!address || address.includes("%")) return null;
  if (!isIP(address)) {
    const port = /^(?:\[([^\]]+)\]|([^:]+)):(\d{1,5})$/.exec(address);
    if (!port || Number(port[3]) > 65535 || Number(port[3]) < 1) return null;
    address = port[1] ?? port[2]!;
  }
  const family = isIP(address);
  if (family === 4) return address;
  if (family !== 6) return null;
  const canonical = new URL(`http://[${address}]/`).hostname.slice(1, -1);
  const mapped = /^::ffff:([0-9a-f]+):([0-9a-f]+)$/.exec(canonical);
  if (!mapped) return canonical;
  const high = parseInt(mapped[1]!, 16), low = parseInt(mapped[2]!, 16);
  return `${high >>> 8}.${high & 255}.${low >>> 8}.${low & 255}`;
}

function signingSecret(raw: string | undefined): string | null {
  if (raw === undefined || raw === "") return null;
  if (!/^[\x21-\x7e]{32,512}$/.test(raw)) {
    throw new RangeError("BFF_CLIENT_ADDRESS_SECRET must contain 32 to 512 non-whitespace ASCII characters.");
  }
  return raw;
}

function proxyHops(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return 0;
  if (!/^\d+$/.test(raw.trim()) || Number(raw) > 5) throw new RangeError("WEB_TRUSTED_PROXY_HOPS must be an integer between 0 and 5.");
  return Number(raw);
}

function trustedPeers(raw: string | undefined, hops: number): BlockList {
  const list = new BlockList();
  if (raw === undefined || raw.trim() === "") {
    if (hops > 0) throw new RangeError("WEB_TRUSTED_PROXY_PEERS must name the ingress peers when proxy hops are enabled.");
    return list;
  }
  const invalid = () => new RangeError("WEB_TRUSTED_PROXY_PEERS must be a bounded list of IP addresses or non-zero-prefix CIDRs.");
  if (raw.length > 4096) throw invalid();
  const entries = raw.split(",").map((entry) => entry.trim());
  if (entries.length > 32) throw invalid();
  for (const entry of entries) {
    const [host, prefix, extra] = entry.split("/");
    if (!host || !isIP(host) || host.includes("%") || extra !== undefined) throw invalid();
    const address = normalizedAddress(host);
    if (!address) throw invalid();
    const family = isIP(address) === 4 ? "ipv4" : "ipv6";
    if (prefix === undefined) list.addAddress(address, family);
    else {
      const maximum = family === "ipv4" ? 32 : 128;
      if (!/^[1-9][0-9]*$/.test(prefix) || Number(prefix) > maximum) throw invalid();
      list.addSubnet(address, Number(prefix), family);
    }
  }
  return list;
}

/** Resolve once at server composition; no permissive recovery from a bad deployment policy. */
export function createWebClientAddressBridge(env: NodeJS.ProcessEnv, now: () => number = Date.now) {
  const secret = signingSecret(env.BFF_CLIENT_ADDRESS_SECRET);
  const hops = proxyHops(env.WEB_TRUSTED_PROXY_HOPS);
  const peers = trustedPeers(env.WEB_TRUSTED_PROXY_PEERS, hops);
  function isSecure(request: AddressRequest): boolean {
    const nativeTls = (request.socket as typeof request.socket & { encrypted?: boolean })?.encrypted === true;
    const peer = normalizedAddress(request.socket?.remoteAddress ?? "");
    if (!peer || hops === 0 || !peers.check(peer, isIP(peer) === 4 ? "ipv4" : "ipv6")) return nativeTls;
    // Only an explicitly named ingress can describe the browser-facing scheme.
    // The protocol suffix must align with the same complete, trusted address
    // chain as attribution; neither Forwarded nor SITE_URL is transport proof.
    const forwarded = request.headers["x-forwarded-for"];
    const addresses = Array.isArray(forwarded) ? forwarded.join(",") : forwarded;
    const protocol = request.headers["x-forwarded-proto"];
    if (!addresses || addresses.length > 8192 || typeof protocol !== "string" || protocol.length > 8192) return false;
    const entries = addresses.split(","), protocols = protocol.split(",");
    if (entries.length < hops || protocols.length < hops) return false;
    const suffix = entries.slice(-hops).map(normalizedAddress);
    if (suffix.some(address => address === null) || suffix.slice(1).some(address => !peers.check(address!, isIP(address!) === 4 ? "ipv4" : "ipv6"))) return false;
    const schemes = protocols.slice(-hops).map(value => value.trim().toLowerCase());
    if (schemes.some(value => value !== "http" && value !== "https")) return false;
    return schemes[0] === "https";
  }
  function clientAddress(request: AddressRequest): string | null {
    const peer = normalizedAddress(request.socket?.remoteAddress ?? "");
    if (!peer || hops === 0 || !peers.check(peer, isIP(peer) === 4 ? "ipv4" : "ipv6")) return peer;
    const header = request.headers["x-forwarded-for"];
    const chain = Array.isArray(header) ? header.join(",") : header;
    if (!chain || chain.length > 8192) return peer;
    const entries = chain.split(",");
    if (entries.length < hops) return peer;
    const suffix = entries.slice(-hops).map(normalizedAddress);
    if (suffix.some((address) => address === null)) return peer;
    // Every hop after the selected visitor must be an authorized proxy too.
    // Otherwise someone connecting directly to the last ingress could supply
    // the missing earlier hop and turn a shorter path into an arbitrary claim.
    if (suffix.slice(1).some((address) => !peers.check(address!, isIP(address!) === 4 ? "ipv4" : "ipv6"))) return peer;
    return suffix[0]!;
  }
  return Object.freeze({
    enabled: secret !== null,
    trustedProxyHops: hops,
    isSecure,
    run<T>(request: AddressRequest, work: () => T): T {
      const address = clientAddress(request);
      // Transport evidence is independent of whether BFF address signing is on.
      // A nested HTTP/disabled ingress must shadow an outer HTTPS scope too.
      return secureTransports.run(isSecure(request), () =>
        scopes.run(secret && address ? Object.freeze({ address, secret, now }) : null, work));
    },
  });
}

/** Called for each actual upstream target, not once for a resource/refresh/retry sequence. */
export function upstreamClientAddressHeaders(target: string, method: string): Readonly<Record<string, string>> {
  const scope = scopes.getStore();
  if (!scope) return {};
  const url = new URL(target);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash || !/^[A-Z]+$/.test(method)) {
    throw new RangeError("Invalid upstream client-address signing target.");
  }
  const seconds = Math.floor(scope.now() / 1000);
  if (!Number.isSafeInteger(seconds) || seconds < 1) throw new RangeError("Invalid client-address signing clock.");
  const signature = createHmac("sha256", scope.secret)
    .update(JSON.stringify(["no-wave:bff-client-address:v1", seconds, method, url.pathname + url.search, scope.address])).digest("hex");
  return { [ADDRESS]: scope.address, [PROOF]: `v1.${seconds}.${signature}` };
}
