import assert from "node:assert/strict";
import test from "node:test";
import { cadenceSource } from "./writing-cadence-test-support.ts";
import { WritingCadenceWorkbench } from "./writing-cadence-controller.ts";
import { DEFAULT_CADENCE_POLICY } from "./writing-cadence-model.ts";
import { CollectionDownloadLease } from "./writing-collection-browser.ts";
import { analyzeWritingCadence } from "./writing-cadence.ts";
import { explainCadenceStack } from "./writing-cadence-explain.ts";

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const file = (name = "private.json") => new File(["{}"], name);
const text = async () =>
  (await cadenceSource([["（甲。）\u200b"]])).prepared.text;
const fast = async () => {};

test("迟到读取/校验与进度在同文件重选、取消和clear后不能回填", async () => {
  const pending = deferred<string>();
  let progress!: (value: number) => void;
  const controller = new WritingCadenceWorkbench({
    read: async (_file, _signal, update) => {
      progress = update ?? (() => {});
      return pending.promise;
    },
    pause: fast,
  });
  const loading = controller.load(file());
  progress(150);
  assert.equal(controller.getSnapshot().input.percent, 100);
  controller.clear();
  pending.resolve(await text());
  await loading;
  progress(50);
  assert.equal(controller.getSnapshot().input.status, "idle");
  const slowOpen = deferred<Awaited<ReturnType<typeof cadenceSource>>>();
  const other = new WritingCadenceWorkbench({
    read: text,
    open: async () => slowOpen.promise,
    pause: fast,
  });
  const first = other.load(file());
  await new Promise((resolve) => setImmediate(resolve));
  other.cancel();
  slowOpen.resolve(await cadenceSource([["迟到。"]]));
  await first;
  assert.equal(other.getSnapshot().input.status, "idle");
  assert.equal(other.getSnapshot().analysis, null);
});

test("条件无效中间稿、变更、重跑与迟到分析都撤销旧权限", async () => {
  const pending = deferred<Awaited<ReturnType<typeof analyzeWritingCadence>>>();
  const source = await cadenceSource([["（甲。）"]]);
  const valid = await analyzeWritingCadence(
    source,
    DEFAULT_CADENCE_POLICY,
    undefined,
    { pause: fast },
  );
  let update!: NonNullable<
    Parameters<typeof analyzeWritingCadence>[3]
  >["progress"];
  const controller = new WritingCadenceWorkbench({
    read: async () => source.prepared.text,
    analyze: async (_source, _policy, _signal, options) => {
      update = options?.progress;
      return pending.promise;
    },
    pause: fast,
  });
  await controller.load(file());
  const running = controller.analyze();
  assert.equal(controller.getSnapshot().status, "running");
  assert.equal(
    controller.setPolicy({ ...DEFAULT_CADENCE_POLICY, long: 0 }),
    false,
  );
  assert.equal(controller.getSnapshot().policy, null);
  pending.resolve(valid);
  await running;
  update?.({ stage: "scan", done: 1, total: 1 });
  assert.equal(controller.getSnapshot().analysis, null);
  assert.equal(controller.getSnapshot().progress, null);
  assert.equal(controller.setPolicy(DEFAULT_CADENCE_POLICY), true);
  await controller.analyze();
  assert.equal(controller.getSnapshot().analysis, valid);
  controller.setPolicy({ ...DEFAULT_CADENCE_POLICY, dot: true });
  assert.equal(controller.getSnapshot().analysis, null);
});

test("准备、人工确认、下载要求同一witness；错误整批不丢原标记，标记变化使报告失效", async () => {
  const controller = new WritingCadenceWorkbench({
    read: text,
    pause: fast,
    now: () => new Date("2026-11-12T00:00:00Z"),
  });
  await controller.load(file());
  await controller.analyze();
  const analysis = controller.getSnapshot().analysis!;
  assert.ok(analysis);
  assert.equal(controller.mark(["f1"], "intentional", analysis), true);
  assert.equal(controller.mark(["f2", "f999"], "follow-up", analysis), false);
  assert.deepEqual(controller.getSnapshot().marks, [
    { id: "f1", state: "intentional" },
  ]);
  assert.equal(controller.prepareReport(), true);
  const report = controller.getSnapshot().report!;
  assert.throws(() => controller.reportDownload(report));
  assert.equal(controller.confirmReport(true), true);
  assert.equal(controller.reportDownload(report), report);
  assert.equal(controller.permitsReport({ ...report }), false);
  assert.equal(controller.mark(["f1"], "follow-up", analysis), true);
  assert.equal(controller.permitsReport(report), false);
  assert.equal(controller.getSnapshot().report, null);
  assert.equal(
    controller.mark(["f1"], "intentional", structuredClone(analysis)),
    false,
  );
  assert.equal(controller.getSnapshot().marks[0]!.state, "follow-up");
  assert.ok(Object.isFrozen(controller.getSnapshot().marks[0]));
});

