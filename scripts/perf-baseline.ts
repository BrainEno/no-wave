/**
 * `pnpm perf:baseline` — 度量三条路径的延迟与吞吐（issue #64）。
 *
 *   pnpm perf:baseline              跑一次，打印报告；任何阈值不通过则 exit 1
 *   pnpm perf:baseline --json       同上，外加一份机器可读的结果
 *   pnpm perf:baseline --quick      缩小样本（本地随手看一眼时用）
 *
 * 它度量什么、为什么写入路径不走 HTTP，见 `lib/perf-scenarios.ts` 的注释；统计与
 * 阈值判定的算术见 `lib/perf-stats.ts`。这个文件只负责把它们接起来并**如实报告**：
 * 没跑成功的一步写 `✗`，而不是省略。
 *
 * 明确不做的两件事：
 *
 * 1. **不引入压测依赖。** autocannon 会拉进一棵依赖树，而这里打的是本机同进程的
 *    HTTP 与同一个适配器；`node:http` 足够，也不会因为多一层客户端缓冲而把服务端
 *    的排队算成网络延迟。
 * 2. **不声称这是商用容量。** 它测的是一台机器、一个进程、一个数据库文件上的成本。
 *    共享 CI runner 上的绝对数字不能搬到生产；它的用处是**回归**与**数量级判断**，
 *    报告与文档都这么写。
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { Agent, request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  BASELINE_THRESHOLDS,
  DEFAULT_PLAN,
  DEFAULT_SEED,
  seedAuthor,
  seedWork,
  type ScenarioPlan,
} from "./lib/perf-scenarios.ts";
import {
  checkThreshold,
  formatScenarioLine,
  ms,
  saturationPoint,
  summarize,
  throughput,
  type LadderRung,
  type LatencyStats,
} from "./lib/perf-stats.ts";

const repositoryRoot = join(import.meta.dirname, "..");
const apiSourceDirectory = join(repositoryRoot, "apps", "api", "src");

type Options = { json: boolean; quick: boolean };

function parseOptions(argv: readonly string[]): Options {
  return { json: argv.includes("--json"), quick: argv.includes("--quick") };
}

/** `--quick` 把样本砍到四分之一，但保留足够让 p99 不至于只是「最慢那一笔」。 */
function planWithScale(quick: boolean): ScenarioPlan[] {
  return DEFAULT_PLAN.map((plan) => (quick
    ? { ...plan, operations: Math.max(20, Math.round(plan.operations / 4)) }
    : { ...plan }));
}

/**
 * 一个复用连接的请求器。
 *
 * 用 `node:http` 而不是 `fetch`：这里要的是**这一次请求的墙钟时间**，而 fetch 会把
 * 连接池、keep-alive 与排队混在一起。默认**复用连接**，因为每次新建连接测到的是
 * 客户端与内核建立 TCP 连接的成本，而不是服务端处理一次请求的成本——在这个仓库上
 * 两者差了一个数量级（新建连接 48ms vs 复用 0.7ms），把它算进服务端延迟会让基线
 * 完全失去意义。报告里写明这一点。
 */
export function createKeepAliveRequester(maxSockets: number) {
  const agent = new Agent({ keepAlive: true, maxSockets });
  const request = (url: string): Promise<{ status: number; durationMs: number }> => new Promise((resolve, reject) => {
    const startedAt = performance.now();
    const outgoing = httpRequest(url, { method: "GET", agent }, (response) => {
      response.resume();
      response.on("end", () => resolve({ status: response.statusCode ?? 0, durationMs: performance.now() - startedAt }));
    });
    outgoing.on("error", reject);
    outgoing.setTimeout(30_000, () => outgoing.destroy(new Error(`request to ${url} timed out`)));
    outgoing.end();
  });
  return { request, close: () => agent.destroy() };
}

type ScenarioResult = {
  name: string;
  title: string;
  stats: LatencyStats;
  requestsPerSecond: number;
  concurrency: number;
  failures: number;
  /** 从数据库回读到的行数增量。写入路径必须有；读路径没有。 */
  persisted?: number;
  thresholds: ReturnType<typeof checkThreshold>[];
};

