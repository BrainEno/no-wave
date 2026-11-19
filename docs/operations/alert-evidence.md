# 离线告警历史证据：只读审阅、比较、检查点与追踪

对应 [ADR 0044](../architecture/decisions/0044-public-only-alert-evidence-review.md)。
输入是[离线交接](alert-handoff.md)已产生的 v1 batch/receipt，不需要 sender/inbox
私钥、journal、运行中的 API、数据库或网络。本命令不加载 `.env`，不会 ack、settle、
consume、重投、抢锁、修链、创建或重写任何文件。仅显式运行时执行一次后退出。

**验签正确、没有发现、集合扩展，都不是当前健康、通知到人、消费完成或生产就绪。**
没有生产接线、外部账号、定时器或监控自身失联验收；#331 仍开放。

## 1. 独立信任与输入准备

操作者先通过独立可信通道核对 v1 verify profiles 的 stream/receiver/双方公钥。
既有 `ops:handoff profile` 可在各自受控角色导出 profile；不要向审阅工作站复制私钥
或私有配置。只有公钥也仍需受限保存运维事件、身份及时间，不要上传公共 issue。

显式指定的 `public-trust.json` 是 closed schema：

```json
{
  "version": 1,
  "role": "evidence-review",
  "profiles": [
    {
      "version": 1,
      "role": "verify",
      "streamId": "<独立核对的 UUID v4>",
      "receiverId": "<独立核对的 receiver UUID v4>",
      "senderKey": "<canonical base64 Ed25519 SPKI DER>",
      "receiverKey": "<canonical base64 Ed25519 SPKI DER>"
    }
  ]
}
```

这是结构说明，尖括号不是可运行值。profiles 为 1–16 个，来源及 sender key 唯一，
receiver 身份/key 全部相同，双方不能共用 key。沿用原 profile 的严格解析，不能
加 signingKey、URL、算法、环境变量或其他字段；manifest/产物里的 key 不建立信任。

所有输入需在当前 UID 拥有、无 symlink 的私有 0700 本地 POSIX 目录，文件为自有
regular file、私有权限、单 hardlink。manifest 内路径限 1–4 段 ASCII 安全名称，
以 `.json` 结尾，位于该 manifest 目录之下；不允许绝对路径、`..`、空段、反斜线、
glob、URL、环境展开或控制文件别名。不会发现“同目录其他证据”。

manifest 严格为 `{version:1, artifacts:[{kind,file,sha256}]}`；kind 仅 batch/receipt，
sha256 为实际文件**原始字节**的 lowercase SHA-256。修改空格/换行也必须重新核对
原始 digest。空清单可审阅，但缺少固定来源会返回 gap，不是健康空箱。

下面仅在**隔离演练的新私有目录**创建清单；显式列出已保存的两个产物，不扫描归档，
也不读取/生成 trust 或 requirements。create-only 失败时保留旧文件，不自动覆盖。
`EVIDENCE_DIRECTORY` 由操作者设置为自己的绝对路径。

```sh
node --input-type=module-typescript <<'NODE'
import { createHash } from "node:crypto";
import { lstatSync, realpathSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
const directory = process.env.EVIDENCE_DIRECTORY!;
if (!directory || !isAbsolute(directory)) throw new Error("absolute private directory required");
const stat = lstatSync(directory);
if (!stat.isDirectory() || realpathSync(directory) !== directory ||
    stat.uid !== process.getuid!() || (stat.mode & 0o077) !== 0) throw new Error("private directory required");
const artifacts = [
  {kind:"batch", file:"batch-1.json"},
  {kind:"receipt", file:"receipt-1.json"},
].map((item) => ({...item, sha256:createHash("sha256").update(readFileSync(join(directory,item.file))).digest("hex")}));
writeFileSync(join(directory,"manifest.json"), JSON.stringify({version:1,artifacts}) + "\n", {flag:"wx",mode:0o600});
NODE
```

