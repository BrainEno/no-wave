import type { Writable } from "node:stream";

/** Await backpressure without treating stdout as delivery acknowledgement. A
 * blocked pipe fails boundedly; the already committed queue survives for a
 * consumer to deduplicate and explicitly acknowledge on a later invocation. */
export function writeOperationOutput(
  stream: Writable,
  text: string,
): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    let settled = false;
    const finish = (failed: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!failed) stream.off("error", failedWrite);
      if (failed) reject(new Error("output_failed"));
      else resolvePromise();
    };
    const failedWrite = () => finish(true);
    const timer = setTimeout(() => {
      stream.destroy();
      finish(true);
    }, 2000);
    stream.once("error", failedWrite);
    try {
      stream.write(text, (error) => finish(Boolean(error)));
    } catch {
      finish(true);
    }
  });
}
