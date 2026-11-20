import assert from "node:assert/strict";
import test from "node:test";
import { WritingParallelWorkbench } from "./writing-parallel-controller.ts";
import { parallelSource } from "./writing-parallel-test-support.ts";

test("控制器初始状态空闲且无报告授权", () => {
  const controller = new WritingParallelWorkbench();
  const snapshot = controller.getSnapshot();
  assert.equal(snapshot.phase, "empty");
  assert.equal(snapshot.collection, null);
  assert.equal(snapshot.analysis, null);
  assert.equal(snapshot.report, null);
});

test("载入合法集合后自动执行双语对齐分析并产出快照", async () => {
  const controller = new WritingParallelWorkbench();
  const collection = await parallelSource([
    { locale: "zh-TW", blocks: ["段落甲。"] },
    { locale: "en", blocks: ["Paragraph A."] },
  ]);

  await controller.loadCollection(collection);
  const snapshot = controller.getSnapshot();
  assert.equal(snapshot.phase, "ready");
  assert.ok(snapshot.analysis !== null);
  assert.equal(snapshot.analysis.pairs.length, 1);
});

test("双重读取栅栏：在分析未完成时切换集合或取消，迟到的旧分析不能回填", async () => {
  const controller = new WritingParallelWorkbench();
  const collection1 = await parallelSource([
    { locale: "zh-TW", blocks: ["慢速集合甲。"] },
    { locale: "en", blocks: ["Slow collection A."] },
  ]);
  const collection2 = await parallelSource([
    { locale: "zh-TW", blocks: ["快速集合乙。"] },
    { locale: "en", blocks: ["Fast collection B."] },
  ]);

  const p1 = controller.loadCollection(collection1);
  // User immediately switches to collection 2
  const p2 = controller.loadCollection(collection2);

  await Promise.all([p1, p2]);
  const snapshot = controller.getSnapshot();
  assert.equal(snapshot.phase, "ready");
  // Analysis must belong to collection 2, not collection 1
  assert.equal(
    snapshot.collection?.prepared.collection.digest,
    collection2.prepared.collection.digest,
  );
});

test("清除操作立即重置状态机，释放引用", async () => {
  const controller = new WritingParallelWorkbench();
  const collection = await parallelSource([
    { locale: "zh-TW", blocks: ["段落。"] },
    { locale: "en", blocks: ["Paragraph."] },
  ]);
  await controller.loadCollection(collection);
  assert.equal(controller.getSnapshot().phase, "ready");

  controller.clear();
  const cleared = controller.getSnapshot();
  assert.equal(cleared.phase, "empty");
  assert.equal(cleared.analysis, null);
  assert.equal(cleared.collection, null);
  assert.equal(cleared.report, null);
});