这个准备示例只给操作者拥有的正常演练产物使用，不是处理敌对路径的安全收集器。
真正命令仍会以 NOFOLLOW/NONBLOCK、ownership/link/权限/预算边界逐个验证文件。

## 2. review：全部验签后审阅历史

```sh
pnpm --silent --filter @bot-thk/api ops:evidence --help
pnpm --silent --filter @bot-thk/api ops:evidence review \
  --trust "$EVIDENCE_DIRECTORY/public-trust.json" \
  --manifest "$EVIDENCE_DIRECTORY/manifest.json" --max-age-ms 86400000
```

- 先在固定公钥下验证**每个**输入、既有事件 ID/schema/签名/准备或接收时间；任一
  不可信输入都使本轮失败，不返回一份“其他部分已可信”的成功报告。
- 来源链区分 missing prefix/range、同序号 fork、错误前驱、事件重放、时间/revision
  回退。缺失范围用数量表达，不从 1 循环到攻击者给定的巨大 sequence。
- episode 只在已提供、无 fork/缺口/配置切换的片段内推断；跨缺口的 resolved 不能
  关闭早先 firing。没有来源 batch 或尾端 fork 时 openAtTail 为 null，不是零。
- 回执区分 missing/orphan/mismatch/equivocation、每来源顺序与全局 inbox revision。
  `unambiguousReceiptBatches` / `unambiguousSignedEventClaims` 只计唯一匹配且该
  来源序号没有其他签名声明的批次/事件，不意味着整个历史无矛盾、磁盘持久或通知成功。
  即使没有提供 batch，同一来源在更晚 sequence 的回执重用同一 terminal event 声明，
  仍是 `receipt_event_replayed` 冲突；跨来源相同 event ID 不混淆。
- 同一 receiver 的 revision 至少应覆盖当时各来源已声明 sequence 的下界之和；
  `minimumReceivesClaimed` 用十进制字符串精确返回这个签名声明下界，避免安全整数
  溢出。它不证明缺失产物存在。`unobservedRevisions` 也不能被解释为投递或消费数。
- 固定分别保留原事件、准备和接收时间/年龄。默认最大年龄预算 24 h，可设
  1000–2592000000 ms（30 d）；任一来源的旧事件或旧回执触发 warning，晚接收、
  新批次或重新运行不会刷新它。此预算不改变 monitor 告警规则。

报告 `evidence=signed_history_only`、`scope=provided_artifacts_only`，没有尾部最终性、
当前健康、人员通知、消费或物理持久证明。每个视图最多展示 128 条确定性 findings
样本，`findingTotals` 总量/byCode 完整；不能把截断的样本当全部问题。

## 3. compare：删旧证据不是进展

```sh
pnpm --silent --filter @bot-thk/api ops:evidence compare \
  --trust "$EVIDENCE_DIRECTORY/public-trust.json" \
  --before "$EVIDENCE_DIRECTORY/before.json" --after "$EVIDENCE_DIRECTORY/after.json"
```

两侧各自有界接纳、在**同一固定 trust**下独立审阅，然后审阅去重并集。固定分类：

| change       | 含义                                                                |
| ------------ | ------------------------------------------------------------------- |
| conflicting  | 并集仍存在相互矛盾，包括分别看似干净的替换 fork                     |
| regressed    | 删除过往 batch/receipt，或其他证据回退；不因新报告更短而变好        |
| incomparable | 原基线为空、后来才有事实，不能声称从已知历史取得进展                |
| unchanged    | 规范化已验签产物身份相同；空白、顺序和重复文件不产生新事实          |
| extended     | 保留旧证据并加入产物；仍须检查 after 的 gap/warning，不代表服务进展 |

同时输出来源 tip/receiver revision 回退、被移除的事实和并集冲突总数。只提供 after
不能知道 before 的内容；两次取证之间未曾提供的删除/尾部，需要独立 requirements。

## 4. check：独立指定已知 checkpoint

```sh
pnpm --silent --filter @bot-thk/api ops:evidence check \
  --trust "$EVIDENCE_DIRECTORY/public-trust.json" \
  --manifest "$EVIDENCE_DIRECTORY/manifest.json" \
  --requirements "$EVIDENCE_DIRECTORY/requirements.json"
```

