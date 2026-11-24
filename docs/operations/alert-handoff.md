# 离线签名告警交接与独立收件箱

Status: active

对应 [ADR 0043](../architecture/decisions/0043-offline-signed-alert-handoff.md)，承接
[有限 monitor](operational-monitor.md)。本规程只完成 #331 的仓库内交接切片。
**没有外部告警账号、网络 receiver、调度器安装、生产启用或真实主机资格证明。**
所有命令不联网、不加载 `.env`、不打开业务数据库、不重投通知、不运行 Notion job。

## 1. 需要准备什么

- Node 24 / lockfile 中的 pnpm；显式的 monitor 配置和状态，已有待确认事件。
- sender、receiver 两套**不同**的 Ed25519 key pair、一个随机 UUID v4 stream ID
  和另一个 receiver ID。sender 仅需自己的私钥和 receiver 公钥，inbox 反之。
  密钥不能复用 JWT/邮件/业务凭据；公钥 pin 须经独立可信通道核对。
- 全部配置、状态、产物应放入当前 UID 拥有、无 symlink、权限 0700 的本地 POSIX
  目录。新文件 0600；读取时拒绝 group/other 可访问的私有文件、symlink、hard link、
  FIFO、设备、不合法 UTF-8 和超限 JSON。配置中不能增加 endpoint/URL 或环境回退。
- sender 配置严格含 `version, role, streamId, receiverId, signingKey, receiverKey`。
  `role=sender`；`signingKey` 是 canonical base64 的 Ed25519 PKCS8 DER，
  `receiverKey` 是 canonical base64 的 Ed25519 SPKI DER。
- inbox 配置严格含 `version, role, receiverId, signingKey, sources`；`role=inbox`，
  `sources` 为 1–16 个 `{streamId, publicKey}`，公钥用上述 SPKI 编码。重复 ID/key、
  双方共用 key、非 Ed25519 或未知字段一律拒绝。
- 配置最大 16 KiB、事件包/回执最大 256 KiB、sender/inbox 状态各最大 2 MiB。
  一个 batch 为完整 monitor 队列的 1–256 个事件；inbox 全局最多 1024 个未消费事件。

### 一次性本地演练的密钥初始化

下面代码只给**隔离演练**生成一次性配置，不是生产 key 管理或轮换工具。它会在同一
机器短暂持有双方私钥；真实分离保管应由 owner 单独批准。不得把生成文件提交、发到
聊天/issue，或把私钥打印到终端。先创建空的私有目录，然后在仓库根执行：

```sh
mkdir -m 700 "$HOME/no-wave-handoff-drill"
export HANDOFF_BOOTSTRAP_DIR="$HOME/no-wave-handoff-drill"
node --input-type=module-typescript <<'NODE'
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { lstatSync, realpathSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
const directory = resolve(process.env.HANDOFF_BOOTSTRAP_DIR!);
const stat = lstatSync(directory);
if (!stat.isDirectory() || realpathSync(directory) !== directory ||
    stat.uid !== process.getuid!() || (stat.mode & 0o077) !== 0) throw new Error("private directory required");
const sender = generateKeyPairSync("ed25519"), receiver = generateKeyPairSync("ed25519");
const streamId = randomUUID(), receiverId = randomUUID();
const secret = (key: typeof sender.privateKey) => key.export({type:"pkcs8",format:"der"}).toString("base64");
const publicKey = (key: typeof sender.publicKey) => key.export({type:"spki",format:"der"}).toString("base64");
const put = (name: string, value: unknown) => writeFileSync(join(directory, name), JSON.stringify(value) + "\n", {flag:"wx",mode:0o600});
put("sender.json", {version:1,role:"sender",streamId,receiverId,signingKey:secret(sender.privateKey),receiverKey:publicKey(receiver.publicKey)});
put("inbox.json", {version:1,role:"inbox",receiverId,signingKey:secret(receiver.privateKey),sources:[{streamId,publicKey:publicKey(sender.publicKey)}]});
NODE
```

初始化例子采用 create-only；若第二个文件创建失败，保留已生成文件，不自动删除/覆盖。
重新初始化请选**新的空演练目录**，不要对实际在用的配置执行这段示例。

