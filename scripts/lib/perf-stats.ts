/**
 * 负载样本的统计（issue #64）。
 *
 * 这里只做算术：把一堆毫秒数变成 p50/p95/p99 与吞吐。它被单独放在一个模块
 * 里，是因为**百分位算错是最容易悄悄发生的一种错**——取整、排序方向、样本为
 * 空、用一个明显不合理的插值公式，任何一个都会让基线看起来更好或更坏，而没有
 * 任何东西会因此变红。所以它有测试，且测试断言的是具体的数字。
 */

export type LatencyStats = {
  /** 参与统计的样本数。 */
  count: number;
  min: number;
  /** 算术平均，单位毫秒。 */
  mean: number;
  p50: number;
  p75: number;
  p90: number;
  p95: number;
  p99: number;
  max: number;
};

/**
 * 最近秩法（nearest-rank）的百分位。
 *
 * 对 n 个**已排序**样本取第 `ceil(p * n)` 个（1 起），再夹回 `[1, n]`。
 * 不用线性插值：插值会给出一个**没有发生过的耗时**，而 p95 的用处恰恰是
 * 「实际有一笔请求真的慢到这个程度」。样本很少时最近秩法会直接落到最大值上，
 * 这是诚实的：五个样本里没有真正的 p95，说「最慢的那笔」比编一个中间值好。
 */
export function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return Number.NaN;
  if (!Number.isFinite(p) || p <= 0) return sorted[0];
  if (p >= 1) return sorted[sorted.length - 1];
  const rank = Math.ceil(p * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))];
}

/** 从一个乱序样本集算出全部统计量。空样本得到全 `NaN`，而不是 `0`。 */
export function summarize(samples: readonly number[]): LatencyStats {
  if (samples.length === 0) {
    return { count: 0, min: NaN, mean: NaN, p50: NaN, p75: NaN, p90: NaN, p95: NaN, p99: NaN, max: NaN };
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const total = sorted.reduce((sum, value) => sum + value, 0);
  return {
    count: sorted.length,
    min: sorted[0],
    mean: total / sorted.length,
    p50: percentile(sorted, 0.5),
    p75: percentile(sorted, 0.75),
    p90: percentile(sorted, 0.9),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
    max: sorted[sorted.length - 1],
  };
}

/** 每秒完成的请求数：样本数除以这批样本实际跨越的墙钟时间。 */
export function throughput(count: number, elapsedMs: number): number {
  if (count <= 0 || !Number.isFinite(elapsedMs) || elapsedMs <= 0) return 0;
  return (count * 1000) / elapsedMs;
}

/** 毫秒取一位小数，报告里读起来不至于满屏浮点噪声。 */
export function ms(value: number): number {
  return Number.isFinite(value) ? Math.round(value * 10) / 10 : NaN;
}

/**
 * 一条基线阈值，以及它为什么是这个数。
 *
 * `rationale` 不是装饰：一个没有理由的数字会在下一次有人想「先把它调宽一点让
 * CI 变绿」时被调宽。写下依据，改的人就得先反驳它。
 */
export type Threshold = {
  /** 报告中使用的名字。 */
  metric: "p95" | "p99" | "mean" | "throughput";
  /** 比较方向：`atMost` 是上限，`atLeast` 是下限（吞吐）。 */
  direction: "atMost" | "atLeast";
  limit: number;
  rationale: string;
};

export type ThresholdOutcome = {
  metric: Threshold["metric"];
  actual: number;
  limit: number;
  direction: Threshold["direction"];
  ok: boolean;
  rationale: string;
};

/**
 * 比对一条统计量与它的阈值。
 *
 * 上限按 `actual <= limit` 判、下限按 `actual >= limit` 判；`NaN` 一律算不通过
 * ——没有测出数据不能伪装成「没有超限」。
 */
export function checkThreshold(stats: { p95: number; p99: number; mean: number; throughput: number }, threshold: Threshold): ThresholdOutcome {
  const actual = stats[threshold.metric];
  const ok = Number.isFinite(actual) && (threshold.direction === "atMost" ? actual <= threshold.limit : actual >= threshold.limit);
  return { metric: threshold.metric, actual, limit: threshold.limit, direction: threshold.direction, ok, rationale: threshold.rationale };
}

/**
 * 报告里的一行。
 *
 * 每个场景都写明样本数与并发数：一个 p95 离开了这两个数字就没有意义，「p95
 * 12ms」在一千个样本上是结论，在三个样本上是巧合。
 */
export function formatScenarioLine(name: string, stats: LatencyStats, requestsPerSecond: number, concurrency: number): string {
  const f = (value: number) => (Number.isFinite(value) ? value.toFixed(1) : "—");
  return [
    name.padEnd(28),
    `n=${String(stats.count).padStart(5)}`,
    `c=${String(concurrency).padStart(2)}`,
    `p50=${f(stats.p50).padStart(7)}ms`,
    `p95=${f(stats.p95).padStart(7)}ms`,
    `p99=${f(stats.p99).padStart(7)}ms`,
    `max=${f(stats.max).padStart(7)}ms`,
    `${f(requestsPerSecond).padStart(8)} req/s`,
  ].join("  ");
}

/** 并发阶梯上的一格：在这个并发下测到的吞吐。 */
export type LadderRung = { concurrency: number; requestsPerSecond: number };

/**
 * 阶梯的结论：单机能扛多少。
 *
 * 「饱和点」取达到峰值吞吐 85% 的**最小**并发——要的是进入饱和所需的最少并发，
 * 不是能硬撑到多少。
 *
 * 饱和与否看的是**最后一步**：并发翻倍若没换来 15% 以上的吞吐，就说明吞吐不再
 * 随并发增长。不能拿最后一格去比峰值——峰值按定义就是最后一格，那个比较恒真，
 * 会永远报告「已饱和」，包括一台还有余量的机器。
 */
export function saturationPoint(ladder: readonly LadderRung[]): { concurrency: number; requestsPerSecond: number; saturated: boolean } {
  if (ladder.length === 0) return { concurrency: 0, requestsPerSecond: 0, saturated: false };
  const peak = Math.max(...ladder.map((rung) => rung.requestsPerSecond));
  const knee = ladder.find((rung) => rung.requestsPerSecond >= peak * 0.85) ?? ladder[0];
  const last = ladder[ladder.length - 1];
  const previous = ladder[ladder.length - 2];
  const saturated = previous !== undefined && last.requestsPerSecond <= previous.requestsPerSecond * 1.15;
  return { concurrency: knee.concurrency, requestsPerSecond: knee.requestsPerSecond, saturated };
}
