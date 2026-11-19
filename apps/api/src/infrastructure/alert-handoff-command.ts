import { resolve } from "node:path";
import { acknowledgeMonitorEvents } from "../application/operational-alerts.ts";
import { MonitorFault } from "../application/operational-monitor.ts";
import {
  HandoffFault,
  HANDOFF_HASH,
  HANDOFF_UUID,
  handoffHash,
  type HandoffFaultCode,
} from "../application/alert-handoff-protocol.ts";
import {
  assertHandoffMonitorPrefix,
  prepareAlertHandoff,
  settleAlertHandoff,
} from "../application/alert-handoff-sender.ts";
import {
  acceptAlertHandoff,
  consumeAlertInbox,
} from "../application/alert-handoff-inbox.ts";
import {
  openHandoffInboxFile,
  openHandoffSenderFile,
  publishHandoffArtifact,
  publishHandoffProfile,
  readHandoffArtifact,
  readHandoffConfig,
  readHandoffInboxFile,
  readHandoffSenderFile,
} from "./alert-handoff-file.ts";
import {
  openMonitorJournal,
  readMonitorConfigFile,
  readMonitorJournal,
} from "./monitor-state-file.ts";
import { PrivateOperationFault } from "./private-operation-file.ts";
import { writeOperationOutput } from "./operation-command-output.ts";
import { isMainModule } from "./entrypoint.ts";
import {
  handoffVerificationDocument,
  verifyAlertHandoffEvidence,
} from "../application/alert-handoff-verification.ts";
import {
  readAlertInboxPage,
  recoverAlertReceipt,
} from "../application/alert-handoff-reader.ts";
import { reconcileAlertHandoff } from "../application/alert-handoff-reconcile.ts";
import {
  alertSenderStatus,
  alertInboxStatus,
  HANDOFF_DEFAULT_PENDING_BUDGET_MS,
} from "../application/alert-handoff-status.ts";

const HELP = `有限离线告警交接：不联网、不加载 .env、不访问业务数据库、不安装调度器。

ops:handoff prepare --config <sender.json> --state <sender-state.json> --monitor-config <monitor.json> --monitor-state <alerts.json> --output <batch.json>
ops:handoff settle --config <sender.json> --state <sender-state.json> --monitor-config <monitor.json> --monitor-state <alerts.json> --receipt <receipt.json>
ops:handoff sender-status --config <sender.json> --state <sender-state.json> --monitor-config <monitor.json> --monitor-state <alerts.json>
ops:handoff receive --config <inbox.json> --state <inbox-state.json> --batch <batch.json> --output <receipt.json>
ops:handoff inbox-read --config <inbox.json> --state <inbox-state.json> [--limit <1..256>] [--after <cursor>]
ops:handoff inbox-status --config <inbox.json> --state <inbox-state.json>
ops:handoff consume --config <inbox.json> --state <inbox-state.json> --through <entry-id>
ops:handoff receipt --config <inbox.json> --state <inbox-state.json> --stream <uuid> --sequence <n> --batch-id <id> --output <receipt.json>
ops:handoff reconcile --config <sender.json> --state <sender-state.json> --monitor-config <monitor.json> --monitor-state <alerts.json> --inbox-config <inbox.json> --inbox-state <inbox-state.json>
ops:handoff profile --config <sender.json> --output <public-profile.json>
ops:handoff verify --config <public-profile.json> --batch <batch.json> [--receipt <receipt.json>]
两个 status 命令接受可选 --max-pending-age-ms <1000..86400000>，默认 3600000。

prepare 冻结全部未确认事件；事件包发布失败不删除交接意图。接收不代表有人收到通知。
receive 验证来源签名并先持久化 inbox，再发布独立签名回执；相同批次重试不重复入箱。
settle 是显式授权：验证回执后，只确认原监测日志中匹配的精确前缀，不清除告警条件。
consume 只确认接收箱中已由下游处理的精确前缀；不修改 monitor 或签发新的接收证明。
receipt 只重新发布指定来源最近一份已持久化回执；更早回执不会凭空重建。
reconcile 只比较离线快照证据，不是跨主机原子快照、服务健康证明或自动修复。
profile 只导出双方公钥 pin；verify 不需要私钥，只验证历史证据签名，不作健康声明。
分页 cursor 绑定精确快照；入箱/消费改变 revision 后须重新从第一页开始。
私有配置/日志/产物均需当前 UID 拥有、0600 文件与 0700 本地 POSIX 目录。
退出码：0 命令成功；1 status 有待处理项；2 参数/配置错误；3 运维/完整性失败。
规程：docs/operations/alert-handoff.md
`;
type CommandName =
  | "prepare"
  | "settle"
  | "sender-status"
  | "receive"
  | "inbox-read"
  | "inbox-status"
  | "consume"
  | "reconcile"
  | "receipt"
  | "profile"
  | "verify";