## 2. 事件交接：准备、接收、显式结算

机器读取 stdout 时使用 `pnpm --silent`。下列 `HANDOFF_DIR`、`MONITOR_CONFIG`、
`MONITOR_STATE` 均须由操作者指定为自有隔离文件的绝对路径。

```sh
pnpm --silent --filter @bot-thk/api ops:handoff --help
pnpm --silent --filter @bot-thk/api ops:handoff prepare \
  --config "$HANDOFF_DIR/sender.json" --state "$HANDOFF_DIR/sender-state.json" \
  --monitor-config "$MONITOR_CONFIG" --monitor-state "$MONITOR_STATE" \
  --output "$HANDOFF_DIR/batch-1.json"
# 通过经批准的文件传输通道转交 batch-1.json；不要转交 sender 私钥。
pnpm --silent --filter @bot-thk/api ops:handoff receive \
  --config "$HANDOFF_DIR/inbox.json" --state "$HANDOFF_DIR/inbox-state.json" \
  --batch "$HANDOFF_DIR/batch-1.json" --output "$HANDOFF_DIR/receipt-1.json"
# 将 receipt-1.json 传回 sender；仅此时显式授权确认原监测日志的对应前缀。
pnpm --silent --filter @bot-thk/api ops:handoff settle \
  --config "$HANDOFF_DIR/sender.json" --state "$HANDOFF_DIR/sender-state.json" \
  --monitor-config "$MONITOR_CONFIG" --monitor-state "$MONITOR_STATE" \
  --receipt "$HANDOFF_DIR/receipt-1.json"
```

- `prepare` 在自己的独占锁内提交签名批次意图，再发布不可覆盖的产物。**不 ack**。
  同一来源最多一个在途批次；重试冻结原事件、序号和准备时间，不把后来追加的事件
  偷换进已交接批次。无事件时 `prepared=false`，不生成空事件包，也不代表服务健康。
- `receive` 验证固定公钥、接收方、原 event ID、时间/revision/告警 episode 连续性、
  sequence 和前驱。先原子持久化事件与签名回执，再发布回执文件。无共享业务 outbox。
  同一最新批次重试返回**字节相同**回执；旧批次或同序号不同 batch 失败关闭。
- `settle` 验证整个批次的 ID/count/through/序号/双方身份及签名，先记 receipt intent，
  再取得 monitor 自己的锁，只确认仍匹配的原事件前缀；最后完成 sender 链。
  新追加事件不会被确认；原 firing/recovering 条件不清除。不能拿 inbox entry ID
  充当 monitor event ID，也不能仅凭 receipt 文件名或 JSON 里一个 ID 授权。
- source 绝对配置/状态路径绑定到 sender journal。另一个 monitor 即便指纹相同也不能
  复用这份 journal。两方身份/key 指纹改变会失败，不提供 force、隐式清空或自动重绑定。
- 新批次必须等上一批 `settle` 完成；正常 monitor `check` 可以继续追加事件。交接中
  不要绕过本工具手动推进 ack 或切换配置；推进超过原前缀后，本工具宁可停止也不猜测。

## 3. 接收后还要显式处理与消费

```sh
pnpm --silent --filter @bot-thk/api ops:handoff inbox-read \
  --config "$HANDOFF_DIR/inbox.json" --state "$HANDOFF_DIR/inbox-state.json" --limit 100
# 将返回的 continuation 原样放入后续 --after；期间不得改变 inbox 快照。
pnpm --silent --filter @bot-thk/api ops:handoff inbox-read \
  --config "$HANDOFF_DIR/inbox.json" --state "$HANDOFF_DIR/inbox-state.json" \
  --limit 100 --after "$CONTINUATION"
# 下游已可靠处理所有前置 entry 后，才显式消费该连续前缀。
pnpm --silent --filter @bot-thk/api ops:handoff consume \
  --config "$HANDOFF_DIR/inbox.json" --state "$HANDOFF_DIR/inbox-state.json" --through "$ENTRY_ID"
```

