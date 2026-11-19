import { resolve } from "node:path";
import {
  acknowledgeMonitorEvents,
  assertMonitorEvaluationTime,
  evaluateMonitor,
} from "../application/operational-alerts.ts";
import { emptyMonitorState } from "../application/operational-monitor-state.ts";
import { monitorStatus } from "../application/operational-monitor-status.ts";
import { MonitorFault, type MonitorFaultCode } from "../application/operational-monitor.ts";
import { collectMonitorTargets } from "./monitor-scrape.ts";
import { openMonitorJournal, readMonitorConfigFile, readMonitorJournal } from "./monitor-state-file.ts";
import { isMainModule } from "./entrypoint.ts";
import { writeOperationOutput } from "./operation-command-output.ts";

const HELP = `有限只读运维监测，不启动后台进程、不自动修复、不向外部告警服务发送数据。

ops:monitor check --config <config.json> --state <private-directory/alerts.json>
ops:monitor inspect --config <config.json> --state <private-directory/alerts.json>
ops:monitor status --config <config.json> --state <private-directory/alerts.json>
ops:monitor ack --config <config.json> --state <private-directory/alerts.json> --through <event-id>
ops:monitor reconfigure --config <old.json> --next-config <new.json> --state <private-directory/alerts.json>

check: 仅 GET 显式配置的 metrics；状态提交后输出全部未确认事件。
inspect: 不访问端点、不修改状态；成功只代表读取完成，不是服务健康证明。
status: 离线检查最后观测的新鲜度；过期绿灯变 unknown，但不清除告警或确认事件。
ack: 只有下游已可靠接收后才确认精确事件前缀；不会修复服务或清除活跃条件。
reconfigure: 离线锁内切换配置；须先交付全部事件，禁止移除或重绑定活跃告警目标。

状态父目录须由当前用户拥有、权限 0700、无符号链接，并位于本地 POSIX 文件系统。
退出码：0 检查无异常/命令成功；1 告警或待确认事件；2 参数/配置错误；3 未知/运维失败。
完整边界：docs/operations/operational-monitor.md
`;
type Command = {
  name: "check" | "inspect" | "status" | "ack" | "reconfigure";
  config: string;
  state: string;
  through: string | null;
  nextConfig: string | null;
};
type Write = (text: string) => void | Promise<void>;
type Dependencies = {
  stdout?: Write;
  stderr?: Write;
  signal?: AbortSignal;
  now?: () => number;
  collect?: typeof collectMonitorTargets;
};

function argumentsValue(args: readonly string[]): Command | null {
  if (args.length === 1 && args[0] === "--help") return null;
  const [name, ...options] = args;
  if (!["check", "inspect", "status", "ack", "reconfigure"].includes(name ?? "") || options.length % 2 !== 0)
    throw new MonitorFault("arguments_invalid");
  const fields = new Map<string, string>();
  for (let index = 0; index < options.length; index += 2) {
    const key = options[index]!,
      value = options[index + 1]!;
    if (
      !["--config", "--state", "--through", "--next-config"].includes(key) ||
      fields.has(key) ||
      !value ||
      value.startsWith("--") ||
      value.length > 4096 ||
      /[\x00-\x1f\x7f]/.test(value)
    ) {
      throw new MonitorFault("arguments_invalid");
    }
    fields.set(key, value);
  }
  const config = fields.get("--config"),
    state = fields.get("--state"),
    through = fields.get("--through") ?? null;
  if (
    !config ||
    !state ||
    (name === "ack") !== (through !== null) ||
    (through !== null && !/^[a-f0-9]{64}$/.test(through))
  )
    throw new MonitorFault("arguments_invalid");
  const next = fields.get("--next-config") ?? null;
  if ((name === "reconfigure") !== (next !== null)) throw new MonitorFault("arguments_invalid");
  const configPath = resolve(config),
    statePath = resolve(state),
    nextConfig = next === null ? null : resolve(next);
  for (const input of [configPath, nextConfig]) {
    if (input !== null && (input === statePath || input === statePath + ".lock" || statePath === input + ".lock"))
      throw new MonitorFault("arguments_invalid");
  }
  return { name: name as Command["name"], config: configPath, state: statePath, through, nextConfig };
}

async function emit(write: Write, value: unknown): Promise<void> {
  try {
    await write(typeof value === "string" ? value : JSON.stringify(value) + "\n");
  } catch {
    throw new MonitorFault("output_failed");
  }
}