type Command = {
  name: CommandName;
  paths: Map<string, string>;
  limit: number;
  through: string | null;
  continuation: string | null;
  maxPendingAgeMs: number;
  streamId: string | null;
  sequence: number | null;
  batchId: string | null;
};
type Write = (text: string) => void | Promise<void>;
type Dependencies = {
  stdout?: Write;
  stderr?: Write;
  now?: () => number;
  signal?: AbortSignal;
};
const BASE = ["--config", "--state"];
const SOURCE = [...BASE, "--monitor-config", "--monitor-state"];
const REQUIRED: Record<CommandName, readonly string[]> = {
  prepare: [...SOURCE, "--output"],
  settle: [...SOURCE, "--receipt"],
  "sender-status": SOURCE,
  receive: [...BASE, "--batch", "--output"],
  "inbox-read": BASE,
  "inbox-status": BASE,
  consume: [...BASE, "--through"],
  reconcile: [...SOURCE, "--inbox-config", "--inbox-state"],
  receipt: [...BASE, "--stream", "--sequence", "--batch-id", "--output"],
  profile: ["--config", "--output"],
  verify: ["--config", "--batch"],
};
function commandArguments(args: readonly string[]): Command | null {
  if (args.length === 1 && args[0] === "--help") return null;
  const [name, ...rest] = args;
  if (!name || !Object.hasOwn(REQUIRED, name) || rest.length % 2 !== 0)
    throw new HandoffFault("arguments_invalid");
  const kind = name as CommandName,
    required = REQUIRED[kind];
  const optional =
    kind === "inbox-read"
      ? ["--limit", "--after"]
      : kind === "sender-status" || kind === "inbox-status"
        ? ["--max-pending-age-ms"]
        : kind === "verify"
          ? ["--receipt"]
          : [];
  const allowed = [...required, ...optional];
  const fields = new Map<string, string>();
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index]!,
      value = rest[index + 1]!;
    if (
      !allowed.includes(key) ||
      fields.has(key) ||
      !value ||
      value.startsWith("--") ||
      value.length > 4096 ||
      /[\x00-\x1f\x7f]/.test(value)
    )
      throw new HandoffFault("arguments_invalid");
    fields.set(key, value);
  }
  if (required.some((key) => !fields.has(key)))
    throw new HandoffFault("arguments_invalid");
  const through = fields.get("--through") ?? null;
  if (through !== null && !HANDOFF_HASH.test(through))
    throw new HandoffFault("arguments_invalid");
  const limitText = fields.get("--limit") ?? "100";
  if (!/^[1-9][0-9]{0,2}$/.test(limitText) || Number(limitText) > 256)
    throw new HandoffFault("arguments_invalid");
  const budgetText =
    fields.get("--max-pending-age-ms") ??
    String(HANDOFF_DEFAULT_PENDING_BUDGET_MS);
  if (
    !/^[1-9][0-9]{0,7}$/.test(budgetText) ||
    Number(budgetText) < 1000 ||
    Number(budgetText) > 86400000
  )
    throw new HandoffFault("arguments_invalid");
  const continuation = fields.get("--after") ?? null;
  if (continuation !== null && continuation.length > 2048)
    throw new HandoffFault("arguments_invalid");
  const streamId = fields.get("--stream") ?? null,
    sequenceText = fields.get("--sequence") ?? null,
    batchId = fields.get("--batch-id") ?? null;
  if (
    (streamId !== null && !HANDOFF_UUID.test(streamId)) ||
    (batchId !== null && !HANDOFF_HASH.test(batchId)) ||
    (sequenceText !== null &&
      (!/^[1-9][0-9]{0,15}$/.test(sequenceText) ||
        !Number.isSafeInteger(Number(sequenceText))))
  )
    throw new HandoffFault("arguments_invalid");
  const nonPaths = new Set([
    "--through",
    "--limit",
    "--after",
    "--max-pending-age-ms",
    "--stream",
    "--sequence",
    "--batch-id",
  ]);
  const paths = new Map(
    [...fields]
      .filter(([key]) => !nonPaths.has(key))
      .map(([key, path]) => [key, resolve(path)]),
  );
  const values = [...paths.values()];
  for (let index = 0; index < values.length; index++)
    for (let next = index + 1; next < values.length; next++) {
      if (
        values[index] === values[next] ||
        values[index] + ".lock" === values[next] ||
        values[next] + ".lock" === values[index]
      )
        throw new HandoffFault("arguments_invalid");
    }
  return {
    name: kind,
    paths,
    limit: Number(limitText),
    through,
    continuation,
    maxPendingAgeMs: Number(budgetText),
    streamId,
    sequence: sequenceText === null ? null : Number(sequenceText),
    batchId,
  };
}
function checkSignal(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new HandoffFault("cancelled");
}
async function emit(write: Write, value: unknown): Promise<void> {
  try {
    await write(
      typeof value === "string" ? value : JSON.stringify(value) + "\n",
    );
  } catch {
    throw new HandoffFault("output_failed");
  }
}
function faultCode(error: unknown): HandoffFaultCode {
  if (error instanceof HandoffFault || error instanceof PrivateOperationFault)
    return error.code;
  if (error instanceof MonitorFault) {
    if (
      [
        "config_invalid",
        "state_config_mismatch",
        "state_io",
        "state_locked",
        "state_missing",
        "state_invalid",
        "state_full",
      ].includes(error.code)
    )
      return error.code as HandoffFaultCode;
  }
  return "state_io";
}

