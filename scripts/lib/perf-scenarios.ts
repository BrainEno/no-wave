import { randomUUID } from "node:crypto";

/**
 * 三条被度量的路径（issue #64）。
 *
 * 审计的结论是「设计上有防护，只是没被度量过」。要被度量的正是那三种工作负载，
 * 因为它们的成本模型完全不同：
 *
 * 1. **公共内容读**（`GET /api/v1/articles`）——无认证、可缓存、按 locale 读一页，
 *    是绝大多数流量。它经过完整的 HTTP 栈、序列化器与 SQLite 读路径。
 * 2. **认证写**（建作品）——SQLite 的写者只有一个，`DatabaseSync` 是同步调用，
 *    所以每一次写都会阻塞事件循环。这是单写者模型的成本所在。
 * 3. **消息发送**——写三张表（消息、会话、outbox 事件）并在同一事务里落库，是
 *    最重的一次写；它与 outbox worker 并发时还要互相让路。
 *
 * 为什么第 2、3 条不走 HTTP：写路由的限流是**产品策略**，不是被测对象 —
 * `article.create` 是每用户每小时 10 次、注册是每 IP 每小时 20 次。用 HTTP 打
 * 这些路径，测到的是限流器拒绝请求有多快。所以读写分离地度量：读走真实 HTTP 栈，
 * 写直接打**同一个持久化适配器**，并让同一个 outbox worker 并行运行。这不是
 * 端到端，但它是那条路径的实际成本，且不受策略常量影响。
 */

export type ScenarioName = "public-page-read" | "authenticated-write" | "message-send";

export type ScenarioPlan = {
  name: ScenarioName;
  /** 人类可读的一句话，出现在报告里。 */
  title: string;
  /** 并发度：同时有多少个在途操作。 */
  concurrency: number;
  /** 每个并发单元做多少次操作。总样本 = concurrency × operations。 */
  operations: number;
  /** 预热次数（不计入统计），让 JIT 与语句缓存稳定下来。 */
  warmup: number;
};

/**
 * 默认计划。
 *
 * 规模按「能在一次 CI 作业里跑完，又足够让百分位有意义」来定：每条路径至少
 * 100 个样本（p99 才有 1 个以上的观测点），总量在几千次操作以内。`warmup`
 * 非零是因为第一次 prepare、第一次 JIT、第一次分配都会明显更慢，把冷启动算进
 * p99 会让基线变成「测 Node 启动」。
 */
export const DEFAULT_PLAN: readonly ScenarioPlan[] = Object.freeze([
  { name: "public-page-read", title: "公共列表读（GET /api/v1/articles?limit=20）", concurrency: 8, operations: 40, warmup: 8 },
  { name: "authenticated-write", title: "认证写（创建作品，单写者）", concurrency: 1, operations: 120, warmup: 10 },
  { name: "message-send", title: "消息发送（消息 + 会话 + outbox 同事务）", concurrency: 1, operations: 120, warmup: 10 },
]);

/**
 * 从一个计划换算出并发执行的任务。
 *
 * 故意做成纯函数：CI 里的样本数、报告里的 `n=`、以及阈值判定的可信度都从这里
 * 出发，所以它可以被测试，而不必真的压一次数据库。
 */
export function jobsFor(plan: ScenarioPlan): number[] {
  if (!Number.isInteger(plan.concurrency) || plan.concurrency < 1) throw new Error("concurrency must be a positive integer");
  if (!Number.isInteger(plan.operations) || plan.operations < 1) throw new Error("operations must be a positive integer");
  return Array.from({ length: plan.concurrency }, () => plan.operations);
}

export function totalSamples(plan: ScenarioPlan): number {
  return plan.concurrency * plan.operations;
}

/**
 * 一份合成的种子数据：`works` 篇已发布作品、`authors` 位作者。
 *
 * 数量级取「本地跑得动、又能让分页查询真的有东西可读」：200 篇作品足以让
 * `limit=20` 的偏移与游标分页落在不同的页上，而不是永远命中同一页。
 */
