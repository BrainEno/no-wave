import test from "node:test";
import assert from "node:assert/strict";
import { WritingOverlapWorkbench } from "./writing-overlap-controller.ts";
import { openWritingCollection } from "./writing-collection.ts";
import { analyzeWritingOverlap } from "./writing-overlap.ts";
import {
  explainWritingOverlap,
  type OverlapEvidence,
} from "./writing-overlap-evidence.ts";
import {
  overlapDeferred,
  overlapFixture,
  overlapPolicy,
  overlapStamp,
} from "../test-support/writing-overlap.ts";
import type {
  OverlapAnalysis,
  OverlapProgress,
} from "./writing-overlap-model.ts";
const paragraph =
  "PRIVATE_BODY the river remembers the quiet morning near the valley.";
const file = (text: string, name = "PRIVATE_FILE.json") =>
  new File([text], name, { type: "application/json" });
async function text() {
  return (await overlapFixture([[paragraph, paragraph], [paragraph]])).prepared
    .text;
}
const options = {
  read: async (input: File) => input.text(),
  pause: async () => {},
  now: () => overlapStamp,
};
async function ready() {
  const controller = new WritingOverlapWorkbench(options);
  await controller.load(file(await text()));
  await controller.analyze();
  assert.equal(controller.getSnapshot().status, "complete");
  return controller;
}

test("late native reads and progress cannot replace newer source metadata or its strict check", async () => {
  const pending = overlapDeferred<string>();
  let reads = 0,
    oldProgress!: (value: number) => void,
    oldSignal!: AbortSignal;
  const value = await text();
  const controller = new WritingOverlapWorkbench({
    ...options,
    read: async (_file, signal, progress) => {
      if (++reads === 1) {
        oldProgress = progress;
        oldSignal = signal;
        return pending.promise;
      }
      return value;
    },
  });
  const old = controller.load(file(value, "OLD_PRIVATE.json"));
  await controller.load(file(value, "NEW_PRIVATE.json"));
  const current = controller.getSnapshot();
  assert.equal(current.input.status, "ready");
  assert.equal(current.input.name, "NEW_PRIVATE.json");
  assert.equal(oldSignal.aborted, true);
  oldProgress(71);
  pending.resolve(value);
  await old;
  assert.equal(controller.getSnapshot(), current);
});

test("clearing during digest validation cannot resurrect filenames, titles, analysis or report controls", async () => {
  const gate =
      overlapDeferred<Awaited<ReturnType<typeof openWritingCollection>>>(),
    entered = overlapDeferred<void>();
  const value = await text();
  const controller = new WritingOverlapWorkbench({
    ...options,
    open: async () => {
      entered.resolve();
      return gate.promise;
    },
  });
  const run = controller.load(file(value));
  await entered.promise;
  controller.clear();
  const empty = controller.getSnapshot();
  gate.resolve(await openWritingCollection(value));
  await run;
  assert.equal(controller.getSnapshot(), empty);
  assert.doesNotMatch(JSON.stringify(empty), /PRIVATE|Private|river|\.json/);
  assert.equal(empty.input.status, "idle");
  assert.equal(empty.analysis, null);
});

test("invalid and oversize files discard prior results but never start I/O or silently retain an old apparent source", async () => {
  let reads = 0;
  const controller = new WritingOverlapWorkbench({
    ...options,
    read: async (input) => {
      reads++;
      return input.text();
    },
  });
  await controller.load(file(await text()));
  await controller.analyze();
  await controller.load(
    new File([new Uint8Array(16 * 1024 * 1024 + 1)], "large.json"),
  );
  assert.equal(reads, 1);
  assert.equal(controller.getSnapshot().input.status, "failed");
  assert.equal(controller.getSnapshot().analysis, null);
  await controller.load(file("{}"));
  assert.equal(controller.getSnapshot().input.status, "failed");
  assert.deepEqual(controller.getSnapshot().input.documents, []);
});

test("a late analyzer ignoring AbortSignal cannot restore results after cancel, changed policy, clear or an identical file reselection", async () => {
  const value = await text(),
    opened = await openWritingCollection(value);
  const result = await analyzeWritingOverlap(
    opened,
    overlapPolicy({ minimum: 24 }),
    new AbortController().signal,
    { pause: options.pause },
  );
  for (const change of ["cancel", "policy", "clear", "reselect"] as const) {
    const gate = overlapDeferred<OverlapAnalysis>();
    const controller = new WritingOverlapWorkbench({
      ...options,
      analyze: async () => gate.promise,
    });
    await controller.load(file(value));
    const run = controller.analyze();
    assert.equal(controller.getSnapshot().status, "running");
    if (change === "cancel") controller.cancel();
    if (change === "policy")
      controller.setPolicy(overlapPolicy({ mode: "folded" }));
    if (change === "clear") controller.clear();
    if (change === "reselect") await controller.load(file(value));
    const witness = controller.getSnapshot();
    gate.resolve(result);
    await run;
    assert.equal(controller.getSnapshot(), witness, change);
    assert.equal(controller.getSnapshot().analysis, null);
    assert.equal(controller.getSnapshot().report, null);
  }
});

