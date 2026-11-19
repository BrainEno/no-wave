import { recoveryId } from "./writing-recovery-model.ts";
import {
  IndexedWritingRecoveryStore,
  type WritingRecoveryStore,
} from "./writing-recovery-store.ts";

export const RECOVERY_BOUNDARY_CHANNEL = "no-wave-writing-recovery-boundary-v1";
export type RecoveryBoundaryOptions = {
  store(): Pick<WritingRecoveryStore, "purge"> & { close(): void };
  send(value: unknown): void;
  id(): string;
};

/** Notifications invalidate only: they carry no account, credentials, text,
 * request intent or authority to enable storage. IDB transactions enforce the
 * actual fence even when the browser blocks cross-tab notification delivery. */
export class WritingRecoveryBoundary {
  private options: RecoveryBoundaryOptions;
  private listeners = new Set<(source: string) => void>();
  constructor(options: RecoveryBoundaryOptions) {
    this.options = options;
  }
  subscribe(listener: (source: string) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  announce(source?: string): void {
    try {
      source ??= this.options.id();
    } catch {
      /* Never invent a cross-tab identifier. */
    }
    if (!recoveryId(source)) {
      for (const listener of this.listeners) listener("local-only");
      return;
    }
    this.receive({ version: 1, source });
    try {
      this.options.send({ version: 1, source });
    } catch {
      /* Delivery is best effort, never a durability claim. */
    }
  }
  receive(value: unknown): void {
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    const fields = Object.keys(value);
    if (
      fields.length !== 2 ||
      !fields.includes("version") ||
      !fields.includes("source")
    )
      return;
    const record = value as Record<string, unknown>;
    if (record.version !== 1 || !recoveryId(record.source)) return;
    for (const listener of this.listeners) listener(record.source);
  }
  /** Purge before dispatch AND after its response (including ambiguous failure).
   * A different tab can be opened and opt in while the request is in flight;
   * the second epoch fence prevents that tab from leaving account data behind.
   * Deletion failure must not block logout, nor disappear behind a redirect. */
  async runSessionChange<T>(
    action: () => Promise<T>,
    warning?: (value: string | null) => void,
  ): Promise<T> {
    const initial = await this.clearForSessionChange();
    warning?.(initial);
    try {
      return await action();
    } finally {
      const final = await this.clearForSessionChange();
      warning?.(final ?? initial);
    }
  }
  async clearForSessionChange(): Promise<string | null> {
    // This runs before the first await, so queued editor callbacks cannot keep
    // using a live in-memory lease while the account-changing request starts.
    this.announce();
    let store: ReturnType<RecoveryBoundaryOptions["store"]> | undefined;
    try {
      store = this.options.store();
      await store.purge();
      return null;
    } catch {
      return "未能清除本机文稿缓存，不能保证设备上没有旧稿。请在浏览器设置中清除本站数据，尤其不要在共享设备上留下缓存。登录凭据不会写入文稿缓存。";
    } finally {
      store?.close();
      this.announce();
    }
  }
}

let browserBoundary: WritingRecoveryBoundary | null = null;
/** Browser-only lazy owner; construction/import on the SSR server has no effects. */
export function writingRecoveryBoundary(): WritingRecoveryBoundary {
  if (browserBoundary) return browserBoundary;
  let channel: BroadcastChannel | null = null;
  try {
    channel = new BroadcastChannel(RECOVERY_BOUNDARY_CHANNEL);
  } catch {
    /* storage events remain an optional fallback */
  }
  const boundary = new WritingRecoveryBoundary({
    id: () => crypto.randomUUID(),
    store: () => new IndexedWritingRecoveryStore(),
    send: (value) => {
      try {
        channel?.postMessage(value);
      } catch {
        /* Try the metadata-only fallback too. */
      }
      try {
        window.localStorage.setItem(
          RECOVERY_BOUNDARY_CHANNEL,
          JSON.stringify(value),
        );
      } catch {
        /* A blocked notification transport cannot bypass the persisted epoch. */
      }
    },
  });
  if (channel)
    channel.onmessage = (event) => {
      boundary.receive(event.data);
    };
  window.addEventListener("storage", (event) => {
    if (event.key !== RECOVERY_BOUNDARY_CHANNEL || event.newValue === null)
      return;
    try {
      boundary.receive(JSON.parse(event.newValue) as unknown);
    } catch {
      /* malformed metadata is ignored */
    }
  });
  browserBoundary = boundary;
  return boundary;
}