function judge(name: keyof typeof BASELINE_THRESHOLDS, stats: LatencyStats, requestsPerSecond: number): ReturnType<typeof checkThreshold>[] {
  return BASELINE_THRESHOLDS[name].map((threshold) =>
    checkThreshold({ p95: stats.p95, p99: stats.p99, mean: stats.mean, throughput: requestsPerSecond }, threshold));
}

/**
 * 跑一条 HTTP 读路径，并顺带给出**并发阶梯**。
 *
 * 阶梯是这份基线里最有用的一张表：单进程 Node 的读路径一旦被同步 SQLite 调用阻塞，
 * 吞吐会随并发**变平**而不是上升。平掉的位置就是单机读容量的上限，它比任何单个
 * p95 数字都更能说明「这台机器能扛多少」。
 *
 * 失败也计时但单独计数：把 500 混进延迟里而不报告，会让一条正在出错的路径看起来
 * 只是慢了一点。
 */
async function runHttpScenario(plan: ScenarioPlan, url: string): Promise<{ result: ScenarioResult; ladder: LadderRung[] }> {
  const { request, close } = createKeepAliveRequester(plan.concurrency);
  try {
    // Warm up through the same pool the measurement uses, so the first
    // request's statement preparation is not counted as tail latency.
    for (let index = 0; index < plan.warmup; index += 1) await request(url);

    const samples: number[] = [];
    let failures = 0;
    const startedAt = performance.now();
    await Promise.all(Array.from({ length: plan.concurrency }, async () => {
      for (let index = 0; index < plan.operations; index += 1) {
        const response = await request(url);
        if (response.status >= 400) { failures += 1; continue; }
        samples.push(response.durationMs);
      }
    }));
    const elapsed = performance.now() - startedAt;

    const ladder: LadderRung[] = [];
    const rungs = [...new Set([1, 2, 4, 8, plan.concurrency])].sort((a, b) => a - b);
    for (const concurrency of rungs) {
      const perLane = Math.max(10, Math.round(plan.operations / concurrency));
      const lane = createKeepAliveRequester(concurrency);
      for (let index = 0; index < 5; index += 1) await lane.request(url);
      const rungStart = performance.now();
      await Promise.all(Array.from({ length: concurrency }, async () => {
        for (let index = 0; index < perLane; index += 1) await lane.request(url);
      }));
      ladder.push({ concurrency, requestsPerSecond: throughput(concurrency * perLane, performance.now() - rungStart) });
      lane.close();
    }

    const stats = summarize(samples);
    const requestsPerSecond = throughput(samples.length, elapsed);
    return {
      ladder,
      result: {
        name: plan.name,
        title: plan.title,
        stats,
        requestsPerSecond,
        concurrency: plan.concurrency,
        failures,
        thresholds: judge(plan.name, stats, requestsPerSecond),
      },
    };
  } finally {
    close();
  }
}

/**
 * 在进程内跑一条写路径，用与 API 同一个适配器。
 *
 * 写**故意串行**：SQLite 只有一个写者，第二个「并发」写者测到的是排队，而不是
 * 服务端。并发写真正要验证的东西由并行的 outbox worker 提供。
 */
async function runWriteScenario(
  plan: ScenarioPlan,
  operation: () => Promise<void>,
  /** 回读数据库：返回某一行的当前计数，用来证明写入真的落库了。 */
  probe?: () => Promise<number>,
): Promise<ScenarioResult> {
  for (let index = 0; index < plan.warmup; index += 1) await operation();
  const before = probe ? await probe() : 0;
  const samples: number[] = [];
  let failures = 0;
  const startedAt = performance.now();
  for (let index = 0; index < plan.operations; index += 1) {
    const begin = performance.now();
    try {
      await operation();
      samples.push(performance.now() - begin);
    } catch {
      failures += 1;
    }
  }
  const elapsed = performance.now() - startedAt;
  const persisted = probe ? (await probe()) - before : undefined;
  const stats = summarize(samples);
  const requestsPerSecond = throughput(samples.length, elapsed);
  return {
    name: plan.name,
    title: plan.title,
    stats,
    requestsPerSecond,
    concurrency: plan.concurrency,
    failures,
    persisted,
    thresholds: judge(plan.name, stats, requestsPerSecond),
  };
}