requirements 必须由操作者**另行指定**，不能让候选 manifest 选择自己的验收要求。
结构如下；指纹与 ID 要从已核对的 trust / 独立保管的已知交接记录取得，不能自动从
本轮候选清单生成“预期”，否则无法发现遗漏。hash 只标识内容，不自认证。

```json
{
  "version": 1,
  "role": "evidence-requirements",
  "trustFingerprint": "<已核对 trust 的 SHA-256 指纹>",
  "checkpoints": [
    {
      "streamId": "<固定来源 UUID v4>",
      "sequence": 2,
      "batchId": "<精确已知 lowercase batch ID>",
      "receiptId": "<精确已知 lowercase receipt hash，或 JSON null>",
      "coverage": "prefix"
    }
  ]
}
```

receipt ID 为规范化已验签 receipt 的 `handoffHash(receipt)`，不是文件原始字节 digest；
不要求指定回执时 `receiptId` 应是 JSON `null`，不能省略。每份 1–64 个 checkpoint，
拒绝重复来源序号/batch ID、未知来源、其他字段、错误 trust 和非安全整数。

`point` 检查精确 batch/可选 receipt 是否提供且不歧义；`prefix` 再沿签名前驱走到
sequence 1，要求每序号唯一、stream 和 sequence 连通。prefix.covered 只指**图覆盖**，
不是所有事件/回执/时序都正常；全局 review 仍独立保留，point 命中也可能因缺口退出 1。
要求精确 receipt 时，即使另一份回执签名有效也不能替代它。所有要求文件都必须稳定
复读，不能 alias trust、manifest 或其产物。`requirementsProvenance` 固定为
`operator_supplied_not_self_authenticated`，从不证明没有未知新尾部。

## 5. trace：有界定位事件与完整 findings

```sh
pnpm --silent --filter @bot-thk/api ops:evidence trace \
  --trust "$EVIDENCE_DIRECTORY/public-trust.json" \
  --manifest "$EVIDENCE_DIRECTORY/manifest.json" --view events --limit 32
# 原样保留第一轮全部过滤与 limit，再把 continuation 放入 --after。
pnpm --silent --filter @bot-thk/api ops:evidence trace \
  --trust "$EVIDENCE_DIRECTORY/public-trust.json" \
  --manifest "$EVIDENCE_DIRECTORY/manifest.json" --view events --limit 32 --after "$CONTINUATION"
pnpm --silent --filter @bot-thk/api ops:evidence trace \
  --trust "$EVIDENCE_DIRECTORY/public-trust.json" \
  --manifest "$EVIDENCE_DIRECTORY/manifest.json" --view findings --severity conflict --limit 32
```

| 过滤                                     | 适用范围                                                                                                   |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `--stream`                               | 两视图；必须已在固定 trust 中                                                                              |
| `--batch-id` / `--event-id`              | 两视图；精确 lowercase 64-hex ID，不存在则零匹配而非证明不存在                                             |
| `--from-sequence` / `--through-sequence` | 两视图；1 至最大安全整数，含端点；不匹配无序号的 findings                                                  |
| `--target` / `--rule` / `--transition`   | 仅 events；target 使用既有 monitor ID，rule 使用既有 MONITOR_RULES，transition 为 firing/reminder/resolved |
| `--from-at` / `--through-at`             | 仅 events；十进制 Unix 毫秒，0–本次 now，含端点                                                            |
| `--code` / `--severity`                  | 仅 findings；固定 finding code，severity 为 gap/conflict/warning                                           |

过滤按 AND 组合；不支持的视图/参数组合拒绝，不静默忽略。limit 为 1–128，默认
100；数字拒绝正负号、指数、非整数、前导零和溢出。全局原事件时间决定排序，再以
来源/revision/sequence/稳定行 ID 确定同刻顺序；它不是缺失历史的真实全序证明。