`inbox-read` 每页 1–256，返回安全事件事实、inbox ordinal、来源、batch 与 entry ID，
不含 URL、原指标、账号或业务 payload。签名 cursor 绑定配置/receiver、revision 和
完整快照 digest；任何 receive/consume 改变快照后，旧 cursor 为 `page_stale`，需从
第一页重新读取并由消费者去重。它不是无锁跨多次写入的稳定长游标。

`through` 是该页最后 entry 的 ID，但 consume 始终覆盖**整个全局连续前缀**，不是
“只消费当前页”。必须先处理此前全部页；不能跳过未处理记录。consumer 去重与实际
外部通知由下游承担，本轮没有安装消费者。最近一次 consume 重试是 no-op；更早的
旧确认在前缀继续推进后不保证可重试。消费不撤回或重新签发已接受批次的回执。

## 4. 只读进展与对账

```sh
pnpm --silent --filter @bot-thk/api ops:handoff sender-status \
  --config "$HANDOFF_DIR/sender.json" --state "$HANDOFF_DIR/sender-state.json" \
  --monitor-config "$MONITOR_CONFIG" --monitor-state "$MONITOR_STATE" --max-pending-age-ms 3600000
pnpm --silent --filter @bot-thk/api ops:handoff inbox-status \
  --config "$HANDOFF_DIR/inbox.json" --state "$HANDOFF_DIR/inbox-state.json" --max-pending-age-ms 3600000
pnpm --silent --filter @bot-thk/api ops:handoff reconcile \
  --config "$HANDOFF_DIR/sender.json" --state "$HANDOFF_DIR/sender-state.json" \
  --monitor-config "$MONITOR_CONFIG" --monitor-state "$MONITOR_STATE" \
  --inbox-config "$HANDOFF_DIR/inbox.json" --inbox-state "$HANDOFF_DIR/inbox-state.json"
```

status 默认等待预算 1 h，可逐次指定 1000–86400000 ms；这只是交接进展预算，不改变
monitor 告警规则或 journal 指纹。sender 区分 idle/not_prepared/awaiting_receipt/
awaiting_ack；inbox 分开给出原事件年龄与本地持久接收年龄，不把晚接收改写成新事件。
有待处理项即返回 1，是否 overdue 另用 `age` 表达。没有状态返回 3，不冒充空箱。

三种只读视图均不加写锁、不写日志、不刷新时间、不生成回执或 ack；已有别的 writer
持锁也可读上一次原子快照。`reconcile` 验证双方 pin、已准备前缀、最近签名回执、
接收箱尾部和来源链；报告 receiver_ahead/receiver_rollback/batch_fork/
source_prefix_changed 等固定分类。多个日志来自不同时刻，输出明确为
`non_atomic_offline_evidence`；先停写并保存受限证据再处理冲突，不自动修复。
**status 或 reconcile 退出 0 仅表示该交接视图没有待处理/冲突，不表示服务健康。**
服务观测新鲜度仍使用独立 `ops:monitor status`，不能用交接进展替代它。

## 5. 公钥核验与回执恢复

```sh
pnpm --silent --filter @bot-thk/api ops:handoff profile \
  --config "$HANDOFF_DIR/sender.json" --output "$HANDOFF_DIR/public-profile.json"
pnpm --silent --filter @bot-thk/api ops:handoff verify \
  --config "$HANDOFF_DIR/public-profile.json" --batch "$HANDOFF_DIR/batch-1.json" \
  --receipt "$HANDOFF_DIR/receipt-1.json"
pnpm --silent --filter @bot-thk/api ops:handoff receipt \
  --config "$HANDOFF_DIR/inbox.json" --state "$HANDOFF_DIR/inbox-state.json" \
  --stream "$STREAM_ID" --sequence 1 --batch-id "$BATCH_ID" --output "$HANDOFF_DIR/recovered-1.json"
```

profile 只有 `version,role=verify,streamId,receiverId,senderKey,receiverKey`；不含私钥。
通过独立可信通道核对 profile 后，审阅工作站可用它验证事件包和可选 receipt，不需要
双方私有配置或任何 journal。输出 `evidence=signatures_only`，分别展示原事件/准备/
接收年龄、转换/严重性计数。缺少 receipt 保持 `receiptProof=not_provided`，旧证据
不会因签名正确变新鲜。artifact 自带的 key、私钥字段和算法替换不能建立信任。