type PortableStackModule = {
  startPortableStack(options: Record<string, unknown>): Promise<{ apiBaseUrl: string; webBaseUrl: string; processes: unknown[] }>;
  stopPortableStack(stack: { processes: unknown[] }): Promise<void>;
  freePort(): Promise<number>;
};

async function loadStack(): Promise<PortableStackModule> {
  return import(pathToFileURL(join(repositoryRoot, "scripts", "portable-stack.ts")).href) as Promise<PortableStackModule>;
}

/**
 * 一个并行的 outbox worker。
 *
 * 审计点名「outbox worker 与 API 在同一数据库上并发读写时表现未验证」，所以消息
 * 路径的压测必须在 worker 也在跑的时候进行。用真进程而不是进程内循环：锁争用发生
 * 在 SQLite 文件上，只有另一个连接才能制造它。
 */
function spawnWorker(databasePath: string): ChildProcess {
  return spawn(process.execPath, ["src/persistence/notification-worker.ts"], {
    cwd: join(repositoryRoot, "apps", "api"),
    env: {
      ...process.env,
      DATABASE_PROVIDER: "sqlite",
      DATABASE_PATH: databasePath,
      OUTBOX_POLL_INTERVAL_MS: "100",
    },
    stdio: "ignore",
  });
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
    child.kill("SIGTERM");
    setTimeout(() => { child.kill("SIGKILL"); resolve(); }, 5_000).unref();
  });
}

/**
 * 一个独立的只读连接，用来在压测之后回读行数。
 *
 * 必须是**另一个连接**：拿写路径自己的连接数行，测到的是适配器的内部状态，而不是
 * 「另一个读者能不能看见这些行」。SQLite 的 WAL 让这成为真实的并发读写检查。
 */
async function openCounter(databasePath: string): Promise<{ count(table: "articles" | "messages" | "outbox_events"): number; delivered(): number; close(): void }> {
  const { DatabaseSync } = await import("node:sqlite");
  const database = new DatabaseSync(databasePath, { readOnly: true });
  const statements = {
    articles: database.prepare("SELECT COUNT(*) AS total FROM articles"),
    messages: database.prepare("SELECT COUNT(*) AS total FROM messages"),
    outbox_events: database.prepare("SELECT COUNT(*) AS total FROM outbox_events"),
  };
  const deliveredOutbox = database.prepare("SELECT COUNT(*) AS total FROM outbox_events WHERE delivered_at IS NOT NULL");
  return {
    count(table) {
      const row = statements[table].get() as { total: number };
      return Number(row.total);
    },
    delivered() {
      const row = deliveredOutbox.get() as { total: number };
      return Number(row.total);
    },
    close() { database.close(); },
  };
}

async function openAdapter(databasePath: string) {
  process.env.DATABASE_PROVIDER = "sqlite";
  process.env.DATABASE_PATH = databasePath;
  const { createPersistenceRuntime } = await import(pathToFileURL(join(apiSourceDirectory, "infrastructure", "persistence-runtime.ts")).href);
  return createPersistenceRuntime({ provider: "sqlite", env: process.env });
}

/** 灌种子数据：作者、作品、一个会话。用真实的 SQLite 适配器，与 API 同一个文件。 */
async function seedDatabase(databasePath: string): Promise<{ authorIds: string[]; senderId: string; conversationId: string }> {
  const runtime = await openAdapter(databasePath);
  try {
    const authorIds: string[] = [];
    for (let index = 0; index < DEFAULT_SEED.authors; index += 1) {
      const author = seedAuthor(index);
      await runtime.adapter.upsertAuthorProfile(author);
      authorIds.push(author.userId);
    }
    for (let index = 0; index < DEFAULT_SEED.works; index += 1) {
      await runtime.adapter.createArticle(seedWork(index, authorIds[index % authorIds.length], null));
    }
    const senderId = authorIds[0];
    const conversation = await runtime.adapter.createConversation({ actorId: senderId, participantIds: [authorIds[1] ?? senderId] });
    return { authorIds, senderId, conversationId: conversation.id };
  } finally {
    await runtime.close();
  }
}

