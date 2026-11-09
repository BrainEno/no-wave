import type { TokenSet } from "./policy.ts";

/**
 * One rotation, shared by every concurrent 401 that carries the same stale
 * credentials (ADR 0025).
 *
 * The API deliberately has no refresh grace window: presenting an already
 * consumed refresh token revokes the whole session family. The BFF therefore
 * has to make sure its own parallel requests never present the same token
 * twice. This module owns only *when* `rotate()` runs; the HTTP call, the
 * cookie writing and the identity layer stay where they were.
 */

/**
 * A `TokenSet` means rotation succeeded, `null` means the credential was
 * definitively refused, and `undefined` means a transient failure that proves
 * nothing about the session. The three answers are `forward.ts`'s existing
 * contract, kept verbatim so every waiter behaves like the first caller.
 */
export type RefreshOutcome = TokenSet | null | undefined;

export type RefreshCoordinator = {
  /** Perform `rotate()` at most once per key within a short reuse window. */
  resolve(key: string, rotate: () => Promise<RefreshOutcome>): Promise<RefreshOutcome>;
};

/** Domain separation, so a digest can never collide with another protocol's. */
const KEY_DOMAIN = "no-wave/refresh/v1";

/**
 * The ledger key is a digest, never the credential itself. Including the stale
 * access token means a caller must present the same pair to reuse a rotation;
 * including the API origin keeps two upstreams from sharing an outcome.
 */
export async function refreshCoordinatorKey(
  base: string,
  refreshToken: string,
  accessToken: string | undefined,
): Promise<string> {
  const material = `${KEY_DOMAIN}\0${base}\0${refreshToken}\0${accessToken ?? ""}`;
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(material));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export type InMemoryRefreshCoordinatorOptions = {
  /**
   * How long a settled result stays reusable. A request can reach its 401 after
   * the winner's rotation resolved but before the browser applied any
   * `Set-Cookie`; without this window it would submit the old token and revoke
   * the family. Short and memory-only by design.
   */
  reuseMs?: number;
  /**
   * How long a **transient** failure (`undefined`) stays reusable — the "no
   * answer, try again" case.
   *
   * It is deliberately much shorter than `reuseMs` (#244). Two requests whose
   * 401s landed together are one burst and must share one answer even if the
   * second one is descheduled until after the first settled; a request five
   * seconds later is a new attempt and must not inherit a dropped connection.
   */
  transientMs?: number;
  /** Cap on retained settled entries, so an abusive burst cannot grow the map. */
  maxEntries?: number;
  /** Injectable for deterministic tests. */
  now?: () => number;
};

const DEFAULT_REUSE_MS = 5_000;
const DEFAULT_MAX_ENTRIES = 1_024;

/**
 * How long "no answer, try again" is shared between requests (#244).
 *
 * A quarter of a second covers the scheduling gap between two requests that were
 * dispatched together, and is far too short to stand between a reader and a
 * retry. The reuse window it replaces was five seconds.
 */
const DEFAULT_TRANSIENT_MS = 250;

/** The shipped coordinator: a single-flight promise plus a short result ledger. */
export class InMemoryRefreshCoordinator implements RefreshCoordinator {
  private readonly pending = new Map<string, Promise<RefreshOutcome>>();
  private readonly settled = new Map<string, { at: number; outcome: RefreshOutcome }>();
  private readonly reuseMs: number;
  private readonly transientMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;

  constructor(options: InMemoryRefreshCoordinatorOptions = {}) {
    this.reuseMs = Math.max(0, options.reuseMs ?? DEFAULT_REUSE_MS);
    // Never longer than the reuse window itself: a caller that asked for no
    // reuse at all asked for none of the transient kind either.
    this.transientMs = Math.min(this.reuseMs, Math.max(0, options.transientMs ?? DEFAULT_TRANSIENT_MS));
    this.maxEntries = Math.max(1, Math.floor(options.maxEntries ?? DEFAULT_MAX_ENTRIES));
    this.now = options.now ?? Date.now;
  }

  async resolve(key: string, rotate: () => Promise<RefreshOutcome>): Promise<RefreshOutcome> {
    const now = this.now();
    this.expire(now);
    const cached = this.settled.get(key);
    if (cached) {
      const ttl = cached.outcome === undefined ? this.transientMs : this.reuseMs;
      if (ttl > 0 && now - cached.at < ttl) return cached.outcome;
    }
    const inFlight = this.pending.get(key);
    if (inFlight) return inFlight;

    const attempt = this.perform(key, rotate);
    this.pending.set(key, attempt);
    try {
      return await attempt;
    } finally {
      // A later rotation for the same key may already own `pending`.
      if (this.pending.get(key) === attempt) this.pending.delete(key);
    }
  }

  private async perform(key: string, rotate: () => Promise<RefreshOutcome>): Promise<RefreshOutcome> {
    let outcome: RefreshOutcome;
    try {
      outcome = await rotate();
    } catch {
      // A thrown rotation proves nothing about the session, exactly like a 5xx.
      // It must not clear cookies, and it must not reject one of the waiters.
      outcome = undefined;
    }
    // Every answer is settled, but a transient one for a much shorter window
    // (#244). Siblings in one burst must still share a failure — they were
    // already in flight, and re-presenting the same refresh token is what revokes
    // the family — while a request arriving after that window retries instead of
    // inheriting a dropped connection for the whole reuse period, which is how
    // one blip became five seconds of failures for every request in between.
    const at = this.now();
    this.expire(at);
    this.settled.delete(key);
    this.settled.set(key, { at, outcome });
    this.bound();
    return outcome;
  }

  private expire(now: number): void {
    for (const [key, entry] of this.settled) {
      const ttl = entry.outcome === undefined ? this.transientMs : this.reuseMs;
      if (now - entry.at < ttl) continue;
      this.settled.delete(key);
    }
  }

  private bound(): void {
    while (this.settled.size > this.maxEntries) {
      const oldest = this.settled.keys().next();
      if (oldest.done) break;
      this.settled.delete(oldest.value);
    }
  }
}
