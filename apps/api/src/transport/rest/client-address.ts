import { isIP } from "node:net";
import type { IncomingMessage } from "node:http";

/**
 * Which address a rate-limit bucket, a login attempt or a session list is charged
 * to (audit F-21).
 *
 * The API used `request.socket.remoteAddress` everywhere, and deliberately ignored
 * `X-Forwarded-For`: a header any client can write must never choose its own
 * bucket. That is the right default on a host where the process sees the visitor
 * directly. It stops being right the moment the process sits behind a reverse
 * proxy, a platform router or a container ingress — and every real deployment of
 * this project does. There, the socket peer is the *proxy*:
 *
 * - every visitor shares one `ip` bucket, so a single noisy client throttles
 *   everyone (the per-IP limits stop being per-IP and become a global cap);
 * - `refresh`/`login`/`register` attempt limits collapse the same way, so the
 *   protection that matters most is the one that silently disappeared;
 * - session lists record the proxy as "the device you are on".
 *
 * Blindly trusting the header is not the fix — it would let an attacker choose a
 * fresh bucket per request and make the limits useless in the other direction.
 * The fix is to say **how many proxies are in front of us**, and to read the
 * address exactly that far from the right of the chain, where a proxy we trust
 * wrote it.
 *
 *   `TRUSTED_PROXY_HOPS=0` (default)  the socket peer. `X-Forwarded-For` is
 *                                     ignored, which is the previous behaviour.
 *   `TRUSTED_PROXY_HOPS=1`            one proxy (Render, Fly, nginx,
 *                                     `docker run -p`, …): the last entry.
 *   `TRUSTED_PROXY_HOPS=2`            two (a CDN in front of an ingress, …):
 *                                     the entry before that.
 *
 * Anything an attacker writes to the left of that position is ignored, because
 * only the entries at and after it were appended by infrastructure we named. If
 * the chain is shorter than the configured number of hops, the configuration does
 * not describe this deployment and the socket peer is used — the safe direction.
 */

export const DEFAULT_TRUSTED_PROXY_HOPS = 0;
export const MAXIMUM_TRUSTED_PROXY_HOPS = 5;

/**
 * Read `TRUSTED_PROXY_HOPS`.
 *
 * An invalid value is a startup error rather than a silent fallback: an operator
 * who wrote `TRUSTED_PROXY_HOPS=true` believes the proxy is handled, and quietly
 * charging every visitor to one bucket is exactly the state this option exists to
 * end.
 */
export function resolveTrustedProxyHops(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env?.TRUSTED_PROXY_HOPS;
  if (raw === undefined || raw === null || String(raw).trim() === "") return DEFAULT_TRUSTED_PROXY_HOPS;
  const parsed = Number(String(raw).trim());
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > MAXIMUM_TRUSTED_PROXY_HOPS) {
    throw new RangeError(
      `TRUSTED_PROXY_HOPS must be an integer between 0 and ${MAXIMUM_TRUSTED_PROXY_HOPS}.`,
    );
  }
  return parsed;
}

/** `::ffff:192.0.2.10` and `192.0.2.10` are the same bucket, so say so once. */
function normalizeAddress(address: string): string | null {
  const trimmed = address.trim();
  if (trimmed.length === 0) return null;
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(trimmed);
  if (mapped) return isIP(mapped[1]) === 4 ? mapped[1] : null;
  if (isIP(trimmed)) return trimmed;
  // Some proxies append the source port (`192.0.2.10:54321`, `[2001:db8::1]:443`).
  const bracketed = /^\[([^\]]+)\]:\d{1,5}$/.exec(trimmed);
  if (bracketed && isIP(bracketed[1]) === 6) return bracketed[1];
  const withPort = /^([^:]+):\d{1,5}$/.exec(trimmed);
  if (withPort && isIP(withPort[1]) === 4) return withPort[1];
  return null;
}

/** The TCP peer, normalized, or `null` when the runtime did not report one. */
export function socketAddress(request: Pick<IncomingMessage, "socket">): string | null {
  return normalizeAddress(request.socket?.remoteAddress ?? "");
}

function forwardedEntries(request: Pick<IncomingMessage, "headers">): string[] {
  const header = request.headers?.["x-forwarded-for"];
  // Duplicate headers are joined in arrival order, which is the order a chain
  // through several proxies produces anyway.
  const joined = Array.isArray(header) ? header.join(",") : header;
  if (typeof joined !== "string" || joined.trim().length === 0) return [];
  return joined.split(",").map((entry) => entry.trim()).filter((entry) => entry.length > 0);
}

/**
 * The address this request should be charged to.
 *
 * Never returns an empty string: a request the runtime cannot attribute is
 * `"unknown"`, which is one shared bucket — the honest answer for "we do not
 * know", and the same placeholder the API used before this existed.
 */
export function clientAddressFor(
  request: Pick<IncomingMessage, "headers" | "socket">,
  trustedProxyHops: number = DEFAULT_TRUSTED_PROXY_HOPS,
): string {
  const unknown = "unknown";
  const peer = socketAddress(request) ?? null;
  if (!Number.isInteger(trustedProxyHops) || trustedProxyHops <= 0) return peer ?? unknown;

  const entries = forwardedEntries(request);
  // A shorter chain than the configured number of proxies means this request did
  // not come through what we configured: do not guess, and do not trust it.
  if (entries.length < trustedProxyHops) return peer ?? unknown;

  // Position counted from the right: the entries at the end were appended by the
  // proxies we named, and the one before them is the address the outermost of
  // those proxies received.
  const candidate = normalizeAddress(entries[entries.length - trustedProxyHops]);
  return candidate ?? peer ?? unknown;
}