`receipt` 只能重发指定来源**最近一批**确实持久化的原回执，即使其事件已 consume。
更早 sequence、不匹配 batch 或未知来源为 `receipt_not_found`；不要制造假回执。
正常协议在 sender 完成结算前不会允许它推进下一批，因此丢失当前回执可以重试 receive
或用此命令恢复。操作者绕过链、删除状态或恢复旧备份不受此保证覆盖。

## 6. 失败、中断、升级与恢复

| 情况 | 已保存什么 | 正确动作 |
| --- | --- | --- |
| prepare 后产物冲突/输出失败 | 原 sender intent；可能已有完整批次文件 | 保留原文件、核对 batch ID，选新文件名或重试同字节产物；不要覆盖/重置 intent |
| receive 后产物/输出失败 | inbox 事件与原签名回执 | 重试 receive 或恢复最新 receipt；不会重新入箱 |
| settle 等 monitor 锁失败 | sender 已保存 receipt intent，来源尚未确认 | 等原 writer 正常退出，再重试相同 receipt；不抢锁 |
| monitor ack 已提交但 sender 最终提交中断 | 原来源已 ack，sender 仍可有 receipt intent | 重试相同 receipt；只接受精确 acknowledged-through 及非倒退 revision/时间，不多确认新事件 |
| inbox 满 1024 / 状态超限 | 旧事件、cursor 和回执完整保留 | 下游可靠处理并显式 consume 后再接收；不按年龄丢弃 |
| symlink/hardlink/FIFO/权限/坏 JSON | 不覆盖不可信文件 | 停止参与者，保存受限证据，由 owner 核对；不填假 key/删日志绕过 |
| sequence/前缀/指纹不一致 | 本轮无自动修复 | 使用只读对账，核查源/接收/消费记录及实际写权，人工决定恢复计划 |

事件包发布用同目录 fsync 临时文件 → no-replace link → 删除临时 link → fsync 目录。
不同内容绝不覆盖；同字节重试重新完成文件/目录 fsync。若进程在 link 与删除临时 link
之间被 SIGKILL，可能留下双 hard link，后续读取故意拒绝；停写后由 owner 核对 inode
与完整字节，再处理临时 link，不由工具自动猜测。原子可见性不等于磁盘故障绝不丢失。

所有 journal 沿用 monitor 的 inode 独占锁，永不按年龄偷锁；SIGKILL 可能留锁。
升级/回滚前停止参与者，分别备份配置、外部 keys、monitor/sender/inbox 与消费者去重
位置；配置/key 指纹改变不自动迁移。本轮没有 key rotation 或跨身份重绑定命令。
恢复旧 journal 可能重复/丢失备份之后的事件；不能据此承诺灾难恢复 exactly-once。

跨主机时钟必须同步；未来准备/接收事实及倒退时钟失败，不静默截为零年龄。无写入的
最新批次/消费重试可以返回原历史结果，但不会更新时间。JavaScript 不能抢占同步
磁盘/native 阻塞，调度器仍须独立硬超时。stdout callback 上限 2 s；真正满管道时
有限入口清理锁后以 3 退出，已提交的 intent/事件/receipt 不被撤销。

stderr 只有固定 `alert_handoff_error/code`，不输出原始异常、私钥、路径或原文件。
退出码：0 命令成功或只读视图无待办；1 status/reconcile 有待办；2 参数/配置错误；
3 完整性/时钟/容量/锁/文件/输出失败。读成功、签名正确、接收成功和实际通知到人是
四种不同证据，不能互换。完整演练与未跑门禁见[审阅报告](../audit/alert-handoff-review.md)。

多份已归档 v1 batch/receipt 可另用[公钥-only 历史证据工具](alert-evidence.md)
`ops:evidence review|compare|check|trace`；它没有私钥或日志写权限，不改变本规程中的
settle/consume、签名 inbox cursor 或 v1 产物。历史审阅和导航成功不构成这些动作的授权。