事件附带已提供的同 stream/config/target/rule 最近相邻事实、签名批次 linkage、
前驱状态和回执声明。`same_batch` / `linked_batches` 只描述已提供的图链接，
`unproven` 不被补齐；没有邻居不证明此前没有事件。回执按 none / contradictory /
ambiguous / matching_signed_claim 区分，每事件最多展示 4 份声明；关联 findings
使用全部已接纳的回执，而不是该小样本。关联发现仍有自己的 128 条样本/完整总量。

findings 视图遍历所有内部发现，包括全局 128 条样本之外的问题。两个视图都保持
`globalReview` 和其退出码；查一个干净来源、伪造任意现存行的位置或选出空页，都
不能让全局 gap/conflict 变绿。筛选也不减少验签、文件安全或资源预算。

continuation 是规范 base64url 编码的 **unsigned navigation data**：绑定规范化已
验签集合、固定 trust、过滤、limit、年龄预算和有序结果行，不绑定文件路径/空白/重复
文件。它可以被人改写为另一个现存位置，所以固定标明
`cursorAuthentication=not_an_authorization_token`；绝不能用于确认、消费或授权。
改变数据/查询后 `page_stale`，从第一页重读；错误 token 或不存在的行返回 `cursor_invalid`。
时钟前进时每轮仍重新计算全局年龄，findings 集变化也会使旧 findings 页失效。

## 6. 容量、退出码与失败处置

| 边界                       | 上限                                                |
| -------------------------- | --------------------------------------------------- |
| 固定公钥 trust             | 16 KiB、16 个来源                                   |
| 单 manifest / requirements | 128 KiB / 32 KiB                                    |
| 每份要求                   | 64 个 checkpoint                                    |
| 每侧输入                   | 256 个产物、8 MiB 原始字节、8192 个唯一批次中的事件 |
| 单产物                     | 256 KiB；重复事实仍占产物数/原始字节预算            |
| compare 并集               | 最多两侧总资源，不按一侧小上限重新接纳              |
| 单份命令输出               | 512 KiB；超出失败，不返回截断的“成功 JSON”          |

| 退出码 | 含义 / 正确动作                                                                                                      |
| ------ | -------------------------------------------------------------------------------------------------------------------- |
| 0      | 该视图没有发现且要求满足；仍不是健康/人员通知/尾部最终性                                                             |
| 1      | gap/conflict/warning、证据回退/不可比较或要求不满足；保留受限证据，人工核查缺失/矛盾，不自动修复                     |
| 2      | 参数/trust/manifest/requirements/cursor_invalid；检查显式文件及独立 pin，不复制候选 key 来“修好”验证                 |
| 3      | 文件/签名/完整性/时钟/预算/snapshot_changed/page_stale/cancelled/output_failed；停止依赖此轮结果，保存原始材料后重读 |

stderr 仅固定 `alert_evidence_error` 和 code，不输出原始异常、路径、keys、输入或
环境值。stdout 输出失败可能留下不完整字节；消费者必须同时检查完整 JSON 与进程
退出码，不能从截断前缀推断成功。命令不持久化任何 intent，可原样重跑，但重跑不是
对可变取证源的原子快照，也不能撤回已发生的外部动作。

每份文件读取前后检查 metadata，交付前复读 trust、全部产物、manifest 和独立要求。
这是保守的 `non_atomic_file_evidence`：不保证所有文件同一时刻、不保证最终复读后
无人改写、不防同 UID 对手/NFS/Windows/实际磁盘掉电。并发只读审阅不抢 writer 锁。
遇到冲突不要删旧产物、恢复旧 journal、偷锁或重绑定身份来绕过；由 owner 停止相关
写入者并独立制定恢复/密钥/备份计划。SIGINT/SIGTERM 在边界取消；同步 native/磁盘
I/O 不能由 JavaScript 强制抢占，调度器仍需独立硬超时。stdout callback 沿用 2 s
上限及有限入口退出，不是主机可用性 SLA。

真实运行证据、行数审计和未跑门禁见[本轮审阅记录](../audit/alert-evidence-review.md)。
