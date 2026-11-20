import test from "node:test";
import assert from "node:assert/strict";
import {
  WritingTermsWorkbench,
  type TermsWorkbenchOptions,
} from "./writing-terms-controller.ts";
import { analyzeWritingTerms } from "./writing-terms.ts";
import {
  DEFAULT_TERMS_POLICY,
  type TermsAnalysis,
  type TermsOptions,
} from "./writing-terms-model.ts";
import { parseTermsRecipe } from "./writing-terms-recipe.ts";
import { openWritingCollection } from "./writing-collection.ts";
import { DEFAULT_TERMS_FILTER, termsRows } from "./writing-terms-review.ts";
import {
  CollectionDownloadLease,
  bindCollectionPrivacy,
} from "./writing-collection-browser.ts";
import {
  overlapDeferred as deferred,
  overlapFixture as fixture,
  overlapStamp,
} from "../test-support/writing-overlap.ts";
const rules = JSON.stringify({
  format: "no-wave-writing-terms",
  version: 1,
  rules: [
    {
      preferred: "PRIVATE_TERM",
      alternatives: ["PRIVATE_ALIAS"],
      boundary: "substring",
    },
  ],
});
const file = (text: string, name = "PRIVATE_FILE.json") =>
  new File([text], name, { type: "application/json" });
const options: TermsWorkbenchOptions = {
  read: async (input) => input.text(),
  readRecipe: async (input) => input.text(),
  pause: async () => {},
  now: () => overlapStamp,
};
const sourceText = async () =>
  (await fixture([["PRIVATE_TERM PRIVATE_ALIAS PRIVATE_TERM"]])).prepared.text;
async function ready() {
  const controller = new WritingTermsWorkbench(options);
  controller.setRecipeText(rules);
  await controller.load(file(await sourceText()));
  await controller.analyze();
  assert.equal(controller.getSnapshot().status, "complete");
  return controller;
}

test("source and glossary imports have independent cancellation fences; late progress or reads cannot resurrect a replaced file or overwrite manually edited rules", async () => {
  const sourceGate = deferred<string>(),
    recipeGate = deferred<string>(),
    text = await sourceText();
  let sourceProgress!: (value: number) => void,
    recipeProgress!: (value: number) => void,
    sourceSignal!: AbortSignal,
    recipeSignal!: AbortSignal,
    reads = 0;
  const controller = new WritingTermsWorkbench({
    ...options,
    read: async (_file, signal, progress) => {
      if (++reads === 1) {
        sourceProgress = progress;
        sourceSignal = signal;
        return sourceGate.promise;
      }
      return text;
    },
    readRecipe: async (_file, signal, progress) => {
      recipeProgress = progress;
      recipeSignal = signal;
      return recipeGate.promise;
    },
  });
  const oldSource = controller.load(file(text, "OLD.json")),
    oldRecipe = controller.loadRecipe(file(rules, "OLD_RULES.json"));
  await controller.load(file(text, "NEW.json"));
  assert.equal(
    controller.getSnapshot().recipe.status,
    "reading",
    "source reselection does not discard a separately pending explicit recipe import",
  );
  controller.setRecipeText(rules);
  assert.equal(sourceSignal.aborted, true);
  assert.equal(recipeSignal.aborted, true);
  const current = controller.getSnapshot();
  sourceProgress(90);
  recipeProgress(90);
  sourceGate.resolve(text);
  recipeGate.resolve(rules.replace("PRIVATE_TERM", "OLD_TERM"));
  await Promise.all([oldSource, oldRecipe]);
  assert.equal(controller.getSnapshot(), current);
  assert.equal(current.input.name, "NEW.json");
  assert.equal(current.recipe.name, "");
  assert.equal(current.recipe.text, rules);
});

test("every source/policy/glossary edit, including incomplete JSON, immediately revokes analysis, marks, prepared reports and confirmations before async work finishes", async () => {
  for (const change of [
    "recipe",
    "invalid-recipe",
    "policy",
    "source",
    "recipe-file",
    "cancel",
    "clear",
  ] as const) {
    const controller = await ready(),
      analysis = controller.getSnapshot().analysis!;
    controller.mark(analysis, "m1", "follow-up");
    controller.prepareReport(analysis);
    const report = controller.getSnapshot().report!;
    assert.equal(controller.confirmReport(report, true), true);
    assert.equal(controller.permitsReport(report), true);
    let pending: Promise<void> | undefined;
    if (change === "recipe")
      controller.setRecipeText(rules.replace("PRIVATE_ALIAS", "NEW_ALIAS"));
    if (change === "invalid-recipe") controller.setRecipeText("{");
    if (change === "policy")
      controller.setPolicy({ ...DEFAULT_TERMS_POLICY, mode: "ascii-fold" });
    if (change === "source")
      pending = controller.load(file(await sourceText()));
    if (change === "recipe-file") pending = controller.loadRecipe(file(rules));
    if (change === "cancel") controller.cancel();
    if (change === "clear") controller.clear();
    assert.equal(controller.getSnapshot().analysis, null, change);
    assert.deepEqual(controller.getSnapshot().marks, [], change);
    assert.equal(controller.permitsReport(report), false, change);
    assert.throws(() => controller.reportDownload(report));
    assert.equal(controller.mark(analysis, "m1", "intentional"), false);
    assert.equal(controller.confirmReport(report, true), false);
    await pending;
  }
});