export async function runMonitorCommand(args: readonly string[], dependencies: Dependencies = {}): Promise<number> {
  const stdout = dependencies.stdout ?? ((text) => writeOperationOutput(process.stdout, text));
  const stderr = dependencies.stderr ?? ((text) => writeOperationOutput(process.stderr, text));
  const now = dependencies.now ?? Date.now;
  const collect = dependencies.collect ?? collectMonitorTargets;
  const signal = dependencies.signal;
  try {
    const command = argumentsValue(args);
    if (!command) {
      await emit(stdout, HELP);
      return 0;
    }
    if (signal?.aborted) throw new MonitorFault("cancelled");
    const config = readMonitorConfigFile(command.config);
    if (command.name === "inspect" || command.name === "status") {
      const state = readMonitorJournal(command.state, config);
      if (!state) throw new MonitorFault("state_missing");
      if (command.name === "status") {
        const report = monitorStatus(config, state, now());
        await emit(stdout, report);
        return report.exitCode;
      }
      await emit(stdout, {
        version: 1,
        event: "monitor_inspect",
        revision: state.revision,
        lastEvaluatedAt: state.lastEvaluatedAt,
        acknowledgedThrough: state.acknowledgedThrough,
        lastConfigurationChange: state.lastConfigurationChange,
        unacknowledged: state.events.length,
        events: state.events,
        targets: state.targets.map((target) => ({
          id: target.id,
          lastSampleAt: target.lastSampleAt,
          counterSamples: target.history.length,
          observedWindowMs: target.history.length > 1 ? target.history.at(-1)!.at - target.history[0]!.at : 0,
          rules: target.rules.map((rule) => ({ ...rule })),
        })),
      });
      return 0;
    }
    const nextConfig = command.nextConfig === null ? null : readMonitorConfigFile(command.nextConfig);
    const journal = openMonitorJournal(command.state, config);
    let output: unknown;
    let exitCode = 0;
    try {
      const previous = journal.state;
      if (command.name === "reconfigure") {
        if (signal?.aborted) throw new MonitorFault("cancelled");
        const result = journal.reconfigure(nextConfig!, now());
        output = {
          version: 1,
          event: "monitor_reconfigure",
          changed: result.changed,
          revision: result.state.revision,
          previousFingerprint: config.fingerprint,
          fingerprint: nextConfig!.fingerprint,
          lastConfigurationChange: result.state.lastConfigurationChange,
          added: result.added,
          removed: result.removed,
          sourcesReset: result.sourcesReset,
          rulesReset: result.rulesReset,
        };
      } else if (command.name === "ack") {
        if (!previous) throw new MonitorFault("state_missing");
        const result = acknowledgeMonitorEvents(config, previous, command.through!);
        if (signal?.aborted) throw new MonitorFault("cancelled");
        journal.commit(result.state);
        output = {
          version: 1,
          event: "monitor_ack",
          revision: result.state.revision,
          through: command.through,
          acknowledged: result.acknowledged,
          remaining: result.state.events.length,
        };
      } else {
        const startedAt = now();
        assertMonitorEvaluationTime(config, previous ?? emptyMonitorState(config), startedAt);
        const observations = await collect(config, signal);
        if (signal?.aborted) throw new MonitorFault("cancelled");
        const evaluatedAt = now();
        if (evaluatedAt < startedAt) throw new MonitorFault("clock_rollback");
        const result = evaluateMonitor(config, previous, observations, evaluatedAt);
        if (signal?.aborted) throw new MonitorFault("cancelled");
        journal.commit(result.state);
        output = result.report;
        exitCode = result.report.exitCode;
      }
    } finally {
      journal.close();
    }
    await emit(stdout, output);
    return exitCode;
  } catch (error) {
    const code: MonitorFaultCode = error instanceof MonitorFault ? error.code : "state_io";
    try {
      await emit(stderr, { version: 1, event: "monitor_error", code });
    } catch {
      /* no raw exception, path, response or fallback console dump */
    }
    return code === "arguments_invalid" || code === "config_invalid" ? 2 : 3;
  }
}

export async function monitorMain(args = process.argv.slice(2)): Promise<number> {
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  try {
    return await runMonitorCommand(args, { signal: controller.signal });
  } finally {
    process.off("SIGTERM", stop);
    process.off("SIGINT", stop);
  }
}
// All owned transports/locks and stream callbacks are awaited above. A failed
// OS write can leave a libuv file request alive even after destroy(); only this
// finite CLI entry exits explicitly. Imported callers retain their own loop.
if (isMainModule(import.meta.url)) process.exit(await monitorMain());
