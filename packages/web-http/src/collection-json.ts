import type { DeadlineCheckpoint } from "./api.ts";
import { UpstreamResponseError } from "./upstream-errors.ts";
import { API_RESPONSE_MAX_BYTES, AUTH_RESPONSE_MAX_BYTES } from "./upstream-response.ts";
import { StreamingJsonValidator } from "./streaming-json.ts";
import { UpstreamByteBuffer } from "./upstream-byte-buffer.ts";

export type CollectionLimits = { maxItems?: number; itemBytes?: number; envelopeBytes?: number };
export type CollectionDecoderOptions<T> = CollectionLimits & { project?: (item: unknown, index: number) => T; retainItems?: boolean; requireDataArray?: boolean; checkpoint?: DeadlineCheckpoint };
type State = "root" | "key-or-end" | "key" | "colon" | "value" | "item-or-end" | "item" | "item-separator" | "member-separator" | "done";
type CaptureKind = "key" | "member" | "item";
type Capture = { kind: CaptureKind; storage?: UpstreamByteBuffer; bytes: number; depth: number; string: boolean; escaped: boolean; primitive: boolean };
const invalid = () => new UpstreamResponseError("invalid-json");
const large = () => new UpstreamResponseError("too-large");
const whitespace = (byte: number) => byte === 32 || byte === 9 || byte === 10 || byte === 13;
const delimiter = (byte: number) => whitespace(byte) || byte === 44 || byte === 93 || byte === 125;

/**
 * Frame a REST envelope without ever buffering the whole collection. Syntax and
 * fatal UTF-8 remain owned by StreamingJsonValidator; this layer only identifies
 * top-level members and array item boundaries. At most one item (8 MiB), a small
 * envelope, and the caller's projected results are retained. A forwarding-only
 * decoder retains no item bytes at all. No partial result is readable before EOF.
 */
export class CollectionJsonDecoder<T = unknown> {
  readonly maxBytes: number;
  private readonly syntax = new StreamingJsonValidator();
  private readonly maxItems: number;
  private readonly itemBytes: number;
  private readonly envelopeBytes: number;
  private readonly project: (item: unknown, index: number) => T;
  private readonly retain: boolean;
  private readonly checkpoint: DeadlineCheckpoint;
  private readonly members: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  private readonly keys = new Set<string>();
  private readonly items: T[] = [];
  private state: State = "root";
  private capture: Capture | undefined;
  private key = "";
  private count = 0;
  private overhead = 0;
  private bom = 0;
  private first = true;
  private complete = false;
  private dataArray = false;
  private readonly requireArray: boolean;
  private failed = false;
  private failure: unknown;
  private largestItem = 0;
  private capturePeak = 0;

  constructor(options: CollectionDecoderOptions<T> = {}) {
    this.maxItems = options.maxItems ?? 100;
    this.itemBytes = options.itemBytes ?? API_RESPONSE_MAX_BYTES;
    this.envelopeBytes = options.envelopeBytes ?? AUTH_RESPONSE_MAX_BYTES;
    if (!Number.isSafeInteger(this.maxItems) || this.maxItems < 1 || this.maxItems > 300 ||
        !Number.isSafeInteger(this.itemBytes) || this.itemBytes < 1 || this.itemBytes > API_RESPONSE_MAX_BYTES ||
        !Number.isSafeInteger(this.envelopeBytes) || this.envelopeBytes < 1 || this.envelopeBytes > AUTH_RESPONSE_MAX_BYTES) {
      throw new RangeError("Invalid upstream collection limits.");
    }
    this.maxBytes = this.maxItems * this.itemBytes + this.envelopeBytes;
    this.retain = options.retainItems !== false;
    this.requireArray = options.requireDataArray === true;
    this.project = options.project ?? ((value: unknown) => value as T);
    this.checkpoint = options.checkpoint ?? (() => {});
  }

  write(bytes: Uint8Array): void {
    if (this.failed) throw this.failure;
    if (this.complete) throw invalid();
    try {
      // Bound CPU checkpoints even if the adapter delivers one giant chunk.
      for (let offset = 0; offset < bytes.byteLength; offset += 64 * 1024) {
        this.checkpoint();
        const part = bytes.subarray(offset, offset + 64 * 1024);
        this.syntax.write(part);
        this.consume(part);
        this.checkpoint();
      }
    } catch (error) { this.poison(error); throw error; }
  }

  finish(): void {
    if (this.failed) throw this.failure;
    if (this.complete) return;
    try {
      this.syntax.finish();
      if (this.capture || this.state !== "done" || this.bom !== 0 || this.requireArray && !this.dataArray) throw invalid();
      this.checkpoint();
      this.complete = true;
    } catch (error) { this.poison(error); throw error; }
  }

  /** Drop captured slabs and projected rows when a retained response is abandoned. */
  abort(error: Error): void {
    if (this.complete || this.failed) return;
    this.poison(error);
  }

  private poison(error: unknown): void {
    this.failed = true;
    this.failure = error;
    this.capture?.storage?.clear();
    this.capture = undefined;
    this.items.length = 0;
    for (const key of Object.keys(this.members)) delete this.members[key];
    this.keys.clear();
  }

  hasDataArray(): boolean { return this.dataArray && !this.failed; }

