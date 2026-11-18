import { UpstreamTimeoutError, type DeadlineCheckpoint } from "./api.ts";
import { UpstreamCancelledError, UpstreamResponseError } from "./upstream-errors.ts";
import { cancelUpstreamBody, cancelUpstreamRead, declaredDecodedLength } from "./upstream-response.ts";
import type { CancellationObserver } from "./upstream-release.ts";
import { StreamingJsonValidator } from "./streaming-json.ts";

export type UpstreamStreamValidator = { write(bytes: Uint8Array): void; finish(): void; abort?(error: Error): void };

/** A demand-driven download. Its completion, not its headers, releases capacity. */
export class UpstreamBodyStream {
  readonly body: ReadableStream<Uint8Array>;
  readonly finished: Promise<number>;
  private reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  private output!: ReadableStreamDefaultController<Uint8Array>;
  private ended = false;
  private delivered = 0;
  private pending: Uint8Array | undefined;
  private pendingOffset = 0;
  private resolveFinished!: (bytes: number) => void;
  private rejectFinished!: (error: Error) => void;
  private readonly signal: AbortSignal;
  private readonly maxBytes: number;
  private readonly onAbort: () => void;
  private readonly track?: CancellationObserver;
  private readonly validator: UpstreamStreamValidator | undefined;
  private readonly checkpoint: DeadlineCheckpoint;

  constructor(response: Response, maxBytes: number, signal: AbortSignal, validateJson: boolean | UpstreamStreamValidator = false, track?: CancellationObserver, checkpoint: DeadlineCheckpoint = () => {}) {
    const declared = declaredDecodedLength(response);
    if (declared !== null && declared > maxBytes) {
      cancelUpstreamBody(response, track);
      throw new UpstreamResponseError("too-large");
    }
    if (validateJson && !response.body) throw new UpstreamResponseError("invalid-json");
    this.signal = signal;
    this.checkpoint = checkpoint;
    this.track = track;
    this.maxBytes = maxBytes;
    this.validator = typeof validateJson === "object" ? validateJson : validateJson ? new StreamingJsonValidator() : undefined;
    try { this.reader = response.body?.getReader(); }
    catch {
      cancelUpstreamBody(response, track);
      throw new UpstreamResponseError("unreadable");
    }
    this.finished = new Promise<number>((resolve, reject) => { this.resolveFinished = resolve; this.rejectFinished = reject; });
    this.onAbort = () => this.fail(signal.reason instanceof UpstreamTimeoutError
      ? new UpstreamTimeoutError(signal.reason.timeoutMs) : new UpstreamCancelledError());
    this.body = new ReadableStream<Uint8Array>({
      start: controller => { this.output = controller; },
      pull: () => this.pull(),
      cancel: () => this.fail(new UpstreamCancelledError()),
    }, { highWaterMark: 0 });
    signal.addEventListener("abort", this.onAbort, { once: true });
    if (signal.aborted) this.onAbort();
    else if (!this.reader) this.complete();
  }

  private async pull(): Promise<void> {
    if (this.ended || !this.reader) return;
    try {
      // A custom adapter may return a giant buffer. Own at most that one source
      // chunk, and only validate/copy the next bounded segment on downstream
      // demand. Never fetch a second chunk while any of the first is pending.
      while (!this.pending) {
        this.checkpoint();
        const next = await this.reader.read();
        if (this.ended) return;
        this.checkpoint();
        if (this.signal.aborted) { this.onAbort(); return; }
        if (next.done) { this.validator?.finish(); this.complete(); return; }
        if (!(next.value instanceof Uint8Array)) throw new UpstreamResponseError("unreadable");
        if (next.value.byteLength > this.maxBytes - this.delivered) throw new UpstreamResponseError("too-large");
        if (next.value.byteLength === 0) continue;
        this.pending = next.value;
        this.pendingOffset = 0;
      }
      this.checkpoint();
      const end = Math.min(this.pending.byteLength, this.pendingOffset + 64 * 1024);
      const segment = this.pending.subarray(this.pendingOffset, end);
      this.validator?.write(segment);
      this.checkpoint();
      const copied = new Uint8Array(segment.byteLength);
      copied.set(segment);
      this.delivered += segment.byteLength;
      this.pendingOffset = end;
      if (end === this.pending.byteLength) { this.pending = undefined; this.pendingOffset = 0; }
      this.output.enqueue(copied);
    } catch (error) {
      this.fail(error instanceof UpstreamResponseError || error instanceof UpstreamTimeoutError || error instanceof UpstreamCancelledError ? error : new UpstreamResponseError("unreadable"));
    }
  }

  private detach(): void {
    this.signal.removeEventListener("abort", this.onAbort);
    try { this.reader?.releaseLock(); } catch { /* A malicious stream cannot block the public deadline. */ }
    this.reader = undefined;
    this.pending = undefined;
    this.pendingOffset = 0;
  }

  private complete(): void {
    if (this.ended) return;
    this.ended = true;
    this.output.close();
    this.detach();
    this.resolveFinished(this.delivered);
  }

  private fail(error: Error): void {
    if (this.ended) return;
    this.ended = true;
    try { this.validator?.abort?.(error); } catch { /* Cleanup cannot mask the stream failure or bypass physical cancellation. */ }
    // A custom source's cancel may never settle. Neither admission nor process
    // shutdown should wait unboundedly; its physical lease still tracks the receipt.
    cancelUpstreamRead(this.reader, this.track);
    this.output.error(error);
    this.detach();
    this.rejectFinished(error);
  }

  bytes(): number { return this.delivered; }
}
