import { resolve } from "node:path";
import {
  AlertEvidenceFault,
  EVIDENCE_LIMITS,
} from "../application/alert-evidence.ts";
import { reviewAlertEvidence } from "../application/alert-evidence-review.ts";
import { compareAlertEvidence } from "../application/alert-evidence-compare.ts";
import { checkAlertEvidenceRequirements } from "../application/alert-evidence-requirements.ts";
import { traceAlertEvidence } from "../application/alert-evidence-trace.ts";
import { loadAlertEvidenceFiles } from "./alert-evidence-file.ts";
import { isMainModule } from "./entrypoint.ts";
import { writeOperationOutput } from "./operation-command-output.ts";

const HELP = `有限离线历史证据审阅：只使用独立分发的公钥，不联网、不加载 .env、不访问业务数据库。

ops:evidence review --trust <public-trust.json> --manifest <manifest.json> [--max-age-ms <1000..2592000000>]
ops:evidence compare --trust <public-trust.json> --before <before.json> --after <after.json> [--max-age-ms <1000..2592000000>]
ops:evidence check --trust <public-trust.json> --manifest <manifest.json> --requirements <requirements.json> [--max-age-ms <1000..2592000000>]
ops:evidence trace --trust <public-trust.json> --manifest <manifest.json> [--view events|findings] [--limit <1..128>] [--after <navigation-token>]
trace 可选 --stream、--batch-id、--event-id、--from-sequence、--through-sequence；events 另可用 --target、--rule、--transition、--from-at、--through-at；findings 另可用 --code、--severity。

清单只列本目录下相对 JSON 文件、batch/receipt 类型及原始字节 SHA256；不发现或信任清单中的公钥。
review 检查跨批次链、告警 episode 和多来源回执顺序；compare 同时审阅两侧及其并集，删除证据不是进展。
check 核验独立指定的已知批次/回执要求；要求文件不由清单选择，本身也不凭 hash 建立信任。
trace 分页定位已验证事件/完整发现，带已提供相邻事实与回执上下文；任何过滤都保留全量审阅及退出码。
导航 token 不签名、不授予权限，绑定确切证据/查询/结果；数据或查询改变须从第一页重读。
缺失前缀/回执和相互矛盾分开计数；历史证据不能证明不存在新尾部、当前健康、物理持久性或通知到人。
只读：不确认 monitor、不消费 inbox、不签发回执、不写文件或抢锁；多文件证据不是原子快照。
默认年龄预算 24 h，最多 30 d，仅用于提示历史证据过旧，不修改任何告警规则或时间。
每侧最多 256 个产物、8 MiB、8192 个事件；单产物 256 KiB。每个审阅/回退视图最多展示 128 条 findings 样本，总数完整保留。
配置/清单/产物须位于自有 0700 本地 POSIX 目录，文件私有、单 hardlink、无 symlink/FIFO。
退出码：0 无发现；1 有缺口/冲突/过旧或证据集回退；2 参数/信任/清单/要求错误；3 文件/签名/完整性/输出失败。
规程：docs/operations/alert-evidence.md
`;
type Command = {
  kind: "review" | "compare" | "check" | "trace";
  trace: Record<string, unknown>;
  requirements: string | null;
  trust: string;
  manifests: string[];
  maxAgeMs: number;
};
type Write = (text: string) => void | Promise<void>;
type Dependencies = {
  stdout?: Write;
  stderr?: Write;
  now?: () => number;
  signal?: AbortSignal;
};

