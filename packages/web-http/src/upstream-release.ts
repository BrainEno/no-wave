export type CancellationObserver = (receipt: Promise<void>) => void;

/**
 * Public completion is not proof that cancellation finished at the source.
 * Keep the physical admission/probe lease while cancel() is unresolved, but
 * never await it on a browser's deadline/error/cancel path. A bounded drain can
 * then truthfully return false instead of opening unlimited replacement work.
 */
export class UpstreamRelease {
  private pending = 0;
  private finished = false;
  private released = false;
  private cancellationRejected = false;
  private readonly returnCapacity: (cancellationRejected: boolean) => void;
  private readonly cancellationStarted: () => void;

  constructor(returnCapacity: (cancellationRejected: boolean) => void, cancellationStarted: () => void) {
    this.returnCapacity = returnCapacity;
    this.cancellationStarted = cancellationStarted;
  }

  readonly track: CancellationObserver = receipt => {
    if (this.released) return;
    this.pending++;
    this.cancellationStarted();
    const settled = () => {
      this.pending--;
      this.releaseIfReady();
    };
    // Both branches settle ownership; no exception text enters public state.
    void receipt.then(settled, () => {
      this.cancellationRejected = true;
      settled();
    });
  };

  finish(): void {
    this.finished = true;
    this.releaseIfReady();
  }

  private releaseIfReady(): void {
    if (this.released || !this.finished || this.pending !== 0) return;
    this.released = true;
    this.returnCapacity(this.cancellationRejected);
  }
}
