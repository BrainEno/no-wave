import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createWritingBackup,
  MAX_WRITING_BACKUP_BYTES,
  parseWritingBackup,
} from "./writing-backup.ts";
import {
  createWritingMergePlan,
  MERGE_PLAN_BYTE_LIMIT,
} from "./writing-merge-plan.ts";
import { WritingMergeWorkbench } from "./writing-merge-controller.ts";

const now = new Date("2026-11-12T00:00:00.000Z");
const content = (text: string) =>
  createWritingBackup(
    {
      title: "本机",
      summary: "",
      locale: "zh-CN",
      workType: "essay",
      editorState: {
        root: {
          type: "root",
          version: 1,
          children: [
            {
              type: "paragraph",
              version: 1,
              children: [{ type: "text", version: 1, text }],
            },
          ],
        },
      },
    },
    now,
  );
const file = (text: string, name = "local.json") =>
  new File([text], name, { type: "application/json" });
const options = { read: async (value: File) => value.text(), now: () => now };
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
async function loaded(controller: WritingMergeWorkbench) {
  await Promise.all([
    controller.load("base", file(content("基线"))),
    controller.load("current", file(content("当前"))),
    controller.load("incoming", file(content("另一"))),
  ]);
}
async function analyzed(controller = new WritingMergeWorkbench(options)) {
  await loaded(controller);
  controller.confirmBaseline(true);
  await controller.analyze();
  assert.ok(controller.getSnapshot().analysis);
  return controller;
}
function chooseCurrent(controller: WritingMergeWorkbench) {
  const analysis = controller.getSnapshot().analysis!;
  const unit = analysis.units.find((item) => item.status === "conflict")!;
  controller.choose(unit.id, "current", analysis);
  return { analysis, unit };
}

test("the workbench cannot analyze without three validated sources and explicit baseline confirmation", async () => {
  const controller = new WritingMergeWorkbench(options);
  controller.confirmBaseline(true);
  await controller.analyze();
  assert.equal(controller.getSnapshot().analysis, null);
  await loaded(controller);
  await controller.analyze();
  assert.equal(controller.getSnapshot().analysis, null);
  assert.match(controller.getSnapshot().error, /共同基线|确认/);
  controller.confirmBaseline(true);
  await controller.analyze();
  assert.ok(controller.getSnapshot().analysis);
});

test("oversized source and plan files fail before allocating a reader; invalid JSON admits no backup", async () => {
  let reads = 0;
  const controller = new WritingMergeWorkbench({
    ...options,
    read: async (value) => {
      reads++;
      return value.text();
    },
  });
  await controller.load("base", {
    size: MAX_WRITING_BACKUP_BYTES + 1,
    name: "huge.json",
  } as File);
  assert.equal(reads, 0);
  assert.equal(controller.getSnapshot().slots.base.backup, null);
  await analyzed(controller);
  const before = reads;
  await controller.loadPlan({ size: MERGE_PLAN_BYTE_LIMIT + 1 } as File);
  assert.equal(reads, before);
  assert.equal(controller.getSnapshot().planPreview, null);
  await controller.load("base", file("{broken"));
  assert.equal(controller.getSnapshot().slots.base.status, "failed");
  assert.equal(controller.getSnapshot().analysis, null);
});

test("a superseded read or parser completion cannot overwrite a replacement or resurrect cleared data", async () => {
  const delayed = deferred<string>();
  const controller = new WritingMergeWorkbench({
    ...options,
    read: async (value) =>
      value.name === "old.json" ? delayed.promise : value.text(),
  });
  const old = controller.load("base", file(content("旧稿"), "old.json"));
  await controller.load("base", file(content("新稿"), "new.json"));
  delayed.resolve(content("旧稿"));
  await old;
  assert.equal(
    controller.getSnapshot().slots.base.backup!.draft.editorState!.root
      .children[0]!.type,
    "paragraph",
  );
  assert.ok(
    JSON.stringify(controller.getSnapshot().slots.base.backup).includes("新稿"),
  );
  const parsing = deferred<ReturnType<typeof parseWritingBackup>>();
  const second = new WritingMergeWorkbench({
    ...options,
    open: async () => parsing.promise,
  });
  const work = second.load("current", file(content("已清除")));
  await new Promise((resolve) => setImmediate(resolve));
  second.clear();
  parsing.resolve(parseWritingBackup(content("已清除")));
  await work;
  assert.equal(second.getSnapshot().slots.current.status, "idle");
  assert.equal(second.getSnapshot().slots.current.backup, null);
});