test("progress callbacks are fenced, and a synchronous privacy clear during a publication prevents work from starting", async () => {
  const value = await text();
  let reads = 0;
  const controller = new WritingOverlapWorkbench({
    ...options,
    read: async () => {
      reads++;
      return value;
    },
  });
  const unsubscribe = controller.subscribe(() => {
    if (controller.getSnapshot().input.status === "reading") controller.clear();
  });
  await controller.load(file(value));
  unsubscribe();
  assert.equal(reads, 0);
  const gate = overlapDeferred<OverlapAnalysis>();
  let notify!: (value: OverlapProgress) => void;
  const guarded = new WritingOverlapWorkbench({
    ...options,
    analyze: async (_source, _policy, _signal, input) => {
      notify = input!.progress!;
      return gate.promise;
    },
  });
  await guarded.load(file(value));
  const run = guarded.analyze();
  guarded.clear();
  const empty = guarded.getSnapshot();
  notify({ stage: "compare", done: 10, total: 12 });
  gate.resolve(
    await analyzeWritingOverlap(
      await openWritingCollection(value),
      overlapPolicy(),
      new AbortController().signal,
      { pause: options.pause },
    ),
  );
  await run;
  assert.equal(guarded.getSnapshot(), empty);
});

test("mark batches and invalid conditions reject atomically while valid changes invalidate every old report and its confirmation", async () => {
  const controller = await ready(),
    analysis = controller.getSnapshot().analysis!,
    id = analysis.exact[0]!.id;
  controller.prepareReport(analysis);
  const report = controller.getSnapshot().report!;
  assert.ok(report);
  assert.equal(controller.permitsReport(report), false);
  assert.throws(() => controller.reportDownload(report));
  assert.equal(controller.confirmReport(report, true), true);
  assert.equal(controller.permitsReport(report), true);
  assert.equal(
    controller.setMarks(analysis, [
      { finding: id, verdict: "intentional" },
      { finding: "missing", verdict: "follow-up" },
    ]),
    false,
  );
  assert.deepEqual(controller.getSnapshot().marks, []);
  assert.equal(controller.getSnapshot().report, report);
  assert.equal(controller.setPolicy(overlapPolicy({ threshold: 0 })), false);
  assert.equal(controller.getSnapshot().report, report);
  assert.equal(controller.mark(analysis, id, "follow-up"), true);
  assert.equal(controller.getSnapshot().report, null);
  assert.equal(controller.permitsReport(report), false);
  assert.equal(controller.confirmReport(report, true), false);
  assert.throws(() => controller.reportDownload(report));
  controller.prepareReport(analysis);
  const current = controller.getSnapshot().report!;
  controller.confirmReport(current, true);
  assert.equal(
    JSON.parse(controller.reportDownload(current).text).findings[0].verdict,
    "follow-up",
  );
  controller.setPolicy(overlapPolicy({ mode: "folded" }));
  assert.equal(controller.getSnapshot().analysis, null);
  assert.deepEqual(controller.getSnapshot().marks, []);
  assert.equal(controller.mark(analysis, id, "intentional"), false);
});

test("stale pair navigation and old report witnesses remain invalid even when a new analysis is value-identical", async () => {
  const controller = await ready(),
    old = controller.getSnapshot().analysis!,
    id = old.exact[0]!.id;
  assert.equal(controller.pair(old, id, "d1:0", "d2:0").rawEqual, true);
  controller.prepareReport(old);
  const report = controller.getSnapshot().report!;
  controller.confirmReport(report, true);
  await controller.analyze();
  const current = controller.getSnapshot().analysis!;
  assert.notEqual(current, old);
  assert.throws(() => controller.pair(old, id, "d1:0", "d2:0"));
  assert.equal(controller.mark(old, id, "intentional"), false);
  assert.equal(controller.permitsReport(report), false);
  controller.prepareReport(current);
  const next = controller.getSnapshot().report!;
  assert.equal(controller.getSnapshot().reportConfirmed, false);
  controller.confirmReport(next, true);
  assert.equal(controller.permitsReport(next), true);
  controller.cancel();
  assert.equal(controller.permitsReport(next), false);
});