export type SeedShape = { authors: number; works: number };

export const DEFAULT_SEED: SeedShape = Object.freeze({ authors: 5, works: 200 });

/**
 * 作品数据。
 *
 * 正文里带一段图片地址，因为媒体引用表的写入（#163）是最近才加进事务里的，
 * 压测不带上它就会漏掉一次真实的写成本。
 */
export function seedWork(index: number, authorId: string, assetId: string | null, locale = "zh-CN") {
  return {
    authorId,
    slug: `perf-work-${index}`,
    title: `基線作品 ${index}`,
    summary: `第 ${index} 篇用于容量基线的作品。`,
    locale,
    workType: "essay" as const,
    publish: true,
    contentBlocks: [
      { id: `p-intro-${index}`, type: "paragraph" as const, text: `这是容量基线的第 ${index} 篇作品。正文长度接近一篇真实的中短篇开头，好让读取与摘要都不至于退化成空字符串。` },
      { id: `p-body-${index}`, type: "paragraph" as const, text: "第二段用来让 content_blocks 有真实的体积；序列化器会把它原样带进响应。" },
      ...(assetId ? [{ id: `img-${index}`, type: "image" as const, src: `/api/media/${assetId}`, alt: "基线插图" }] : []),
    ],
  };
}

/** 一位作者的档案。`locale` 决定它出现在哪个语言的列表里。 */
export function seedAuthor(index: number, locale = "zh-CN") {
  return { userId: `perf-author-${index}`, displayName: `基線作者 ${index}`, bio: "用于容量基线的账号。", locale };
}

/** 一个会话的两端。消息路径需要一个真实的收件人。 */
export function seedParticipants() {
  return { senderId: `perf-sender-${randomUUID().slice(0, 8)}`, recipientId: `perf-recipient-${randomUUID().slice(0, 8)}` };
}

/**
 * 基线的默认阈值。
 *
 * 这些数字是**回归护栏**，不是性能目标。它们在 CI 的共享 runner 上留了足够
 * 余量（观察到本地耗时的一个数量级左右），所以一次因为机器变慢而误报的概率很低，
 * 而一次真正的数量级回归——例如某个查询又变回 N+1、或某个事务开始全表扫描——
 * 会毫无疑问地被拦下。每个数字都附上依据，因为一个没有理由的数字会在下一次
 * 「先调宽让它变绿」时被调宽。
 */
export const BASELINE_THRESHOLDS = Object.freeze({
  "public-page-read": [
    { metric: "p95" as const, direction: "atMost" as const, limit: 150, rationale: "一页 20 篇走完整 HTTP 栈，#162 之后序列化固定 3 条语句、本机 p95 约 24ms。150ms 给了共享 runner 六倍余量，同时仍能拦住「退回 1+3N」：301 条同步语句会把 p95 推到数百毫秒。" },
    { metric: "throughput" as const, direction: "atLeast" as const, limit: 150, rationale: "本机约 600 req/s、c=1 约 500。#162 之前即使 c=8 也只有约 170，所以 150 是「序列化放大回来了」的警戒线；runner 更慢也不该低于一页 20 篇 150 req/s。" },
  ],
  "authenticated-write": [
    { metric: "p95" as const, direction: "atMost" as const, limit: 250, rationale: "单写者下每次写都在阻塞事件循环；250ms 是本地观测值的一个数量级余量，再慢就说明事务里多了一次全表读写。" },
    { metric: "throughput" as const, direction: "atLeast" as const, limit: 10, rationale: "单写者串行写入的下限；低于 10 次/秒意味着每次事务超过 100ms。" },
  ],
  "message-send": [
    { metric: "p95" as const, direction: "atMost" as const, limit: 300, rationale: "消息、会话与 outbox 在同一事务落库，还要与并行的 worker 争写锁；300ms 允许锁竞争，不允许退化成扫描。" },
    { metric: "throughput" as const, direction: "atLeast" as const, limit: 8, rationale: "并发 worker 在场时的下限：低于 8 次/秒说明两个写者互相饿死。" },
  ],
});