function report(
  results: ScenarioResult[],
  ladder: LadderRung[],
  out: { write(text: string): unknown },
  options: Options,
  drain: { undeliveredAtEnd: number; undeliveredAfterDrain: number },
): { ok: boolean; failed: string[] } {
  const line = (text: string) => out.write(`${text}\n`);
  line("");
  line("No Wave 容量基线（本机 / 单进程 / 单数据库文件）");
  line("这些数字用于回归与数量级判断，不是生产容量承诺。");
  line("读路径复用 keep-alive 连接；每次新建连接的成本属于客户端，不计入服务端延迟。");
  line("");

  const failed: string[] = [];
  for (const result of results) {
    line(formatScenarioLine(result.title, result.stats, result.requestsPerSecond, result.concurrency));
    if (result.failures > 0) {
      line(`  ✗ ${result.failures} 次操作失败，未计入延迟样本`);
      failed.push(`${result.name}: ${result.failures} failed operations`);
    }
    // A write that reports a latency but no rows is not a fast write — it is a
    // write that did not happen. This is the check that keeps a baseline from
    // being green against an adapter that silently no-ops.
    if (result.persisted !== undefined) {
      if (result.persisted < result.stats.count) {
        failed.push(`${result.name}: ${result.persisted} rows persisted, expected at least ${result.stats.count}`);
        line(`  ✗ 落库校验：只回读到 ${result.persisted} 行，至少应有 ${result.stats.count} 行`);
      } else {
        line(`  落库校验：回读到 ${result.persisted} 行`);
      }
    }
    for (const threshold of result.thresholds) {
      if (threshold.ok) continue;
      const shown = threshold.metric === "throughput" ? `${ms(threshold.actual)} req/s` : `${ms(threshold.actual)}ms`;
      const limit = threshold.metric === "throughput" ? `${threshold.limit} req/s` : `${threshold.limit}ms`;
      const comparison = threshold.direction === "atMost" ? "≤" : "≥";
      failed.push(`${result.name}: ${threshold.metric} ${shown} is not ${comparison} ${limit}`);
      line(`  ✗ ${threshold.metric} ${shown} 未达 ${comparison} ${limit}`);
      line(`    依据：${threshold.rationale}`);
    }
  }

  if (ladder.length > 0) {
    const point = saturationPoint(ladder);
    line("");
    line("并发阶梯（读路径，同一连接池）：");
    for (const rung of ladder) {
      line(`  c=${String(rung.concurrency).padStart(2)}  ${ms(rung.requestsPerSecond).toFixed(0).padStart(5)} req/s`);
    }
    const peak = Math.max(...ladder.map((rung) => rung.requestsPerSecond));
    if (!point.saturated) {
      line(`  未饱和：最高一格 c=${ladder[ladder.length - 1].concurrency} 仍在上升，本机上限高于此实测范围`);
    } else {
      line(`  饱和点 c=${point.concurrency} 已达峰值 ${ms(peak).toFixed(0)} req/s 的 85% 以上；并发翻倍不再带来吞吐增长，只增加排队延迟`);
    }
  }

  // The outbox half of the issue: the worker ran concurrently and must have kept
  // up. A backlog left behind after the drain window means the single writer is
  // not enough headroom for the write rate, which is exactly the capacity
  // ceiling the deployment guide needs to state.
  line("");
  line(`outbox 投递：压测结束时未投递 ${drain.undeliveredAtEnd} 条，等待 2s 后未投递 ${drain.undeliveredAfterDrain} 条`);
  if (drain.undeliveredAfterDrain > 0) {
    failed.push(`outbox worker left ${drain.undeliveredAfterDrain} events undelivered — the writer is outpacing the worker`);
    line(`  ✗ worker 未跟上写入速度：这是单机写容量的真实上限信号`);
  } else {
    line("  ✓ worker 与写路径并行运行，事件在同一时间窗内被排空");
  }

  line("");
  if (failed.length > 0) {
    line(`基线不通过（${failed.length} 项）：`);
    for (const failure of failed) line(`  - ${failure}`);
  } else {
    line("基线通过：所有路径都在阈值内。");
  }
  if (options.json) line(JSON.stringify({ scenarios: results, ladder, drain, failed }, null, 2));
  return { ok: failed.length === 0, failed };
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const directory = await mkdtemp(join(tmpdir(), "nw-perf-"));
  const databasePath = join(directory, "perf.sqlite");
  const stack = await loadStack();
  const apiPort = await stack.freePort();
  const webPort = await stack.freePort();
  let worker: ChildProcess | null = null;
  let started: { apiBaseUrl: string; webBaseUrl: string; processes: unknown[] } | null = null;
  try {
    started = await stack.startPortableStack({
      apiPort,
      webPort,
      databasePath,
      siteUrl: `http://127.0.0.1:${webPort}`,
      jwtSecret: randomBytes(32).toString("hex"),
      repositoryRoot,
    });
    process.stdout.write(`stack ready: API ${started.apiBaseUrl}\n`);

    const seeded = await seedDatabase(databasePath);
    process.stdout.write(`seeded ${DEFAULT_SEED.works} works across ${DEFAULT_SEED.authors} authors\n`);

    const plans = planWithScale(options.quick);
    const results: ScenarioResult[] = [];

    const read = await runHttpScenario(
      plans.find((plan) => plan.name === "public-page-read")!,
      `${started.apiBaseUrl}/api/v1/articles?locale=zh-CN&limit=20`,
    );
    results.push(read.result);

    // Writes run in-process against the same file the API is serving, with the
    // outbox worker draining it concurrently.
    const runtime = await openAdapter(databasePath);
    const counter = await openCounter(databasePath);
    worker = spawnWorker(databasePath);
    // Give the worker a moment to open the database, so the message path really
    // does contend with it instead of racing its startup.
    await new Promise((resolve) => setTimeout(resolve, 1_500));

    let writeIndex = 0;
    results.push(await runWriteScenario(
      plans.find((plan) => plan.name === "authenticated-write")!,
      async () => {
        const index = writeIndex;
        writeIndex += 1;
        await runtime.adapter.createArticle(seedWork(10_000 + index, seeded.authorIds[index % seeded.authorIds.length], null));
      },
      async () => counter.count("articles"),
    ));

    let messageIndex = 0;
    results.push(await runWriteScenario(
      plans.find((plan) => plan.name === "message-send")!,
      async () => {
        messageIndex += 1;
        await runtime.adapter.persistMessage({
          conversationId: seeded.conversationId,
          senderId: seeded.senderId,
          body: `基線消息 ${messageIndex}`,
          idempotencyKey: `perf-message-${messageIndex}-${randomUUID()}`,
        });
      },
      // The message row and its outbox event land in one transaction, so the
      // message count proves the write happened at all.
      async () => counter.count("messages"),
    ));

    // The worker ran the whole time; give it a moment to drain the last batch,
    // then prove it did. A worker that never consumed anything would leave every
    // event undelivered, and the message path would still look fast.
    const undeliveredAtEnd = (() => {
      const total = counter.count("outbox_events");
      return total - counter.delivered();
    })();
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    const undeliveredAfterDrain = counter.count("outbox_events") - counter.delivered();

    counter.close();
    await runtime.close();

    const outcome = report(results, read.ladder, process.stdout, options, { undeliveredAtEnd, undeliveredAfterDrain });
    process.exitCode = outcome.ok ? 0 : 1;
  } finally {
    if (worker) await stopChild(worker);
    if (started) await stack.stopPortableStack(started);
    await rm(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  await main();
}
