type ReadBatch = readonly (() => unknown)[];
type ReadResults<T extends ReadBatch> = { -readonly [K in keyof T]: Awaited<ReturnType<T[K]>> };

/**
 * Promise.all rejects before its siblings settle. A collection handler owns all
 * of those physical reads, so its capacity lease cannot end on the first error.
 * Start every read under a rejection observer (including synchronous throws),
 * wait for all of them, then throw the first observed failure without retrying.
 * The HTTP read deadline, not early lease release, bounds the caller's wait.
 */
export async function settledReads<const T extends ReadBatch>(reads: T): Promise<ReadResults<T>> {
  let failure: { error: unknown } | undefined;
  const results = await Promise.all(reads.map(async read => {
    try { return await read(); }
    catch (error) { failure ??= { error }; return undefined; }
  }));
  if (failure) throw failure.error;
  // Every slot is fulfilled in input order, or its original failure was thrown.
  return results as ReadResults<T>;
}