  /** Byte-storage peak excludes projected results, which belong to the caller. */
  snapshot() {
    return { items: this.count, largestItemBytes: this.largestItem, envelopeBytes: this.overhead,
      peakCapturedBytes: this.capturePeak, complete: this.complete };
  }

  payload(): Record<string, unknown> {
    if (!this.complete) throw new Error("An incomplete collection has no payload.");
    return this.members;
  }

  private account(bytes: number): void {
    this.overhead += bytes;
    if (this.overhead > this.envelopeBytes) throw large();
  }

  private begin(kind: CaptureKind, byte: number): void {
    if (kind === "item" && this.count >= this.maxItems) throw large();
    this.capture = { kind, ...(kind !== "item" || this.retain ? { storage: new UpstreamByteBuffer(kind === "item" ? this.itemBytes : this.envelopeBytes, this.checkpoint) } : {}), bytes: 0, depth: byte === 123 || byte === 91 ? 1 : 0,
      string: byte === 34, escaped: false, primitive: byte !== 123 && byte !== 91 && byte !== 34 };
  }

  private append(bytes: Uint8Array, start: number, end: number): void {
    const capture = this.capture!;
    const length = end - start;
    capture.bytes += length;
    if (capture.kind === "item") {
      if (capture.bytes > this.itemBytes) throw large();
      this.largestItem = Math.max(this.largestItem, capture.bytes);
    } else this.account(length);
    capture.storage?.append(bytes, start, end);
    this.capturePeak = Math.max(this.capturePeak, capture.storage?.capacity ?? 0);
  }

  private endCapture(): void {
    const capture = this.capture!;
    let value: unknown;
    if (capture.kind !== "item" || this.retain) {
      const joined = capture.storage!.take();
      try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(joined)) as unknown; }
      catch { throw invalid(); }
    }
    this.capture = undefined;
    if (capture.kind === "key") {
      if (typeof value !== "string" || this.keys.has(value)) throw invalid();
      this.keys.add(value);
      this.key = value;
      this.state = "colon";
    } else if (capture.kind === "member") {
      this.members[this.key] = value;
      this.state = "member-separator";
    } else {
      if (this.retain) this.items.push(this.project(value, this.count));
      this.count++;
      this.state = "item-separator";
    }
    this.checkpoint();
  }

  /** A primitive ends *before* its delimiter; a string/container includes its end. */
  private captureByte(byte: number): "continue" | "after" | "before" {
    const capture = this.capture!;
    if (capture.string) {
      if (capture.escaped) capture.escaped = false;
      else if (byte === 92) capture.escaped = true;
      else if (byte === 34) {
        capture.string = false;
        if (capture.depth === 0) return "after";
      }
    } else if (capture.primitive) {
      if (delimiter(byte)) return "before";
    } else if (byte === 34) capture.string = true;
    else if (byte === 123 || byte === 91) capture.depth++;
    else if (byte === 125 || byte === 93) {
      capture.depth--;
      if (capture.depth === 0) return "after";
    }
    return "continue";
  }

  private consume(bytes: Uint8Array): void {
    let segment = 0;
    for (let index = 0; index < bytes.byteLength; index++) {
      const byte = bytes[index]!;
      if (this.capture) {
        const boundary = this.captureByte(byte);
        if (boundary === "continue") continue;
        this.append(bytes, segment, boundary === "after" ? index + 1 : index);
        this.endCapture();
        if (boundary === "after") continue;
      }
      // TextDecoder strips one initial UTF-8 BOM; match that existing contract,
      // including when those three bytes arrive in different chunks.
      if (this.first && byte === 239) { this.first = false; this.bom = 1; this.account(1); continue; }
      if (this.bom) {
        if (byte !== (this.bom === 1 ? 187 : 191)) throw invalid();
        this.bom = this.bom === 1 ? 2 : 0;
        this.account(1); continue;
      }
      this.first = false;
      if (whitespace(byte)) { this.account(1); continue; }
      switch (this.state) {
        case "root":
          if (byte !== 123) throw invalid();
          this.state = "key-or-end"; break;
        case "key-or-end":
          if (byte === 125) { this.state = "done"; break; }
          // Both key states require a quoted member name.
          if (byte !== 34) throw invalid();
          this.begin("key", byte); segment = index; continue;
        case "key":
          if (byte !== 34) throw invalid();
          this.begin("key", byte); segment = index; continue;
        case "colon":
          if (byte !== 58) throw invalid();
          this.state = "value"; break;
        case "value":
          if (this.key === "data" && byte === 91) {
            this.dataArray = true;
            this.members.data = this.items;
            this.state = "item-or-end"; break;
          }
          this.begin("member", byte); segment = index; continue;
        case "item-or-end":
          if (byte === 93) { this.state = "member-separator"; break; }
          this.begin("item", byte); segment = index; continue;
        case "item":
          this.begin("item", byte); segment = index; continue;
        case "item-separator":
          if (byte === 44) this.state = "item";
          else if (byte === 93) this.state = "member-separator";
          else throw invalid();
          break;
        case "member-separator":
          if (byte === 44) this.state = "key";
          else if (byte === 125) this.state = "done";
          else throw invalid();
          break;
        case "done": throw invalid();
      }
      this.account(1);
    }
    if (this.capture) this.append(bytes, segment, bytes.byteLength);
  }
}
