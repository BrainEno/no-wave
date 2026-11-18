import type { ServerResponse } from "node:http";
import { setImmediate as yieldToClients } from "node:timers/promises";
import { jsonValueChunks } from "./json-encoding.ts";
import { JsonCollectionBudget, takeJsonCollectionOutput, type JsonCollectionLimits } from "./json-collection-budget.ts";
import { JSON_HEADERS } from "./http.ts";
import { takeCollectionResponseObserver, type JsonCollectionSample } from "../../infrastructure/http-collection-observability.ts";

export type JsonCollectionOptions<T> = { view?: "full" | "card"; meta?: unknown; project?: (item: T, index: number) => unknown; budget?: JsonCollectionLimits };
/**
 * The response owns the writer until finish/close, including a slow consumer.
 * One write of at most 64 KiB may cross the native high-water mark; no next row
 * is projected/encoded until drain. Shutdown's existing forced socket close also
 * wakes that wait. This is HTTP output, not a background task or mutation retry.
 */
export async function sendJsonCollection<T>(response: ServerResponse, items: readonly T[], options: JsonCollectionOptions<T> = {}): Promise<void> {
  if (response.destroyed || response.writableEnded) return;
  const observe = takeCollectionResponseObserver(response);
  const startedAt = performance.now();
  const sample: JsonCollectionSample = { view: options.view ?? "full", outcome: "cancelled", items: 0, bytes: 0, chunks: 0,
    largestChunkBytes: 0, backpressureCount: 0, backpressureMs: 0, durationMs: 0 };
  let completed = false;
  let failed = false;
  let stopped = false;
  let failure: Error | undefined;
  let wake: (() => void) | undefined;
  const budget = new JsonCollectionBudget({ ...takeJsonCollectionOutput(response), ...options.budget }, error => {
    failure = error;
    stopped = true;
    wake?.();
    if (response.headersSent && !response.destroyed) response.destroy();
  });
  const onClose = () => { stopped = true; wake?.(); };
  const onError = (error: Error) => { failure = error; stopped = true; wake?.(); };
  response.on("close", onClose);
  response.on("error", onError);
  const project = options.project ?? ((item: T) => item);
  let encodedSinceYield = 0;
  let first: Generator<Buffer> | undefined;
  let metadata: Generator<Buffer> | undefined;

  async function write(bytes: Buffer, part: "item" | "envelope" = "envelope"): Promise<boolean> {
    budget.checkpoint();
    if (stopped || response.destroyed || response.writableEnded) return false;
    budget.charge(bytes.byteLength, part);
    let drained = false;
    const onDrain = () => { drained = true; wake?.(); };
    response.once("drain", onDrain);
    try {
      // Attach drain before writing: an injected/native writer may acknowledge
      // synchronously, and a lost event would otherwise pin an admitted request.
      const accepted = response.write(bytes);
      sample.bytes += bytes.byteLength;
      sample.chunks++;
      sample.largestChunkBytes = Math.max(sample.largestChunkBytes, bytes.byteLength);
      if (!accepted) {
        sample.backpressureCount++;
        const waitingAt = performance.now();
        try {
          if (!drained && !stopped) await new Promise<void>(resolve => {
            wake = resolve;
            if (drained || stopped || response.destroyed) resolve();
          });
        } finally { sample.backpressureMs += Math.max(0, performance.now() - waitingAt); }
      }
      encodedSinceYield += bytes.byteLength;
      if (encodedSinceYield >= 256 * 1024) {
        encodedSinceYield = 0;
        await yieldToClients();
      }
      budget.checkpoint();
      if (failure) throw failure;
      return !stopped && !response.destroyed;
    } finally {
      wake = undefined;
      response.off("drain", onDrain);
    }
  }

  async function value(chunks: Generator<Buffer>, head?: IteratorResult<Buffer>, part: "item" | "envelope" = "item"): Promise<boolean> {
    if (head && !head.done && !await write(head.value, part)) return false;
    for (const bytes of chunks) if (!await write(bytes, part)) return false;
    return true;
  }
  const text = (value: string) => write(Buffer.from(value, "utf8"));

  async function end(): Promise<void> {
    budget.checkpoint();
    if (stopped || response.destroyed) return;
    let finished = false;
    const onFinish = () => { finished = true; wake?.(); };
    response.once("finish", onFinish);
    try {
      response.end();
      if (!finished && !stopped) await new Promise<void>(resolve => {
        wake = resolve;
        if (finished || stopped || response.destroyed) resolve();
      });
      budget.checkpoint();
      if (failure) throw failure;
      completed = finished;
    } finally { wake = undefined; response.off("finish", onFinish); }
  }

  try {
    budget.validateCount(items.length);
    // Validate/encode only a bounded first chunk before committing headers.
    // Getters/toJSON/cycles later in a row can still fail: then close, never send
    // a syntactically complete success containing only the preceding items.
    first = items.length ? jsonValueChunks(project(items[0]!, 0), "0") : undefined;
    metadata = options.meta === undefined ? undefined : jsonValueChunks(options.meta, "meta");
    const firstChunk = first?.next();
    const metaChunk = metadata?.next();
    budget.checkpoint();
    if (stopped || response.destroyed) return;
    response.writeHead(200, JSON_HEADERS);
    if (!await text('{"data":[')) return;
    for (let index = 0; index < items.length; index++) {
      if (stopped || response.destroyed) return;
      if (index > 0 && !await text(",")) return;
      budget.beginItem();
      const chunks = index === 0 ? first! : jsonValueChunks(project(items[index]!, index), String(index));
      if (!await value(chunks, index === 0 ? firstChunk : undefined)) return;
      budget.endItem();
      sample.items++;
    }
    if (!await text("]")) return;
    if (metadata) {
      if (!await text(',"meta":') || !await value(metadata, metaChunk, "envelope")) return;
    }
    if (await text("}")) await end();
  } catch (error) {
    failed = true;
    // A partial JSON success is never completed with an error envelope. Closing
    // makes old JSON consumers and the Web's incremental validator reject it.
    if (response.headersSent && !response.destroyed) response.destroy();
    throw error;
  } finally {
    budget.dispose();
    first?.return(undefined);
    metadata?.return(undefined);
    response.off("close", onClose);
    response.off("error", onError);
    sample.outcome = completed ? "finished" : failed || failure ? "failed" : "cancelled";
    sample.durationMs = Math.max(0, performance.now() - startedAt);
    try { observe?.(sample); } catch { /* Metrics cannot invalidate or retry a completed write. */ }
  }
}
