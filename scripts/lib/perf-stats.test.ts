import assert from "node:assert/strict";
import test from "node:test";
import { checkThreshold, formatScenarioLine, percentile, saturationPoint, summarize, throughput } from "./perf-stats.ts";

/**
 * 百分位与阈值判定（issue #64）。
 *
 * 基线数字只有在统计本身可信时才可信，所以这里断言的是**具体数值**，不是
 * 「大于零」之类的宽松条件。最近秩法在这组样本上的答案是固定的：
 * 1..100 的 p50 = 50、p95 = 95、p99 = 99。
 */

test("百分位用最近秩法，返回真实发生过的样本值", () => {
  const sorted = Array.from({ length: 100 }, (_, index) => index + 1);
  assert.equal(percentile(sorted, 0.5), 50);
  assert.equal(percentile(sorted, 0.9), 90);
  assert.equal(percentile(sorted, 0.95), 95);
  assert.equal(percentile(sorted, 0.99), 99);
  assert.equal(percentile(sorted, 1), 100);
  assert.equal(percentile(sorted, 0), 1);
  // 插值会给出 50.5 这样的值——那不是任何一笔请求的耗时。
  assert.equal(sorted.includes(percentile(sorted, 0.5)), true);
});

test("样本很少时百分位落到最慢的那一笔，而不是编一个中间值", () => {
  const five = [10, 20, 30, 40, 50];
  assert.equal(percentile(five, 0.95), 50);
  assert.equal(percentile(five, 0.5), 30);
  assert.equal(percentile([7], 0.99), 7);
  assert.equal(Number.isNaN(percentile([], 0.95)), true);
});

test("汇总按升序排序后取值，乱序输入不影响任何一项", () => {
  const stats = summarize([50, 10, 30, 20, 40]);
  assert.equal(stats.count, 5);
  assert.equal(stats.min, 10);
  assert.equal(stats.max, 50);
  assert.equal(stats.mean, 30);
  assert.equal(stats.p50, 30);
});

test("空样本得到 NaN 而不是零：没有数据不能读作「很快」", () => {
  const stats = summarize([]);
  assert.equal(stats.count, 0);
  for (const key of ["min", "mean", "p50", "p95", "p99", "max"] as const) {
    assert.equal(Number.isNaN(stats[key]), true, `${key} must be NaN, not 0`);
  }
  assert.equal(throughput(0, 1000), 0);
  assert.equal(throughput(10, 0), 0);
});

test("吞吐按样本跨越的墙钟时间算，不是按样本耗时之和", () => {
  // A hundred requests taking 20 ms of wall clock each would be 20% of a second
  // if serialized; 1000 req/s is the honest answer for 100 in 100 ms.
  assert.equal(throughput(100, 100), 1000);
  assert.equal(throughput(1, 2000), 0.5);
});

test("上限与下限方向不同，NaN 一律不通过", () => {
  const stats = { p95: 40, p99: 80, mean: 20, throughput: 900 };
  assert.equal(checkThreshold(stats, { metric: "p95", direction: "atMost", limit: 50, rationale: "" }).ok, true);
  assert.equal(checkThreshold(stats, { metric: "p95", direction: "atMost", limit: 39, rationale: "" }).ok, false);
  assert.equal(checkThreshold(stats, { metric: "p95", direction: "atMost", limit: 40, rationale: "" }).ok, true, "the limit is inclusive");
  assert.equal(checkThreshold(stats, { metric: "throughput", direction: "atLeast", limit: 500, rationale: "" }).ok, true);
  assert.equal(checkThreshold(stats, { metric: "throughput", direction: "atLeast", limit: 1000, rationale: "" }).ok, false);
  // A measurement that failed is not a measurement that passed.
  assert.equal(checkThreshold({ ...stats, p99: NaN }, { metric: "p99", direction: "atMost", limit: 500, rationale: "" }).ok, false);
});

test("报告行同时写下样本数、并发数与每一项分位", () => {
  const line = formatScenarioLine("public read", summarize([1, 2, 3, 4]), 123.4, 8);
  assert.match(line, /public read/);
  assert.match(line, /n=\s+4/);
  assert.match(line, /c=\s8/);
  assert.match(line, /p50=/);
  assert.match(line, /p99=/);
  assert.match(line, /req\/s/);
  // An empty measurement prints a dash, never a fake zero.
  assert.match(formatScenarioLine("empty", summarize([]), 0, 1), /p95=\s+—/);
});

/**
 * 并发阶梯与饱和点（issue #64）。
 *
 * 这张结论会直接写进部署文档，所以它必须是可复现的算术而不是「看着像平了」。
 */
test("吞吐随并发变平时判定为饱和，并给出进入饱和的最小并发", () => {
  // The measured shape on this repository: flat from c=1 onwards, because a
  // synchronous SQLite call serializes the event loop.
  const flat = [
    { concurrency: 1, requestsPerSecond: 167 },
    { concurrency: 2, requestsPerSecond: 166 },
    { concurrency: 4, requestsPerSecond: 155 },
    { concurrency: 8, requestsPerSecond: 171 },
  ];
  const point = saturationPoint(flat);
  assert.equal(point.saturated, true);
  assert.equal(point.concurrency, 1, "already saturated at a single request in flight");
});

test("仍在随并发上升的机器不能报告成已饱和", () => {
  const scaling = [
    { concurrency: 1, requestsPerSecond: 100 },
    { concurrency: 2, requestsPerSecond: 190 },
    { concurrency: 4, requestsPerSecond: 360 },
    { concurrency: 8, requestsPerSecond: 700 },
  ];
  const point = saturationPoint(scaling);
  assert.equal(point.saturated, false, "doubling still nearly doubles throughput");
  assert.equal(point.concurrency, 8, "the knee is the rung that reaches 85% of peak");
});

test("单格阶梯无从判断饱和，空阶梯返回零而不是抛错", () => {
  assert.equal(saturationPoint([{ concurrency: 1, requestsPerSecond: 100 }]).saturated, false, "one rung proves nothing about scaling");
  assert.deepEqual(saturationPoint([]), { concurrency: 0, requestsPerSecond: 0, saturated: false });
});
