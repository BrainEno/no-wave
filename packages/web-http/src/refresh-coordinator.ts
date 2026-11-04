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
  /** Cap on retained settled entries, so an abusive burst cannot grow the map. */
  maxEntries?: number;
  /** Injectable for deterministic tests. */
  now?: () => number;
};

const DEFAULT_REUSE_MS = 5_000;
const DEFAULT_MAX_ENTRIES = 1_024;

/** The shipped coordinator: a single-flight promise plus a short result ledger. */
export class InMemoryRefreshCoordinator implements RefreshCoordinator {
  private readonly pending = new Map<string, Promise<RefreshOutcome>>();
  private readonly settled = new Map<string, { at: number; outcome: RefreshOutcome }>();
  private readonly reuseMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;

  constructor(options: InMemoryRefreshCoordinatorOptions = {}) {
    this.reuseMs = Math.max(0, options.reuseMs ?? DEFAULT_REUSE_MS);
    this.maxEntries = Math.max(1, Math.floor(options.maxEntries ?? DEFAULT_MAX_ENTRIES));
    this.now = options.now ?? Date.now;
  }

  async resolve(key: string, rotate: () => Promise<RefreshOutcome>): Promise<RefreshOutcome> {
    const now = this.now();
    this.expire(now);
    const cached = this.settled.get(key);
    if (cached && this.reuseMs > 0 && now - cached.at < this.reuseMs) return cached.outcome;
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
    const at = this.now();
    this.expire(at);
    this.settled.delete(key);
    this.settled.set(key, { at, outcome });
    this.bound();
    return outcome;
  }

  private expire(now: number): void {
    for (const [key, entry] of this.settled) {
      if (now - entry.at < this.reuseMs) continue;
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