test("optional evidence is explicit, pair-scoped, read-only and cleared synchronously; old pair cancellation cannot clear another pair", async () => {
  const controller = await ready(),
    analysis = controller.getSnapshot().analysis!,
    id = analysis.exact[0]!.id;
  assert.equal(controller.getSnapshot().evidence, null);
  controller.mark(analysis, id, "intentional");
  controller.prepareReport(analysis);
  const report = controller.getSnapshot().report!;
  controller.confirmReport(report, true);
  await controller.explainPair(analysis, id, "d1:0", "d2:0");
  assert.equal(controller.getSnapshot().evidence!.status, "complete");
  assert.equal(controller.getSnapshot().evidence!.value!.basisPoints, 10000);
  assert.equal(
    controller.permitsReport(report),
    true,
    "diagnostics do not silently alter marks or exported findings",
  );
  await controller.explainPair(analysis, id, "d1:1", "d2:0");
  const next = controller.getSnapshot();
  controller.cancelEvidence(analysis, id, "d1:0", "d2:0");
  assert.equal(controller.getSnapshot(), next);
  controller.cancelEvidence(analysis, id, "d1:1", "d2:0");
  assert.equal(controller.getSnapshot().evidence, null);
  assert.equal(controller.permitsReport(report), true);
});

test("cancelled or superseded evidence jobs ignoring AbortSignal never restore body fragments, even after value-identical reanalysis", async () => {
  for (const change of [
    "cancel-evidence",
    "pair",
    "policy",
    "cancel",
    "clear",
    "reselect",
    "reanalyze",
  ] as const) {
    const gate = overlapDeferred<OverlapEvidence>();
    let received!: AbortSignal,
      calls = 0;
    const controller = new WritingOverlapWorkbench({
      ...options,
      explain: async (...args) => {
        if (++calls === 1) {
          received = args[4];
          return gate.promise;
        }
        return explainWritingOverlap(...args);
      },
    });
    const value = await text();
    await controller.load(file(value));
    await controller.analyze();
    const analysis = controller.getSnapshot().analysis!,
      id = analysis.exact[0]!.id;
    const result = await explainWritingOverlap(
      analysis,
      id,
      "d1:0",
      "d2:0",
      new AbortController().signal,
      options.pause,
    );
    const run = controller.explainPair(analysis, id, "d1:0", "d2:0");
    assert.equal(controller.getSnapshot().evidence!.status, "running");
    if (change === "cancel-evidence")
      controller.cancelEvidence(analysis, id, "d1:0", "d2:0");
    if (change === "pair")
      await controller.explainPair(analysis, id, "d1:1", "d2:0");
    if (change === "policy")
      controller.setPolicy(overlapPolicy({ mode: "folded" }));
    if (change === "cancel") controller.cancel();
    if (change === "clear") controller.clear();
    if (change === "reselect") await controller.load(file(value));
    if (change === "reanalyze") await controller.analyze();
    assert.equal(received.aborted, true, change);
    const current = controller.getSnapshot();
    gate.resolve(result);
    await run;
    assert.equal(controller.getSnapshot(), current, change);
    if (change !== "pair") assert.equal(current.evidence, null, change);
    if (change === "clear")
      assert.doesNotMatch(
        JSON.stringify(current),
        /PRIVATE|Private|river|\.json/,
      );
  }
});

test("evidence cannot start after a synchronous privacy clear, and stale/out-of-scope or mismatched results are not accepted", async () => {
  let calls = 0;
  const controller = new WritingOverlapWorkbench({
    ...options,
    explain: async (...args) => {
      calls++;
      return explainWritingOverlap(...args);
    },
  });
  await controller.load(file(await text()));
  await controller.analyze();
  const analysis = controller.getSnapshot().analysis!,
    id = analysis.exact[0]!.id;
  await controller.explainPair(analysis, id, "d1:0", "d1:1");
  assert.equal(calls, 0, "scope validation precedes all fragment scanning");
  const unsubscribe = controller.subscribe(() => {
    if (controller.getSnapshot().evidence?.status === "running")
      controller.clear();
  });
  await controller.explainPair(analysis, id, "d1:0", "d2:0");
  unsubscribe();
  assert.equal(calls, 0);
  assert.equal(controller.getSnapshot().evidence, null);
  await controller.load(file(await text()));
  await controller.analyze();
  await controller.explainPair(analysis, id, "d1:0", "d2:0");
  assert.equal(
    calls,
    0,
    "an identical new source cannot renew an old analysis witness",
  );

  const guarded = new WritingOverlapWorkbench({
    ...options,
    explain: async (...args) => ({
      ...(await explainWritingOverlap(...args)),
      leftId: "d1:99",
    }),
  });
  await guarded.load(file(await text()));
  await guarded.analyze();
  const current = guarded.getSnapshot().analysis!;
  await guarded.explainPair(current, id, "d1:0", "d2:0");
  assert.equal(guarded.getSnapshot().evidence!.status, "failed");
  assert.equal(guarded.getSnapshot().evidence!.value, null);
  assert.match(guarded.getSnapshot().evidence!.error, /不符/);
});
