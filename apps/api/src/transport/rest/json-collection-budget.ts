import type { ServerResponse } from "node:http";
import { integerSetting } from "../../infrastructure/service-settings.ts";

export type JsonCollectionLimits = { timeoutMs?: number; maxItems?: number; itemBytes?: number; envelopeBytes?: number };
const MAX_ITEM_BYTES = 8 * 1024 * 1024;
const MAX_ENVELOPE_BYTES = 64 * 1024;
const MAX_ITEMS = 300;
const responseLimits = new WeakMap<ServerResponse, JsonCollectionLimits>();

/** Response output, not the separate ingress/body or database statement budget. */
export function jsonCollectionOutputSettings(env: NodeJS.ProcessEnv): JsonCollectionLimits {
  return Object.freeze({ timeoutMs: integerSetting(env, "API_COLLECTION_WRITE_TIMEOUT_MS", 120_000, 100, 600_000) });
}
export function configureJsonCollectionOutput(response: ServerResponse, limits: JsonCollectionLimits): void {
  responseLimits.set(response, limits);
}
export function takeJsonCollectionOutput(response: ServerResponse): JsonCollectionLimits | undefined {
  const limits = responseLimits.get(response);
  responseLimits.delete(response);
  return limits;
}

export class JsonCollectionBoundaryError extends Error {
  readonly reason: "timeout" | "item" | "envelope" | "items" | "chunk";
  constructor(reason: JsonCollectionBoundaryError["reason"]) {
    super(reason === "timeout" ? "The collection output deadline was exceeded." : "The collection output byte or item bound was exceeded.");
    this.name = "JsonCollectionBoundaryError";
    this.reason = reason;
  }
}

function bounded(value: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new RangeError("Invalid collection output limit.");
  return value;
}

/**
 * One absolute monotonic deadline covers encoding, drain and socket finish.
 * Timers wake an async wait; checkpoints also reject synchronous serialization
 * that kept the event loop too busy to deliver that timer. This is cooperative
 * enforcement, not CPU preemption. dispose severs the callback to the response.
 * Byte fences apply to actual UTF-8 chunks, not JS character or Content-Length
 * estimates, and never permit a larger reader fence or a silently short page.
 */
export class JsonCollectionBudget {
  private readonly deadline: number;
  private readonly itemLimit: number;
  private readonly envelopeLimit: number;
  private readonly itemCountLimit: number;
  private itemSize = 0;
  private envelopeSize = 0;
  private activeItem = false;
  private completedItems = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private timeout: JsonCollectionBoundaryError | undefined;
  private disposed = false;
  private stop: ((error: JsonCollectionBoundaryError) => void) | undefined;

  constructor(limits: JsonCollectionLimits, stop: (error: JsonCollectionBoundaryError) => void) {
    const timeoutMs = bounded(limits.timeoutMs ?? 120_000, 600_000);
    this.itemLimit = bounded(limits.itemBytes ?? MAX_ITEM_BYTES, MAX_ITEM_BYTES);
    this.envelopeLimit = bounded(limits.envelopeBytes ?? MAX_ENVELOPE_BYTES, MAX_ENVELOPE_BYTES);
    this.itemCountLimit = bounded(limits.maxItems ?? MAX_ITEMS, MAX_ITEMS);
    this.deadline = performance.now() + timeoutMs;
    this.stop = stop;
    this.arm();
  }

  private arm(): void {
    this.timer = setTimeout(() => {
      if (this.disposed) return;
      if (performance.now() < this.deadline) { this.arm(); return; }
      this.expire();
    }, Math.max(1, Math.ceil(this.deadline - performance.now())));
    this.timer.unref();
  }

  private expire(): JsonCollectionBoundaryError {
    if (!this.timeout) {
      this.timeout = new JsonCollectionBoundaryError("timeout");
      this.stop?.(this.timeout);
    }
    return this.timeout;
  }

  checkpoint(): void {
    if (this.disposed) throw new Error("The collection output budget is already closed.");
    if (this.timeout || performance.now() >= this.deadline) throw this.expire();
  }

  validateCount(length: number): void {
    this.checkpoint();
    if (!Number.isSafeInteger(length) || length < 0 || length > this.itemCountLimit) throw new JsonCollectionBoundaryError("items");
  }

  beginItem(): void {
    this.checkpoint();
    if (this.activeItem) throw new Error("A collection item has not finished.");
    if (this.completedItems >= this.itemCountLimit) throw new JsonCollectionBoundaryError("items");
    this.activeItem = true;
    this.itemSize = 0;
  }

  charge(bytes: number, part: "item" | "envelope"): void {
    this.checkpoint();
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > 64 * 1024) throw new JsonCollectionBoundaryError("chunk");
    if (part === "item") {
      if (!this.activeItem) throw new Error("A collection item was not started.");
      if (bytes > this.itemLimit - this.itemSize) throw new JsonCollectionBoundaryError("item");
      this.itemSize += bytes;
    } else {
      if (bytes > this.envelopeLimit - this.envelopeSize) throw new JsonCollectionBoundaryError("envelope");
      this.envelopeSize += bytes;
    }
  }

  endItem(): void {
    this.checkpoint();
    if (!this.activeItem) throw new Error("A collection item was not started.");
    this.activeItem = false;
    this.itemSize = 0;
    this.completedItems++;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.stop = undefined;
  }
}
