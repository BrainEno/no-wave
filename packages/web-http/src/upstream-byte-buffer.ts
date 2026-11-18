import type { DeadlineCheckpoint } from "./api.ts";
import { UpstreamResponseError } from "./upstream-errors.ts";

const SLAB_BYTES = 64 * 1024;

/**
 * Bounded copied storage, independent of the adapter's fragmentation. A stream
 * sending one byte at a time must not create millions of retained array objects;
 * Buffer.slice must not alias a backing store the adapter will overwrite.
 * Allocation is lazy, with at most ceil(limit / 64 KiB) owned slabs. Flattening
 * momentarily needs one additional exact-size result; no whole-page string is
 * allocated. This owns bytes only, not reader cancellation or admission leases.
 */
export class UpstreamByteBuffer {
  private slabs: Uint8Array<ArrayBuffer>[] = [];
  private used = 0;
  private allocated = 0;
  private peak = 0;
  private readonly limit: number;
  private readonly checkpoint: DeadlineCheckpoint;

  constructor(limit: number, checkpoint: DeadlineCheckpoint = () => {}) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError("Invalid upstream byte storage bound.");
    this.limit = limit;
    this.checkpoint = checkpoint;
  }

  get size(): number { return this.used; }
  get capacity(): number { return this.allocated; }
  get peakCapacity(): number { return this.peak; }

  append(input: Uint8Array, start = 0, end = input.byteLength): void {
    if (!(input instanceof Uint8Array) || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end > input.byteLength) throw new RangeError("Invalid upstream byte segment.");
    if (end - start > this.limit - this.used) throw new UpstreamResponseError("too-large");
    while (start < end) {
      this.checkpoint();
      const index = Math.floor(this.used / SLAB_BYTES);
      const offset = this.used % SLAB_BYTES;
      let slab = this.slabs[index];
      if (!slab) {
        slab = new Uint8Array(Math.min(SLAB_BYTES, this.limit - this.allocated));
        this.slabs.push(slab);
        this.allocated += slab.byteLength;
        this.peak = Math.max(this.peak, this.allocated);
      }
      const length = Math.min(end - start, slab.byteLength - offset);
      slab.set(input.subarray(start, start + length), offset);
      this.used += length;
      start += length;
      this.checkpoint();
    }
  }

  /** Transfer a compact copy and release every slab, including after failure. */
  take(): Uint8Array<ArrayBuffer> {
    try {
      this.checkpoint();
      const output = new Uint8Array(this.used);
      let copied = 0;
      for (const slab of this.slabs) {
        this.checkpoint();
        const length = Math.min(slab.byteLength, this.used - copied);
        output.set(slab.subarray(0, length), copied);
        copied += length;
      }
      this.checkpoint();
      return output;
    } finally { this.clear(); }
  }

  clear(): void {
    this.slabs = [];
    this.used = 0;
    this.allocated = 0;
  }
}