/** Finite, explicitly offline transfer. The sender lock serializes prepare and
 * settle; monitor transactions acquire their own lock only for exact-prefix
 * acknowledgement. No command acquires these locks in the opposite order. */
export async function runAlertHandoffCommand(
  args: readonly string[],
  dependencies: Dependencies = {},
): Promise<number> {
  const stdout =
    dependencies.stdout ??
    ((text) => writeOperationOutput(process.stdout, text));
  const stderr =
    dependencies.stderr ??
    ((text) => writeOperationOutput(process.stderr, text));
  const now = dependencies.now ?? Date.now,
    signal = dependencies.signal;
  try {
    const command = commandArguments(args);
    if (command === null) {
      await emit(stdout, HELP);
      return 0;
    }
    checkSignal(signal);
    const path = (name: string) => command.paths.get(name)!;
    let output: unknown,
      exit = 0;
    if (command.name === "profile") {
      const sender = readHandoffConfig(path("--config"), "sender");
      const document = handoffVerificationDocument(sender);
      checkSignal(signal);
      publishHandoffProfile(path("--output"), document);
      output = {
        version: 1,
        event: "alert_handoff_profile",
        streamId: sender.streamId,
        receiverId: sender.receiverId,
      };
    } else if (command.name === "verify") {
      const profile = readHandoffConfig(path("--config"), "verify");
      const batch = readHandoffArtifact(path("--batch"));
      const receipt = command.paths.has("--receipt")
        ? readHandoffArtifact(path("--receipt"))
        : null;
      output = verifyAlertHandoffEvidence(profile, batch, receipt, now());
    } else if (
      ["prepare", "settle", "sender-status", "reconcile"].includes(command.name)
    ) {
      const config = readHandoffConfig(path("--config"), "sender");
      const monitorConfig = readMonitorConfigFile(path("--monitor-config"));
      const binding = handoffHash([
        path("--monitor-config"),
        path("--monitor-state"),
      ]);
      if (command.name === "reconcile") {
        const receiver = readHandoffConfig(path("--inbox-config"), "inbox");
        const report = reconcileAlertHandoff({
          senderConfig: config,
          senderState: readHandoffSenderFile(path("--state"), config, binding),
          sourceBinding: binding,
          inboxConfig: receiver,
          inboxState: readHandoffInboxFile(path("--inbox-state"), receiver),
          monitorConfig,
          monitorState: readMonitorJournal(
            path("--monitor-state"),
            monitorConfig,
          ),
          now: now(),
        });
        output = report;
        exit = report.exitCode;
      } else if (command.name === "sender-status") {
        const state = readHandoffSenderFile(path("--state"), config, binding);
        if (state === null) throw new HandoffFault("state_missing");
        const monitor = readMonitorJournal(
          path("--monitor-state"),
          monitorConfig,
        );
        if (monitor === null) throw new HandoffFault("state_missing");
        const report = alertSenderStatus(
          config,
          state,
          binding,
          monitor,
          now(),
          command.maxPendingAgeMs,
        );
        output = report;
        exit = report.exitCode;
      } else {
        // Validate artifacts before opening a mutable journal. Signatures are
        // verified by settlement against the persisted intent, never by ID alone.
        const receipt =
          command.name === "settle"
            ? readHandoffArtifact(path("--receipt"))
            : null;
        const journal = openHandoffSenderFile(path("--state"), config, binding);
        try {
          if (command.name === "prepare") {
            const monitor = readMonitorJournal(
              path("--monitor-state"),
              monitorConfig,
            );
            if (monitor === null) throw new HandoffFault("state_missing");
            const result = prepareAlertHandoff(
              config,
              journal.state,
              monitor,
              binding,
              now(),
            );
            checkSignal(signal);
            if (result.state !== null) journal.commit(result.state);
            if (result.batch !== null) {
              checkSignal(signal);
              publishHandoffArtifact(path("--output"), result.batch);
            }
            output = {
              version: 1,
              event: "alert_handoff_prepared",
              prepared: result.batch !== null,
              batchId: result.batch?.id ?? null,
              sequence: result.batch?.sequence ?? null,
              count: result.batch?.events.length ?? 0,
            };
          } else {
            if (journal.state === null) throw new HandoffFault("state_missing");
            const result = await settleAlertHandoff(
              config,
              journal.state,
              receipt,
              {
                persist(state) {
                  checkSignal(signal);
                  journal.commit(state);
                },
                acknowledge(batch) {
                  checkSignal(signal);
                  const monitorJournal = openMonitorJournal(
                    path("--monitor-state"),
                    monitorConfig,
                  );
                  try {
                    const monitor = monitorJournal.state;
                    if (monitor === null)
                      throw new HandoffFault("state_missing");
                    const count = assertHandoffMonitorPrefix(batch, monitor);
                    if (count === 0) return 0;
                    const acknowledged = acknowledgeMonitorEvents(
                      monitorConfig,
                      monitor,
                      batch.events.at(-1)!.id,
                    );
                    checkSignal(signal);
                    monitorJournal.commit(acknowledged.state);
                    return acknowledged.acknowledged;
                  } finally {
                    monitorJournal.close();
                  }
                },
              },
            );
            output = {
              version: 1,
              event: "alert_handoff_settled",
              sequence: result.state.sequence,
              batchId: result.state.lastBatchId,
              acknowledged: result.acknowledged,
              duplicate: result.duplicate,
            };
          }
        } finally {
          journal.close();
        }
      }
    } else {
      const config = readHandoffConfig(path("--config"), "inbox");
      if (
        command.name === "inbox-read" ||
        command.name === "inbox-status" ||
        command.name === "receipt"
      ) {
        const state = readHandoffInboxFile(path("--state"), config);
        if (state === null) throw new HandoffFault("state_missing");
        if (command.name === "inbox-read") {
          output = readAlertInboxPage(
            config,
            state,
            command.limit,
            command.continuation,
          );
        } else if (command.name === "receipt") {
          const receipt = recoverAlertReceipt(
            config,
            state,
            command.streamId!,
            command.sequence!,
            command.batchId!,
          );
          checkSignal(signal);
          publishHandoffArtifact(path("--output"), receipt);
          output = {
            version: 1,
            event: "alert_receipt_recovered",
            batchId: receipt.batchId,
            sequence: receipt.sequence,
            count: receipt.count,
          };
        } else {
          const report = alertInboxStatus(
            config,
            state,
            now(),
            command.maxPendingAgeMs,
          );
          output = report;
          exit = report.exitCode;
        }
      } else {
        const batch =
          command.name === "receive"
            ? readHandoffArtifact(path("--batch"))
            : null;
        const journal = openHandoffInboxFile(path("--state"), config);
        try {
          if (command.name === "receive") {
            const result = acceptAlertHandoff(
              config,
              journal.state,
              batch,
              now(),
            );
            checkSignal(signal);
            journal.commit(result.state);
            checkSignal(signal);
            publishHandoffArtifact(path("--output"), result.receipt);
            output = {
              version: 1,
              event: "alert_handoff_received",
              batchId: result.receipt.batchId,
              sequence: result.receipt.sequence,
              count: result.receipt.count,
              duplicate: result.duplicate,
              pending: result.state.entries.length,
            };
          } else {
            if (journal.state === null) throw new HandoffFault("state_missing");
            const result = consumeAlertInbox(
              config,
              journal.state,
              command.through!,
              now(),
            );
            checkSignal(signal);
            journal.commit(result.state);
            output = {
              version: 1,
              event: "alert_inbox_consumed",
              consumed: result.consumed,
              through: command.through,
              remaining: result.state.entries.length,
            };
          }
        } finally {
          journal.close();
        }
      }
    }
    await emit(stdout, output);
    return exit;
  } catch (error) {
    const code = faultCode(error);
    try {
      await emit(stderr, { version: 1, event: "alert_handoff_error", code });
    } catch {
      /* no raw exception, path, artifact, key material or fallback dump */
    }
    return code === "arguments_invalid" || code === "config_invalid" ? 2 : 3;
  }
}
export async function alertHandoffMain(
  args = process.argv.slice(2),
): Promise<number> {
  const controller = new AbortController(),
    stop = () => controller.abort();
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  try {
    return await runAlertHandoffCommand(args, { signal: controller.signal });
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
}
// Await owned journals and bounded stream callbacks, then terminate this finite
// entry only. A blocked libuv stdout write must not keep the CLI alive forever.
if (isMainModule(import.meta.url)) process.exit(await alertHandoffMain());
