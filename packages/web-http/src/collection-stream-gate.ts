import { UpstreamTimeoutError, type DeadlineCheckpoint } from "./api.ts";
import { UpstreamByteBuffer } from "./upstream-byte-buffer.ts";
import { UpstreamCancelledError, UpstreamResponseError } from "./upstream-errors.ts";
import { AUTH_RESPONSE_MAX_BYTES, cancelUpstreamRead } from "./upstream-response.ts";

/**
 * A BFF does not commit success for headers alone or a stalled `{data:` prefix.
 * Validate the collection preamble first, retaining at most one envelope plus
 * one 64 KiB stream segment. Then replay that bounded prefix and forward solely
 * on demand. Late item/EOF failures remain stream failures, never a valid short
 * page; early connection/preamble failures can still become an HTTP 502/504.
 * Physical admission/cancellation is owned by the underlying UpstreamBodyStream.
 */
export class CollectionStreamGate {
  private reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  private output: ReadableStreamDefaultController<Uint8Array> | undefined;
  private readonly signal: AbortSignal;
  private readonly ready: () => boolean;
  private readonly checkpoint: DeadlineCheckpoint;
  private readonly storage: UpstreamByteBuffer;
  private prefix: Uint8Array | undefined;
  private offset = 0;
  private ended = false;
  private sourceEnded = false;
  private prepared = false;
  private readonly onAbort: () => void;

  constructor(source: ReadableStream<Uint8Array>, ready: () => boolean, signal: AbortSignal, checkpoint: DeadlineCheckpoint) {
    this.reader = source.getReader();
    this.ready = ready;
    this.signal = signal;
    this.checkpoint = checkpoint;
    this.storage = new UpstreamByteBuffer(AUTH_RESPONSE_MAX_BYTES + 64 * 1024, checkpoint);
    this.onAbort = () => this.fail(signal.reason instanceof UpstreamTimeoutError ? new UpstreamTimeoutError(signal.reason.timeoutMs) : new UpstreamCancelledError());
    signal.addEventListener("abort", this.onAbort, { once: true });
    if (signal.aborted) this.onAbort();
  }

  async prepare(): Promise<ReadableStream<Uint8Array>> {
    if (this.prepared) throw new Error("A collection stream may only be prepared once.");
    this.prepared = true;
    try {
      while (!this.ready() && !this.sourceEnded) {
        this.checkpoint();
        if (this.ended || !this.reader) throw new UpstreamCancelledError();
        const next = await this.reader.read();
        this.checkpoint();
        if (next.done) this.sourceEnded = true;
        else this.storage.append(next.value);
      }
      if (!this.ready()) throw new UpstreamResponseError("invalid-json");
      this.prefix = this.storage.take();
      return new ReadableStream<Uint8Array>({
        start: controller => { this.output = controller; if (this.ended) this.onAbort(); },
        pull: () => this.pull(),
        cancel: () => this.fail(new UpstreamCancelledError()),
      }, { highWaterMark: 0 });
    } catch (error) { this.fail(error); throw error; }
  }

  private async pull(): Promise<void> {
    if (this.ended || !this.reader) return;
    try {
      this.checkpoint();
      if (this.prefix && this.offset < this.prefix.byteLength) {
        const end = Math.min(this.prefix.byteLength, this.offset + 64 * 1024);
        this.output!.enqueue(this.prefix.subarray(this.offset, end));
        this.offset = end;
        if (end === this.prefix.byteLength) this.prefix = undefined;
        return;
      }
      if (!this.sourceEnded) {
        const next = await this.reader.read();
        if (this.ended) return;
        this.checkpoint();
        if (!next.done) { this.output!.enqueue(next.value); return; }
      }
      this.ended = true;
      this.output!.close();
      this.detach();
    } catch (error) { this.fail(error); }
  }

  private fail(error: unknown): void {
    if (this.ended) return;
    this.ended = true;
    cancelUpstreamRead(this.reader);
    this.output?.error(error);
    this.detach();
  }

  private detach(): void {
    this.signal.removeEventListener("abort", this.onAbort);
    this.storage.clear();
    this.prefix = undefined;
    try { this.reader?.releaseLock(); } catch { /* Its source already owns cancellation. */ }
    this.reader = undefined;
  }
}
