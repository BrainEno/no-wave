import { createHmac, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import type { IncomingMessage } from "node:http";
import { clientAddressFor, resolveTrustedProxyHops } from "./client-address.ts";

type AddressRequest = Pick<IncomingMessage, "headers" | "socket" | "method" | "url">;
const ADDRESS = "x-nw-client-address";
const PROOF = "x-nw-client-address-proof";
const SKEW_SECONDS = 30;

/** The signer only emits canonical IPs, never a port, zone identifier or textual bucket label. */
function canonicalAddress(value: string): boolean {
  const family = isIP(value);
  if (family === 4) return true;
  if (family !== 6 || value.includes("%")) return false;
  const canonical = new URL(`http://[${value}]/`).hostname.slice(1, -1);
  return canonical === value && !canonical.startsWith("::ffff:");
}

/**
 * Optional authenticated BFF metadata, not authentication or a resource permission.
 * In bridge mode unsigned requests always fall back to their socket: enabling
 * legacy hop trust as well would let a forged proof regain authority through XFF.
 */
export function createBffClientAddressResolver(env: NodeJS.ProcessEnv, now: () => number = Date.now) {
  const hops = resolveTrustedProxyHops(env);
  const raw = env.BFF_CLIENT_ADDRESS_SECRET;
  const secret = raw === undefined || raw === "" ? null : raw;
  if (secret !== null && !/^[\x21-\x7e]{32,512}$/.test(secret)) {
    throw new RangeError("BFF_CLIENT_ADDRESS_SECRET must contain 32 to 512 non-whitespace ASCII characters.");
  }
  if (secret !== null && hops !== 0) {
    throw new RangeError("TRUSTED_PROXY_HOPS must be 0 when the signed BFF client-address bridge is enabled.");
  }
  return (request: AddressRequest): string => {
    const fallback = clientAddressFor(request, secret === null ? hops : 0);
    if (secret === null) return fallback;
    const address = request.headers[ADDRESS], proof = request.headers[PROOF];
    if (typeof address !== "string" || address.length > 45 || !canonicalAddress(address) || typeof proof !== "string" || proof.length > 100) return fallback;
    const parsed = /^v1\.([1-9][0-9]{0,15})\.([0-9a-f]{64})$/.exec(proof);
    if (!parsed) return fallback;
    const seconds = Number(parsed[1]), currentSeconds = Math.floor(now() / 1000);
    if (!Number.isSafeInteger(seconds) || !Number.isSafeInteger(currentSeconds) || currentSeconds < 1 || Math.abs(currentSeconds - seconds) > SKEW_SECONDS) return fallback;
    const method = request.method ?? "GET", target = request.url ?? "/";
    const expected = createHmac("sha256", secret)
      .update(JSON.stringify(["no-wave:bff-client-address:v1", seconds, method, target, address])).digest();
    const supplied = Buffer.from(parsed[2]!, "hex");
    return supplied.length === expected.length && timingSafeEqual(supplied, expected) ? address : fallback;
  };
}