test("对象URL创建期间同步清理会取消交付并回收URL，不能事后继续下载", async () => {
  const controller = new WritingCadenceWorkbench({ read: text, pause: fast });
  await controller.load(file());
  await controller.analyze();
  controller.prepareReport();
  controller.confirmReport(true);
  const report = controller.getSnapshot().report!,
    revoked: string[] = [],
    delivered: string[] = [];
  const lease = new CollectionDownloadLease({
    create: () => {
      controller.clear();
      return "blob:revoked";
    },
    revoke: (url) => revoked.push(url),
    deliver: (url) => delivered.push(url),
    later: (task) => setTimeout(task, 1000),
    cancel: clearTimeout,
  });
  assert.throws(() =>
    lease.download(controller.reportDownload(report), () =>
      controller.permitsReport(report),
    ),
  );
  assert.deepEqual(delivered, []);
  assert.deepEqual(revoked, ["blob:revoked"]);
  assert.equal(controller.getSnapshot().input.status, "idle");
});

test("同步订阅者清理能阻止后续工作启动，超限文件不调用读取器", async () => {
  let reads = 0,
    analyses = 0;
  const controller = new WritingCadenceWorkbench({
    read: async () => {
      reads++;
      return text();
    },
    analyze: async (...args) => {
      analyses++;
      return analyzeWritingCadence(...args);
    },
    pause: fast,
  });
  await controller.load({
    size: 16 * 1024 * 1024 + 1,
    name: "large.json",
  } as File);
  assert.equal(reads, 0);
  const unsubscribe = controller.subscribe(() => {
    if (controller.getSnapshot().input.status === "reading") controller.clear();
  });
  await controller.load(file());
  assert.equal(reads, 0);
  unsubscribe();
  await controller.load(file());
  const stop = controller.subscribe(() => {
    if (controller.getSnapshot().status === "running") controller.clear();
  });
  await controller.analyze();
  stop();
  assert.equal(analyses, 0);
  assert.equal(controller.getSnapshot().analysis, null);
});

test("新读取胜过旧读取；来源或条件不同的注入分析被拒绝，失败不借用旧报告", async () => {
  const old = deferred<string>(),
    source = await cadenceSource([["（新稿。）"]]);
  let reads = 0;
  const controller = new WritingCadenceWorkbench({
    read: async () => (++reads === 1 ? old.promise : source.prepared.text),
    pause: fast,
  });
  const first = controller.load(file("same.json"));
  await controller.load(file("same.json"));
  await controller.analyze();
  const current = controller.getSnapshot().analysis;
  old.resolve(await text());
  await first;
  assert.equal(controller.getSnapshot().analysis, current);
  const bad = new WritingCadenceWorkbench({
    read: text,
    analyze: async () => current!,
    pause: fast,
  });
  await bad.load(file());
  await bad.analyze();
  assert.equal(bad.getSnapshot().status, "failed");
  assert.equal(bad.getSnapshot().analysis, null);
  assert.match(bad.getSnapshot().error, /来源|条件|一致/);
});

test("迟到栈解释在关闭定位、换条件、取消或隐私清除后不能复活；新解释胜过旧请求", async () => {
  const source = await cadenceSource([["([)] ]"]]);
  const analysis = await analyzeWritingCadence(
    source,
    DEFAULT_CADENCE_POLICY,
    undefined,
    { pause: fast },
  );
  const first = deferred<Awaited<ReturnType<typeof explainCadenceStack>>>();
  let calls = 0;
  const controller = new WritingCadenceWorkbench({
    read: async () => source.prepared.text,
    pause: fast,
    explain: async (...args) =>
      ++calls === 1 ? first.promise : explainCadenceStack(...args),
  });
  await controller.load(file());
  await controller.analyze();
  const pending = controller.explain("f2", "start");
  assert.equal(controller.getSnapshot().explanation!.status, "running");
  controller.clearExplanation();
  await controller.explain("f3", "end");
  const current = controller.getSnapshot().explanation;
  first.resolve(
    await explainCadenceStack(analysis, "f2", "start", undefined, {
      pause: fast,
    }),
  );
  await pending;
  assert.equal(controller.getSnapshot().explanation, current);
  assert.equal(current!.id, "f3");
  controller.setPolicy({ ...DEFAULT_CADENCE_POLICY, dot: true });
  assert.equal(controller.getSnapshot().explanation, null);
  controller.clear();
  assert.equal(controller.getSnapshot().analysis, null);
  for (const change of [
    "close",
    "policy",
    "cancel",
    "clear",
    "load",
    "analyze",
  ] as const) {
    const late = deferred<Awaited<ReturnType<typeof explainCadenceStack>>>();
    const active = new WritingCadenceWorkbench({
      read: async () => source.prepared.text,
      pause: fast,
      explain: async () => late.promise,
    });
    await active.load(file());
    await active.analyze();
    const explaining = active.explain("f2");
    assert.equal(active.getSnapshot().explanation!.status, "running");
    if (change === "close") active.clearExplanation();
    if (change === "policy")
      active.setPolicy({ ...DEFAULT_CADENCE_POLICY, short: 2 });
    if (change === "cancel") active.cancel();
    if (change === "clear") active.clear();
    if (change === "load") await active.load(file());
    if (change === "analyze") await active.analyze();
    const next = active.getSnapshot();
    assert.equal(next.explanation, null, change);
    late.resolve(
      await explainCadenceStack(analysis, "f2", "start", undefined, {
        pause: fast,
      }),
    );
    await explaining;
    assert.equal(active.getSnapshot(), next, change);
  }
});