function argumentsFor(args: readonly string[]): Command | null {
  if (args.length === 1 && args[0] === "--help") return null;
  const [kind, ...rest] = args;
  if (
    (kind !== "review" &&
      kind !== "compare" &&
      kind !== "check" &&
      kind !== "trace") ||
    rest.length % 2 !== 0
  )
    throw new AlertEvidenceFault("arguments_invalid");
  const required =
    kind === "compare"
      ? ["--trust", "--before", "--after"]
      : kind === "check"
        ? ["--trust", "--manifest", "--requirements"]
        : ["--trust", "--manifest"];
  const allowed = [
    ...required,
    "--max-age-ms",
    ...(kind === "trace"
      ? [
          "--view",
          "--stream",
          "--batch-id",
          "--event-id",
          "--target",
          "--rule",
          "--transition",
          "--from-at",
          "--through-at",
          "--from-sequence",
          "--through-sequence",
          "--code",
          "--severity",
          "--limit",
          "--after",
        ]
      : []),
  ];
  const fields = new Map<string, string>();
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index]!,
      value = rest[index + 1]!;
    if (
      !allowed.includes(key) ||
      fields.has(key) ||
      !value ||
      value.length > 4096 ||
      value.startsWith("--") ||
      /[\x00-\x1f\x7f]/.test(value)
    )
      throw new AlertEvidenceFault("arguments_invalid");
    fields.set(key, value);
  }
  if (required.some((key) => !fields.has(key)))
    throw new AlertEvidenceFault("arguments_invalid");
  const age =
    fields.get("--max-age-ms") ?? String(EVIDENCE_LIMITS.defaultAgeMs);
  if (
    !/^[1-9][0-9]{3,9}$/.test(age) ||
    Number(age) > EVIDENCE_LIMITS.maximumAgeMs
  )
    throw new AlertEvidenceFault("arguments_invalid");
  return {
    kind,
    trace: kind === "trace" ? traceArguments(fields) : {},
    requirements: fields.has("--requirements")
      ? resolve(fields.get("--requirements")!)
      : null,
    trust: resolve(fields.get("--trust")!),
    maxAgeMs: Number(age),
    manifests: (kind === "compare"
      ? ["--before", "--after"]
      : ["--manifest"]
    ).map((key) => resolve(fields.get(key)!)),
  };
}
function traceArguments(
  fields: ReadonlyMap<string, string>,
): Record<string, unknown> {
  const number = (name: string) => {
    const value = fields.get(name);
    if (value === undefined) return undefined;
    if (
      !/^(0|[1-9][0-9]{0,15})$/.test(value) ||
      !Number.isSafeInteger(Number(value))
    )
      throw new AlertEvidenceFault("arguments_invalid");
    return Number(value);
  };
  return {
    view: fields.get("--view"),
    streamId: fields.get("--stream"),
    targetId: fields.get("--target"),
    batchId: fields.get("--batch-id"),
    eventId: fields.get("--event-id"),
    rule: fields.get("--rule"),
    transition: fields.get("--transition"),
    code: fields.get("--code"),
    severity: fields.get("--severity"),
    after: fields.get("--after"),
    limit: number("--limit"),
    fromAt: number("--from-at"),
    throughAt: number("--through-at"),
    fromSequence: number("--from-sequence"),
    throughSequence: number("--through-sequence"),
  };
}
function checkSignal(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new AlertEvidenceFault("cancelled");
}
async function emit(write: Write, value: unknown): Promise<void> {
  const text = typeof value === "string" ? value : JSON.stringify(value) + "\n";
  if (Buffer.byteLength(text) > EVIDENCE_LIMITS.outputBytes)
    throw new AlertEvidenceFault("budget_exceeded");
  try {
    await write(text);
  } catch {
    throw new AlertEvidenceFault("output_failed");
  }
}

/** A separate entrypoint keeps public-only review independent of private
 * sender/inbox configs and journals. There is no mutation or network port. */
export async function runAlertEvidenceCommand(
  args: readonly string[],
  dependencies: Dependencies = {},
): Promise<number> {
  const stdout =
    dependencies.stdout ??
    ((text) => writeOperationOutput(process.stdout, text));
  const stderr =
    dependencies.stderr ??
    ((text) => writeOperationOutput(process.stderr, text));
  try {
    const command = argumentsFor(args);
    if (command === null) {
      await emit(stdout, HELP);
      return 0;
    }
    checkSignal(dependencies.signal);
    const now = (dependencies.now ?? Date.now)();
    const loaded = loadAlertEvidenceFiles(command.trust, command.manifests, {
      signal: dependencies.signal,
      requirementsPath: command.requirements ?? undefined,
    });
    const options = { now, maxAgeMs: command.maxAgeMs };
    const input = loaded.collections[0]!.inputs;
    let report: { exitCode: 0 | 1 };
    switch (command.kind) {
      case "review":
        report = reviewAlertEvidence(loaded.trust, input, options);
        break;
      case "compare":
        report = compareAlertEvidence(
          loaded.trust,
          input,
          loaded.collections[1]!.inputs,
          options,
        );
        break;
      case "check":
        report = checkAlertEvidenceRequirements(
          loaded.trust,
          input,
          loaded.requirements,
          options,
        );
        break;
      case "trace":
        report = traceAlertEvidence(
          loaded.trust,
          input,
          command.trace,
          options,
        );
        break;
    }
    checkSignal(dependencies.signal);
    await emit(stdout, { ...report, snapshot: loaded.snapshot });
    return report.exitCode;
  } catch (error) {
    const code = error instanceof AlertEvidenceFault ? error.code : "file_io";
    try {
      await emit(stderr, { version: 1, event: "alert_evidence_error", code });
    } catch {
      // Never fall back to raw exceptions, paths, trust keys or artifact bytes.
    }
    return code === "arguments_invalid" ||
      code === "trust_invalid" ||
      code === "manifest_invalid" ||
      code === "requirements_invalid" ||
      code === "cursor_invalid"
      ? 2
      : 3;
  }
}
export async function alertEvidenceMain(
  args = process.argv.slice(2),
): Promise<number> {
  const controller = new AbortController(),
    stop = () => controller.abort();
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  try {
    return await runAlertEvidenceCommand(args, { signal: controller.signal });
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
}
// Explicit finite exit also bounds a full libuv stdout pipe after its callback
// deadline. This module has no journal to commit or lock to release.
if (isMainModule(import.meta.url)) process.exit(await alertEvidenceMain());
