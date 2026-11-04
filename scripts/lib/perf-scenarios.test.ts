import assert from "node:assert/strict";
import test from "node:test";
import {
  BASELINE_THRESHOLDS,
  DEFAULT_PLAN,
  DEFAULT_SEED,
  jobsFor,
  seedAuthor,
  seedWork,
  totalSamples,
} from "./perf-scenarios.ts";

/**
 * 压测计划与种子数据（issue #64）。
 *
 * 这些断言守的是「基线本身有没有意义」：样本太少时百分位是巧合，阈值没有依据
 * 时它会被随手调宽，种子数据不合法时压测根本没跑起来却报了个好看的数字。
 */

test("每条路径都有足够的样本让 p99 有意义", () => {
  for (const plan of DEFAULT_PLAN) {
    assert.ok(totalSamples(plan) >= 100, `${plan.name} needs at least 100 samples for a p99, got ${totalSamples(plan)}`);
    assert.ok(plan.warmup >= 1, `${plan.name} must warm up before measuring`);
  }
});

test("并发计划把总量平均分给每个并发单元", () => {
  assert.deepEqual(jobsFor({ name: "public-page-read", title: "", concurrency: 4, operations: 25, warmup: 0 }), [25, 25, 25, 25]);
  assert.equal(totalSamples({ name: "public-page-read", title: "", concurrency: 4, operations: 25, warmup: 0 }), 100);
  assert.throws(() => jobsFor({ name: "public-page-read", title: "", concurrency: 0, operations: 1, warmup: 0 }));
  assert.throws(() => jobsFor({ name: "public-page-read", title: "", concurrency: 1, operations: 0, warmup: 0 }));
});

test("每条路径都有上限与下限两条护栏，且都写了依据", () => {
  const names = DEFAULT_PLAN.map((plan) => plan.name);
  assert.deepEqual(Object.keys(BASELINE_THRESHOLDS).sort(), [...names].sort(), "every scenario is guarded");
  for (const [name, thresholds] of Object.entries(BASELINE_THRESHOLDS)) {
    const metrics = thresholds.map((threshold) => threshold.metric);
    assert.ok(metrics.includes("p95"), `${name} guards latency`);
    assert.ok(metrics.includes("throughput"), `${name} guards throughput`);
    for (const threshold of thresholds) {
      assert.ok(threshold.limit > 0, `${name}/${threshold.metric} has a positive limit`);
      // A rationale is what stops the next person from widening the number to
      // make CI green without arguing about it first.
      assert.ok(threshold.rationale.length > 30, `${name}/${threshold.metric} must say WHY the limit is what it is`);
    }
  }
});

test("种子作品是持久化层会接受的形状", () => {
  const assetId = "3f7c1d90-8a2b-4c1e-9f3a-6c5b2e8d1a44";
  const work = seedWork(7, "perf-author-0", assetId);
  assert.equal(work.slug, "perf-work-7");
  assert.equal(work.publish, true);
  assert.ok(work.contentBlocks.some((block) => block.type === "image" && block.src === `/api/media/${assetId}`));
  // Every block carries its own id: the content validator refuses one without.
  for (const block of work.contentBlocks) assert.equal(typeof block.id, "string");
  assert.ok(seedWork(1, "a", null).contentBlocks.every((block) => block.type !== "image"), "no asset, no image block");
  assert.ok(DEFAULT_SEED.works >= 100, "the seed has enough works for pagination to leave page one");
});

test("作者档案带上语言，否则列表读不到它", () => {
  const author = seedAuthor(2);
  assert.equal(author.userId, "perf-author-2");
  assert.equal(author.locale, "zh-CN");
});
