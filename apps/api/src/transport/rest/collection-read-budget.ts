import type { ServerResponse } from "node:http";
import { integerSetting } from "../../infrastructure/service-settings.ts";
import { JSON_HEADERS } from "./http.ts";

const reading = new WeakMap<ServerResponse, CollectionReadBudget>();
export function collectionReadTimeout(env: NodeJS.ProcessEnv): number {
  if (env.API_COLLECTION_READ_TIMEOUT_MS === "") throw new RangeError("API_COLLECTION_READ_TIMEOUT_MS must not be empty.");
  return integerSetting(env, "API_COLLECTION_READ_TIMEOUT_MS", 120_000, 100, 600_000);
}
export function collectionReadBudgetFor(response: ServerResponse): CollectionReadBudget | undefined {
  return reading.get(response);
}
export class CollectionReadEndedError extends Error {
  constructor() { super("The article collection read has ended."); this.name = "CollectionReadEndedError"; }
}

/**
 * Bound the wait before the writer starts, including the initial DB read and
 * batched author/taxonomy projections. Ending the HTTP response is NOT releasing
 * a database operation: the handler's admission lease outlives this timer until
 * its real await settles. No race fabricates a physical completion receipt.
 */
export class CollectionReadBudget {
  readonly signal: AbortSignal;
  private readonly response: ServerResponse;
  private readonly controller = new AbortController();
  private readonly deadline: number;
  private phase: "reading" | "finished" | "cancelled" | "timeout" = "reading";
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(response: ServerResponse, timeoutMs: number) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 600_000) throw new RangeError("Invalid article collection read deadline.");
    if (reading.has(response)) throw new Error("The response already owns a collection read.");
    this.response = response;
    this.signal = this.controller.signal;
    this.deadline = performance.now() + timeoutMs;
    reading.set(response, this);
    response.once("close", this.cancel);
    response.once("finish", this.cancel);
    if (response.destroyed || response.writableEnded) this.cancel();
    else this.arm();
  }

  private arm(): void {
    this.timer = setTimeout(() => {
      if (this.phase !== "reading") return;
      if (performance.now() < this.deadline) this.arm();
      else this.expire();
    }, Math.max(1, Math.ceil(this.deadline - performance.now())));
    this.timer.unref();
  }

  private cancel = (): void => {
    if (this.phase !== "reading") return;
    this.phase = "cancelled";
    this.detach();
    this.controller.abort(new CollectionReadEndedError());
  };

  private expire(): void {
    if (this.phase !== "reading") return;
    this.phase = "timeout";
    this.detach();
    // Abort cooperative card cursors, but retain the handler's physical slot
    // even if the adapter ignores this signal or its cancellation is delayed.
    this.controller.abort(new CollectionReadEndedError());
    if (this.response.destroyed || this.response.writableEnded) return;
    if (this.response.headersSent) this.response.destroy();
    else {
      this.response.writeHead(504, JSON_HEADERS);
      this.response.end(JSON.stringify({ error: { code: "COLLECTION_READ_TIMEOUT", message: "The article collection could not be read in time." } }));
    }
  }

  checkpoint(): void {
    if (this.phase === "reading" && (this.response.destroyed || this.response.writableEnded)) this.cancel();
    if (this.phase === "reading" && performance.now() >= this.deadline) this.expire();
    if (this.phase !== "reading") throw new CollectionReadEndedError();
  }

  /** Transfer to the independent output budget only after the last DB await. */
  complete(): void {
    this.checkpoint();
    this.phase = "finished";
    this.detach();
    reading.delete(this.response);
  }

  private detach(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.response.off("close", this.cancel);
    this.response.off("finish", this.cancel);
  }

  /** The handler calls this on every path, including validation/auth errors. */
  dispose(): void {
    this.cancel();
    this.detach();
    reading.delete(this.response);
  }
}