test("analyzers ignoring AbortSignal and queued progress cannot restore cancelled, cleared, reselected or changed-recipe results", async () => {
  const text = await sourceText(),
    opened = await openWritingCollection(text),
    result = await analyzeWritingTerms(
      opened,
      parseTermsRecipe(rules),
      DEFAULT_TERMS_POLICY,
      new AbortController().signal,
      { pause: options.pause },
    );
  for (const change of [
    "cancel",
    "clear",
    "policy",
    "recipe",
    "reselect",
  ] as const) {
    const gate = deferred<TermsAnalysis>();
    let progress!: NonNullable<TermsOptions["progress"]>;
    const controller = new WritingTermsWorkbench({
      ...options,
      analyze: async (_source, _recipe, _policy, _signal, input) => {
        progress = input!.progress!;
        return gate.promise;
      },
    });
    controller.setRecipeText(rules);
    await controller.load(file(text));
    const run = controller.analyze();
    if (change === "cancel") controller.cancel();
    if (change === "clear") controller.clear();
    if (change === "policy")
      controller.setPolicy({ ...DEFAULT_TERMS_POLICY, scope: "paragraphs" });
    if (change === "recipe")
      controller.setRecipeText(rules.replace("PRIVATE_ALIAS", "NEXT"));
    if (change === "reselect") await controller.load(file(text));
    const current = controller.getSnapshot();
    progress("scan", 1, 1);
    gate.resolve(result);
    await run;
    assert.equal(controller.getSnapshot(), current, change);
  }
});

test("oversize glossary and source files are refused before I/O; invalid UTF-8/schema or interrupted imports never leave an apparently current old glossary", async () => {
  let reads = 0;
  const controller = new WritingTermsWorkbench({
    ...options,
    read: async (input) => {
      reads++;
      return input.text();
    },
    readRecipe: async (input) => {
      reads++;
      return input.text();
    },
  });
  controller.setRecipeText(rules);
  await controller.load(file(await sourceText()));
  await controller.loadRecipe(
    new File([new Uint8Array(128 * 1024 + 1)], "big.json"),
  );
  assert.equal(reads, 1);
  assert.equal(controller.getSnapshot().recipe.status, "invalid");
  assert.equal(controller.getSnapshot().recipe.text, "");
  await controller.analyze();
  assert.equal(controller.getSnapshot().analysis, null);
  await controller.load(
    new File([new Uint8Array(16 * 1024 * 1024 + 1)], "big.json"),
  );
  assert.equal(reads, 1);
  assert.equal(controller.getSnapshot().input.status, "failed");
  assert.equal(controller.setRecipeText(rules + " ".repeat(128 * 1024)), false);
  assert.equal(controller.getSnapshot().recipe.text, "");
  await controller.loadRecipe(file("{}"));
  assert.equal(controller.getSnapshot().recipe.status, "invalid");
  const reading = deferred<string>(),
    waiting = new WritingTermsWorkbench({
      ...options,
      readRecipe: () => reading.promise,
    });
  const run = waiting.loadRecipe(file(rules));
  waiting.cancel();
  const empty = waiting.getSnapshot();
  reading.resolve(rules);
  await run;
  assert.equal(waiting.getSnapshot(), empty);
  assert.equal(empty.recipe.status, "idle");
});

