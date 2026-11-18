import assert from "node:assert/strict";
import test from "node:test";
import { settledReads } from "./settled-reads.ts";

const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }

test("read batches start every sibling and retain input order despite opposite completion order", async () => {
  const gate = deferred<string>(), starts: number[] = [];
  const pending = settledReads([() => { starts.push(0); return gate.promise; }, () => { starts.push(1); return 17; }, () => undefined]);
  assert.deepEqual(starts, [0, 1]);
  let finished = false; void pending.then(() => { finished = true; });
  await tick(); assert.equal(finished, false);
  gate.resolve("first");
  assert.deepEqual(await pending, ["first", 17, undefined]);
});

test("a synchronous failure is observed without abandoning nested physical siblings or retrying any read", async () => {
  const gate = deferred<number>(), first = new Error("first observed"), later = new Error("later failure");
  const starts: string[] = [];
  const pending = settledReads([
    () => { starts.push("sync"); throw first; },
    () => settledReads([() => { starts.push("held"); return gate.promise; }, () => { starts.push("later"); throw later; }]),
  ]);
  let failed = false;
  const checked = assert.rejects(pending, error => { failed = true; return error === first; });
  await tick();
  assert.equal(failed, false, "the aggregate must not settle before the nested physical read");
  assert.deepEqual(starts, ["sync", "held", "later"]);
  gate.resolve(3); await checked;
  assert.deepEqual(starts, ["sync", "held", "later"], "there is no automatic retry");
});

test("even throw undefined remains a failure rather than a successful missing result", async () => {
  let succeeded = false;
  await settledReads([() => { throw undefined; }, () => undefined]).then(() => { succeeded = true; }, error => { assert.equal(error, undefined); });
  assert.equal(succeeded, false);
  assert.deepEqual(await settledReads([]), []);
});