test("a source replacement invalidates confirmation, all choices, plans and result artifacts synchronously", async () => {
  const controller = await analyzed();
  chooseCurrent(controller);
  await controller.prepare();
  await controller.preparePlan();
  const prepared = controller.getSnapshot().prepared,
    plan = controller.getSnapshot().planArtifact;
  assert.ok(prepared);
  assert.ok(plan);
  const replacement = controller.load("incoming", file(content("新来源")));
  assert.equal(controller.getSnapshot().analysis, null);
  assert.equal(controller.getSnapshot().baselineConfirmed, false);
  assert.deepEqual(controller.getSnapshot().decisions, []);
  assert.throws(() => controller.resultDownload(prepared), /过期|变化|准备/);
  assert.throws(() => controller.planDownload(plan), /过期|变化|准备/);
  await replacement;
});

test("canceling or changing sources while analysis yields never publishes a stale analysis", async () => {
  let gate: ReturnType<typeof deferred<void>> | null = null;
  const controller = new WritingMergeWorkbench({
    ...options,
    pause: async () => {
      await gate?.promise;
    },
  });
  await loaded(controller);
  controller.confirmBaseline(true);
  gate = deferred<void>();
  const work = controller.analyze();
  controller.cancelAnalysis();
  gate.resolve();
  await work;
  assert.equal(controller.getSnapshot().analysisStatus, "cancelled");
  assert.equal(controller.getSnapshot().analysis, null);
  gate = deferred<void>();
  const second = controller.analyze();
  controller.clear("base");
  gate.resolve();
  await second;
  assert.equal(controller.getSnapshot().analysisStatus, "idle");
  assert.equal(controller.getSnapshot().analysis, null);
});

test("synchronous cancellation from a published running snapshot cannot be overwritten by later setup", async () => {
  const controller = new WritingMergeWorkbench(options);
  await loaded(controller);
  controller.confirmBaseline(true);
  let cancelled = false;
  const unsubscribe = controller.subscribe(() => {
    if (!cancelled && controller.getSnapshot().analysisStatus === "running") {
      cancelled = true;
      controller.cancelAnalysis();
    }
  });
  await controller.analyze();
  assert.equal(controller.getSnapshot().analysisStatus, "cancelled");
  assert.equal(controller.getSnapshot().analysis, null);
  unsubscribe();
});

test("choices require the live analysis witness and invalidate pending preparation, including ABA choice changes", async () => {
  let gate: ReturnType<typeof deferred<void>> | null = null;
  const controller = await analyzed(
    new WritingMergeWorkbench({
      ...options,
      pause: async () => {
        await gate?.promise;
      },
    }),
  );
  const { analysis, unit } = chooseCurrent(controller);
  gate = deferred<void>();
  const work = controller.prepare();
  controller.choose(unit.id, "incoming", analysis);
  controller.choose(unit.id, "current", analysis);
  gate.resolve();
  await work;
  assert.equal(controller.getSnapshot().prepared, null);
  assert.equal(controller.getSnapshot().preparing, false);
  controller.choose(unit.id, "base", { ...analysis });
  assert.equal(controller.getSnapshot().decisions[0]!.choice, "current");
  assert.match(controller.getSnapshot().error, /过期|变化/);
});

test("unresolved and combined-invalid results remain explicit failures, not downloadable successes", async () => {
  const controller = await analyzed();
  await controller.prepare();
  assert.equal(controller.getSnapshot().prepared, null);
  assert.match(controller.getSnapshot().error, /冲突|取舍/);
  assert.throws(() => controller.resultDownload(null), /准备|过期/);
  chooseCurrent(controller);
  await controller.prepare();
  assert.equal(
    parseWritingBackup(
      controller.resultDownload(controller.getSnapshot().prepared).text,
    ).draft.title,
    "本机",
  );
  controller.confirmBaseline(false);
  assert.equal(controller.getSnapshot().prepared, null);
});