test("report authority binds the exact frozen analysis, full canonical marks and manual confirmation; views and no-op marks do not revoke valid consent", async () => {
  const controller = await ready(),
    analysis = controller.getSnapshot().analysis!,
    rows = termsRows(analysis, [], DEFAULT_TERMS_FILTER);
  controller.prepareReport(analysis);
  const report = controller.getSnapshot().report!;
  assert.equal(controller.permitsReport(report), false);
  assert.throws(() => controller.reportDownload(report));
  controller.confirmReport(report, true);
  assert.equal(
    controller.setMarks(analysis, [
      { match: "m1", verdict: "intentional" },
      { match: "missing", verdict: "follow-up" },
    ]),
    false,
  );
  assert.equal(controller.getSnapshot().report, report);
  assert.equal(controller.permitsReport(report), true);
  termsRows(analysis, [], { ...DEFAULT_TERMS_FILTER, kind: "alternative" });
  controller.setMarks(analysis, []);
  assert.equal(controller.permitsReport(report), true);
  assert.equal(controller.row(rows[0]!), rows[0]);
  controller.mark(analysis, "m1", "intentional");
  assert.equal(controller.permitsReport(report), false);
  controller.prepareReport(analysis);
  const next = controller.getSnapshot().report!;
  controller.confirmReport(next, true);
  let created = 0,
    delivered = 0,
    revoked = 0;
  const lease = new CollectionDownloadLease({
    create: () => {
      created++;
      controller.setRecipeText("{");
      return "blob:terms";
    },
    revoke: () => {
      revoked++;
    },
    deliver: () => {
      delivered++;
    },
    later: () => setTimeout(() => {}, 0),
    cancel: clearTimeout,
  });
  assert.throws(() =>
    lease.download(next.artifact, () => controller.permitsReport(next)),
  );
  assert.equal(created, 1);
  assert.equal(revoked, 1);
  assert.equal(delivered, 0);
  assert.throws(() => controller.row(rows[0]!));
});

test("immutable snapshots, synchronous privacy fences during publish and pagehide/persisted-pageshow clear plaintext without starting deferred work", async () => {
  let reads = 0;
  const controller = new WritingTermsWorkbench({
    ...options,
    read: async () => {
      reads++;
      return sourceText();
    },
  });
  const release = controller.subscribe(() => {
    if (controller.getSnapshot().input.status === "reading") controller.clear();
  });
  await controller.load(file(await sourceText()));
  release();
  assert.equal(reads, 0);
  const live = await ready(),
    snapshot = live.getSnapshot();
  assert.throws(() => {
    snapshot.recipe.text = "forged";
  }, TypeError);
  assert.throws(
    () =>
      snapshot.input.documents.push({ key: "d9", title: "x", locale: "zh" }),
    TypeError,
  );
  const target = new EventTarget(),
    unbind = bindCollectionPrivacy(
      target,
      () => live.clear(),
      (work) => work(),
    );
  target.dispatchEvent(new Event("pagehide"));
  assert.doesNotMatch(
    JSON.stringify(live.getSnapshot()),
    /PRIVATE|Private|\.json/,
  );
  live.setRecipeText(rules);
  const show = new Event("pageshow");
  Object.defineProperty(show, "persisted", { value: true });
  target.dispatchEvent(show);
  assert.equal(live.getSnapshot().recipe.text, "");
  unbind();
});

test("mismatched or mutable analyzer output fails closed and a result published after a privacy clear during progress has no authority", async () => {
  const text = await sourceText(),
    opened = await openWritingCollection(text),
    result = await analyzeWritingTerms(
      opened,
      parseTermsRecipe(rules),
      DEFAULT_TERMS_POLICY,
      new AbortController().signal,
      { pause: options.pause },
    );
  for (const value of [
    { ...result, recipeKey: "0".repeat(64) },
    { ...result, sourceKey: "0".repeat(64) },
    structuredClone(result),
  ]) {
    const controller = new WritingTermsWorkbench({
      ...options,
      analyze: async () => value,
    });
    controller.setRecipeText(rules);
    await controller.load(file(text));
    await controller.analyze();
    assert.equal(controller.getSnapshot().status, "failed");
    assert.equal(controller.getSnapshot().analysis, null);
  }
});

test("a clear during asynchronous source digest validation cannot resurrect titles or overwrite a fresh glossary", async () => {
  const text = await sourceText(),
    opened = await openWritingCollection(text),
    gate = deferred<typeof opened>(),
    entered = deferred<void>();
  const controller = new WritingTermsWorkbench({
    ...options,
    open: async () => {
      entered.resolve();
      return gate.promise;
    },
  });
  controller.setRecipeText(rules);
  const run = controller.load(file(text));
  await entered.promise;
  controller.clear();
  controller.setRecipeText(rules.replace("PRIVATE_TERM", "NEXT_TERM"));
  const witness = controller.getSnapshot();
  gate.resolve(opened);
  await run;
  assert.equal(controller.getSnapshot(), witness);
  assert.equal(witness.input.status, "idle");
  assert.deepEqual(witness.input.documents, []);
  assert.equal(witness.analysis, null);
});