test("a loaded decision plan is inert until explicit application and replaces rather than merges choices", async () => {
  const controller = await analyzed(),
    { analysis } = chooseCurrent(controller);
  await controller.prepare();
  const result = controller.getSnapshot().prepared;
  const empty = await createWritingMergePlan(analysis, [], now);
  await controller.loadPlan(file(empty.text));
  const preview = controller.getSnapshot().planPreview;
  assert.ok(preview);
  assert.equal(controller.getSnapshot().decisions.length, 1);
  assert.equal(controller.getSnapshot().prepared, result);
  assert.throws(() => controller.applyPlan({ ...preview }), /过期|变化/);
  controller.applyPlan(preview);
  assert.deepEqual(controller.getSnapshot().decisions, []);
  assert.equal(controller.getSnapshot().prepared, null);
});

test("a decision edit invalidates a plan preview and a delayed plan read even if the choices later match", async () => {
  const delayed = deferred<string>();
  const controller = await analyzed(
    new WritingMergeWorkbench({
      ...options,
      read: async (value) =>
        value.name === "slow-plan.json" ? delayed.promise : value.text(),
    }),
  );
  const { analysis, unit } = chooseCurrent(controller);
  const plan = await createWritingMergePlan(
    analysis,
    [{ unit: unit.id, choice: "incoming" }],
    now,
  );
  const work = controller.loadPlan(file(plan.text, "slow-plan.json"));
  controller.choose(unit.id, "base", analysis);
  controller.choose(unit.id, "current", analysis);
  delayed.resolve(plan.text);
  await work;
  assert.equal(controller.getSnapshot().planPreview, null);
  await controller.loadPlan(file(plan.text));
  const preview = controller.getSnapshot().planPreview;
  assert.ok(preview);
  controller.choose(unit.id, null, analysis);
  assert.throws(() => controller.applyPlan(preview), /过期|变化/);
});

test("pending plan export is fenced by decision revision and cannot download old choices", async () => {
  let gate: ReturnType<typeof deferred<void>> | null = null;
  const controller = await analyzed(
    new WritingMergeWorkbench({
      ...options,
      pause: async () => {
        await gate?.promise;
      },
    }),
  );
  const { analysis, unit } = chooseCurrent(controller);
  gate = deferred<void>();
  const work = controller.preparePlan();
  controller.choose(unit.id, "incoming", analysis);
  gate.resolve();
  await work;
  assert.equal(controller.getSnapshot().planArtifact, null);
  await controller.preparePlan();
  const artifact = controller.getSnapshot().planArtifact;
  assert.ok(artifact);
  assert.equal(controller.planDownload(artifact), artifact);
  controller.resetDecisions(analysis);
  assert.throws(() => controller.planDownload(artifact), /过期|变化|准备/);
});

test("clear releases every in-memory source and derived object, and does not repopulate after a late failure", async () => {
  const delayed = deferred<string>();
  const controller = await analyzed(
    new WritingMergeWorkbench({
      ...options,
      read: async (value) =>
        value.name === "late.json" ? delayed.promise : value.text(),
    }),
  );
  chooseCurrent(controller);
  await controller.prepare();
  let publications = 0;
  const unsubscribe = controller.subscribe(() => {
    publications++;
  });
  const work = controller.load(
    "incoming",
    file(content("不应复活"), "late.json"),
  );
  controller.clear();
  delayed.reject(new Error("late failure"));
  await work;
  const state = controller.getSnapshot();
  assert.ok(
    Object.values(state.slots).every(
      (slot) => slot.backup === null && slot.name === "" && slot.error === "",
    ),
  );
  assert.equal(state.analysis, null);
  assert.equal(state.prepared, null);
  assert.equal(state.planPreview, null);
  assert.equal(state.error, "");
  assert.ok(publications > 0);
  unsubscribe();
});
