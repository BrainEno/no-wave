# 有限只读运维监测：规则、事件确认与恢复演练

Status: active

本规程对应 [ADR 0042](../architecture/decisions/0042-finite-read-only-operational-monitor.md)，
只完成 #331 的仓库内可执行告警切片。**未部署、未配置外部告警账号、未验证真实
主机；不是生产放行。** 不修改业务 outbox、不重投通知、不重放 Notion job。

## 1. 边界与准备

- Node 24；仓库依赖按 lockfile 安装。命令是有限进程，没有 watch/daemon。
- API/worker 的 metrics 仍默认关闭、没有认证，仅允许受限私网/回环访问。
  API 用 `API_METRICS_ENABLED=true`；worker 用独立 `OUTBOX_METRICS_PORT`。
  不要为了本命令把端点暴露公网。参考 [API 指标](api-observability.md)、
  [worker](notification-worker.md)。
- 一个 target 对应一个明确进程实例的固定地址，不用随机负载均衡地址。
  配置拒绝 credentials、query、fragment、非 `/metrics` 路径和非 HTTP(S)。
  明文 HTTP 默认只准 `localhost`、`127.0.0.1`、`::1`；其他私网 HTTP
  需要明确 `allowInsecureHttp: true`。HTTPS 验证证书；不提供跳过选项。
- 配置文件须为当前 UID 拥有、非符号链接、单 hard link 的普通 UTF-8 JSON，
  最大 64 KiB；不得由 group/other 写入。配置不应含密钥。
- 状态父目录须已存在、当前 UID 拥有、权限 0700、真实路径没有符号链接，
  位于支持原子 rename 和 fsync 的**本地 POSIX 持久磁盘**。状态/锁为 0600，
  普通单链接文件；不支持 Windows、共享 NFS/对象存储或多个副本各写一份。
- `ops:monitor` 不加载 `.env` / `.env.local`，不导入 API 启动器或持久层，
  不需要 `DATABASE_URL`、JWT、SMTP 或媒体凭据。

在仓库根目录准备一个**自有的本地测试目录**，不要复用业务数据目录：

```sh
mkdir -m 700 "$HOME/no-wave-monitor"
# 将下面示例保存到这个目录的 monitor.json，再 chmod 600。
```

```json
{
  "version": 1,
  "targets": [
    { "id": "api-one", "role": "api", "metricsUrl": "http://127.0.0.1:4000/metrics" },
    { "id": "worker-one", "role": "notification-worker", "metricsUrl": "http://127.0.0.1:9100/metrics" }
  ]
}
```

目标 1–16 个，ID 为小写字母开头、后续小写字母/数字/短横线、最多 48 字符；
ID 与规范化后的 URL 各自唯一。未知字段、null 配置节、错误类型、越界配置
一律失败，不悄悄回落。目标顺序和 JSON key 顺序不影响配置指纹。

## 2. 有限命令与退出码

机器消费 stdout 时使用 `pnpm --silent`，避免 package-manager 前缀混入 JSON。
路径按当前工作目录解析；明确传绝对路径最稳妥。

```sh
pnpm --silent --filter @no-wave/api ops:monitor --help
pnpm --silent --filter @no-wave/api ops:monitor check \
  --config "$HOME/no-wave-monitor/monitor.json" \
  --state "$HOME/no-wave-monitor/alerts.json"
pnpm --silent --filter @no-wave/api ops:monitor inspect \
  --config "$HOME/no-wave-monitor/monitor.json" \
  --state "$HOME/no-wave-monitor/alerts.json"
pnpm --silent --filter @no-wave/api ops:monitor status \
  --config "$HOME/no-wave-monitor/monitor.json" \
  --state "$HOME/no-wave-monitor/alerts.json"
```

`check` 只 GET 配置目标；在整个采集/评估期间持有独占锁。它在**提交并关锁后**
输出单行 `monitor_check` JSON。每个 target 含有限 `source` 与规则的
`condition`、`reason`、`value`、`phase`；`events` 是**全部未确认事件**，
不只是本轮新事件。`evaluatedAt` 是 epoch 毫秒，不是服务端健康样本时间。

`inspect` 不 scrape、不改状态，报告最后评估时间、样本时间、counter 窗口、
规则阶段、配置变更和待交付事件。**退出 0 只代表读取成功，不代表服务健康或数据新鲜。**

| 退出码 | 含义 |
| --- | --- |
| 0 | `check` / `status` 所有规则已知且 inactive、无待确认事件（status 还须有新鲜观测）；或 inspect/ack/reconfigure/help 成功 |
| 1 | `check` / `status` 有 pending/firing/recovering 条件，或仍有未确认事件 |
| 2 | 参数或配置无效；没有发起采集 |
| 3 | 未知观测、时钟/锁/文件/输出错误或取消；不能当健康 |

stderr 错误只有 `{"version":1,"event":"monitor_error","code":"…"}`；不输出
原始异常、URL、路径、响应体、原始标签、数据库/环境值。stdout 只包含显式目标 ID、
有限规则/原因、数字和不透明事件 ID。配置 fingerprint 不是凭据。

调度器应保存 stdout、stderr 和退出码，区分 1/2/3；建议每 15–30 秒执行一次，
不要超过默认 `maxGapMs=90000`。**本仓库不安装 cron、不创建外部服务。**
外部调度器还应监视 monitor 自身没有运行/没有上报，并设置硬超时；JavaScript
计时器不能抢占同步磁盘、native 或 CPU 阻塞。

### 离线 status：旧绿灯会到期

`status` 供只读 watchdog / 操作者读取最后一次观测的新鲜度；不 scrape、不加写锁、
不修改时间/阶段/revision/事件，不受 check 的最小调用间隔限制。每项报告
`freshness`、`lastSource`、`lastObservedAt`、`observationAgeMs` 与最近规则事实：

- `fresh`：评估和 observation 都没有超过 maxGap；source 失败仍可 fresh，
  意思是“新近观测到失败”，不是服务健康。
- `stale`：任何观测过期，规则变为 unknown / `monitor_stale`，不沿用绿灯；
  `not_observed`：尚未检查或旧 schema 没有缓存规则事实。
- `configuration_changed`：显式配置切换清空旧策略下的 verdict 缓存，等待 check；
  保留 counter 基线和锁存告警，不把配置操作算作观测。

总结果 `observed_healthy` 仅表示**最近观测**在有效期内且全已知无异常；不是实时
网络探针，也不证明这次 status 命令检查了服务。过期时返回 3 / unknown；但
已有活跃条件或未交付事件优先返回 1 / attention，不因过期消失。严格重建缓存
事实的有限 ID/condition/reason/value，并校验 source 一致性，不能用损坏事实生成绿灯。
外部 watchdog 的独立调度与告警接线仍须另行批准，本工具不安装它。

## 3. 规则及默认阈值

| 规则 | 对象 | bad 条件 | 默认持续 / 恢复 |
| --- | --- | --- | --- |
| `target_unavailable` | API / worker | HTTP/传输/格式/缓存/超时等导致无可信 snapshot | 60 s / 30 s |
| `service_not_ready` | API / worker | exporter 的 readiness 为 0 | 60 s / 30 s |
| `database_unavailable` | API | 独立 `api_persistence_available` 为 0，不用整体 readiness 猜数据库 | 60 s / 30 s |
| `notification_telemetry_unavailable` | API / worker | backlog unavailable 或 sample 过期 | 60 s / 30 s |
| `notification_backlog` | API / worker | pending ≥1000，或 pending >0 且最老年龄 ≥120 s | 60 s / 30 s |
| `notification_dead_letters` | API / worker | 死信 >0 | 立即 / 30 s |
| `http_5xx` | API | 完整 5 min 窗口内 requests ≥20 且 5xx 比例 ≥5% | 60 s / 30 s |
| `mail_delivery_failures` | API | 完整 5 min 窗口内失败投递增量 ≥1 | 立即 / 30 s |

`target_unavailable`、`service_not_ready`、`database_unavailable`、
`notification_dead_letters` 为 critical；其余 warning。默认 firing 提醒间隔 1 h。
Backlog 的 `value` 为最老 pending 秒数；数量阈值也可导致 bad，因此不能只看这个值。

仅 API 评估数据库、HTTP、邮件。worker 的样本不能证明数据库健康。
`/health`、`/ready`、`/metrics`、REST `health` 请求排除在 HTTP 5xx 的分子/分母外。
密码恢复可返回 202 而 SMTP 失败；邮件规则只看 `failed` counter，不以 quiet、
`sent` 或 `skipped` 证明真实邮件到达。窗口内失败数回到零的恢复也只表示
“新窗口没有观测到失败”，不是端到端投递成功证明。

### 完整配置节与范围

顶层可选 `scrapeTimeoutMs`（默认 2000，50–10000）、`runTimeoutMs`
（默认 10000，50–60000，且 ≥单次超时）、`allowInsecureHttp`（默认 false）。

`policy` 可覆盖以下字段；除 `httpErrorRatio` 外均为整数：

| 字段 | 默认 | 范围 |
| --- | --- | --- |
| `windowMs` | 300000 | 1000–900000，且 ≥ minIntervalMs |
| `minIntervalMs` | 1000 | 1000–60000 |
| `maxGapMs` | 90000 | 1000–900000，且 ≥ minIntervalMs |
| `httpMinRequests` | 20 | 1–1000000000 |
| `httpErrorRatio` | 0.05 | 0.000001–1 |
| `pendingAgeSeconds` | 120 | 1–86400 |
| `pendingEvents` | 1000 | 1–1000000000 |
| `mailFailures` | 1 | 1–1000000000 |

`rules` 只接受上表八个 ID；每项可覆盖 `forMs` / `resolveMs`（0–900000）和
`repeatMs`（30000–86400000）。例如只在**一次性本地演练**中缩短窗口：

```json
{
  "policy": { "windowMs": 1000, "httpMinRequests": 1 },
  "rules": {
    "http_5xx": { "forMs": 0, "resolveMs": 0 },
    "database_unavailable": { "forMs": 0, "resolveMs": 0 }
  }
}
```

这是要合并进完整配置的片段，不是可独立运行的配置；不要用演练阈值替换生产审批。

## 4. 缺失、重启与持续时间

- 不可达 / 不能解析时，仅目标不可用规则收到 bad；其他领域规则 unknown。
  连续失败抓取仍可积累 `target_unavailable` 的持续时间。
- API backlog 需要 available 和有界时间戳；worker 还必须同时满足它报告的
  monotonic sample age / freshness budget（最多 120 s）。保留的 last-good 零
  不代表新鲜、健康。缺失的必需 family 使整个 scrape 无效。
- 支持本仓库的 Prometheus 0.0.4 契约；空的 lazy counter 只有在存在正确 TYPE
  声明时才解释为 0。未知 family 丢弃；类型/重复 series/非有限数/异常标签拒绝。
  最大 4 MiB、65536 行、单行 8192 字符、4096 个已识别 sample、每项 8 标签。
- 请求不重定向/重试，不携带 Cookie、Authorization，不解压；响应须为
  `text/plain`、identity encoding、`Cache-Control: no-store`，Age 缺省或 0。
  响应头、body、UTF-8 解码和解析都在单次/总采集期限内；每个请求关闭后才复用槽。
- `api_process_instance_info` / `notification_worker_process_instance_info` 是 exporter
  lifetime UUID，不是机器/用户标识。UUID 更换、counter 减少、不可能的 error
  增量或超过 maxGap 的成功样本间隙会重建窗口；不能把两个实例相减。
- 监控长间隙、unknown、重启和 counter reset 中断 pending/recovery 的连续性。
  pending 重新开始；已 firing 或 recovering 回到 firing，直到重新观测足够的
  连续健康时间。初次抓取、窗口不足和 HTTP 低流量 unknown 不可清除告警。
- 时钟倒退、未来 observation、重复样本或早于 minInterval 的调用拒绝提交。
  修改配置不能绕过最新观测/配置切换时钟下界。

## 5. 事件交付与显式确认

事件字段：`id`、`revision`、`targetId`、`rule`、`severity`、
`transition`（firing/reminder/resolved）、`at`、`firingSince`、`reason`、`value`。
ID 包含配置指纹、revision、目标、规则、转换和评估时间；不包含 URL 或原始标签。
同一队列会重复输出同一 ID；消费者须持久化去重。恢复事件也必须交付/确认。

1. `check` 提交日志后把待确认事件输出给消费者。
2. 消费者可靠接收/存储后，选取**已交付连续前缀的最后一个** ID。
3. 显式运行下述命令；不要把“shell 写出成功”当“接收者已经处理”。

```sh
pnpm --silent --filter @no-wave/api ops:monitor ack \
  --config "$HOME/no-wave-monitor/monitor.json" \
  --state "$HOME/no-wave-monitor/alerts.json" \
  --through "$EVENT_ID"
```

`EVENT_ID` 必须由操作者设为已可靠交付前缀的最后一个 64 位小写十六进制 ID；
不能生成假 ID，也不能因命令成功打印就自动确认。
未知 ID 拒绝；最近一次 ack 重试为 no-op。旧的更早 ack 在队列已推进后不保证可重试。
ack 不清除 firing、不重置阈值、不写业务数据；后续提醒/恢复仍会产生新事件。

队列最大 256；满时 `state_full`，不提交这一轮，也不丢旧事件。先用 `inspect`
交付并确认已有事件，再重新 check；间隙不能补算为健康。

stdout 的 write callback 等待最多 2 s。真实满管道/EPIPE 使命令以 3 退出，
尽可能在 stderr 写 `output_failed`；已经提交的事件仍在，锁已释放。
有限 CLI 在清理并等待输出之后显式退出，以免 OS 未完成写请求拖住进程；嵌入式
`runMonitorCommand` 只返回，不终止调用进程。若两条流都堵塞，不保证能收到错误 JSON。

可选的[离线签名交接与独立收件箱](alert-handoff.md)为上述消费者提供仓库内实现：
先持久接收、签发独立回执，再由显式 settle 确认匹配的原事件前缀；不会自动联网、
把 stdout 成功当回执，或把 inbox 接收当作人员已收到通知。

## 6. 安全切换配置

直接拿新配置打开旧日志会 `state_config_mismatch`；**不要删除日志来消掉告警**。
先交付/确认全部事件，再执行显式离线事务：

```sh
pnpm --silent --filter @no-wave/api ops:monitor reconfigure \
  --config "$HOME/no-wave-monitor/monitor.json" \
  --next-config "$HOME/no-wave-monitor/next.json" \
  --state "$HOME/no-wave-monitor/alerts.json"
```

- 不 scrape。旧/新文件均先严格验证；在同一独占锁中 fsync/rename。
- 有未确认事件时 `config_pending_events`；有 pending/firing/recovering 的目标
  不能被删除、改名、换角色或重定向，返回 `config_active_targets`。
- 相同来源保持告警和样本；新目标 cold-start；显式退休/重绑定 inactive 目标
  不合成 resolved。规则阈值/时序改变重启其连续性但保留 firing；counter 窗口
  或采样政策变化只保留最后可信基线。
- `lastConfigurationChange` 记录旧指纹、时间、revision；`lastEvaluatedAt` 不变。
  随后的 check/inspect/ack 必须使用新配置；相同配置切换是 no-op。
- 输出或目录 fsync 失败时，事务可能已 rename。保留两个配置，分别 inspect
  确定哪一个匹配磁盘；不要自动回滚/覆盖。成功确认新指纹后再调整外部定时器。

## 7. 锁、文件损坏、升级和回滚

锁从开始读取状态到提交完成始终独占。第二个 check/ack/reconfigure 遇到
`state_locked` 不 scrape、不抢锁。`inspect` 读取原子快照，可能看到提交前版本。
锁只由创建它且 inode 仍匹配的进程删除，永不按时间“偷锁”。SIGINT/SIGTERM
在采集时取消 socket、关锁、不提交未完成观测；SIGKILL/主机崩溃可能留下锁。

异常时的人工顺序：

1. 暂停外部定时器，确认没有 monitor 进程/旧副本仍在运行。锁中 PID 仅是线索，
   不是跨主机的所有权证明。保留受限证据，不公开配置/路径/原始响应。
2. 检查目录/文件 owner、mode、symlink/hardlink、容量和本地磁盘支持。
   不自动 chmod、删除“坏”状态或跳过配置指纹；FIFO/设备等不是可用文件。
3. 确认所有者已退出后，才由操作者处理崩溃锁。备份仍按 0700/0600 保存，
   暂存文件也可能含事件；清理须在停机并确认当前日志后进行。
4. 损坏日志不得覆盖。恢复经审核备份并重新交付去重；恢复旧备份可能重复事件、
   丢失备份之后的未交付事件，本工具不提供灾难恢复的 exactly-once 保证。
5. 升级前停调度、等进程退出、备份配置/日志/消费者去重位置。回滚也先停止调度；
   旧二进制若拒绝新 schema 就保持停止，不削弱验证强行读取。

权限与结构校验不是 MAC/签名；不能防同 UID 恶意改写。原子 rename/fsync 的
实际持久性和宿主机磁盘故障恢复还需真实主机演练。

## 8. 可复现的仓库演练与证据边界

以下测试只使用一次性 fixture；**不得指向生产数据库**。PostgreSQL 用单独测试
连接通过 `TEST_DATABASE_URL` 提供；未提供时对应既有测试按仓库规则跳过，
所以完整验收必须另有真实 PostgreSQL gate，不能把带 skip 的本地结果称为双 provider 通过。

```sh
node --test --test-concurrency=1 \
  apps/api/src/application/operational-alerts.test.ts \
  apps/api/src/application/operational-alerts-source.test.ts \
  apps/api/src/application/operational-monitor-configure.test.ts \
  apps/api/src/application/operational-monitor-status.test.ts \
  apps/api/src/infrastructure/monitor-*.test.ts
```

| 演练 | 自动断言 | 限制 |
| --- | --- | --- |
| 多进程锁、慢 body、SIGTERM | 整轮独占；取消关闭 socket；无半份状态；可重新启动 | 本地 OS，不是主机平台信号窗口 |
| stdout 真正塞满的 FIFO | 2 s 输出失败；命令有限退出；已提交事件仍可 inspect，无隐式 ack | 本地 POSIX；不证明日志供应商收到了事件 |
| 假冒配置/状态的 FIFO | 不阻塞在 open；固定错误码；不留锁 | 不证明磁盘永不阻塞 |
| SQLite + PostgreSQL API/独立 worker/独立 monitor | pending/死信、HTTP5xx、SMTP 失败告警；ack/恢复；worker 停止后 unknown；每次 check 前后所比较的 outbox 关键字段相同 | API 的 HTTP500/DB-health 故障为确定性 store wrapper 注入 |
| SMTP 拒绝 | 真实 TCP 连接拒绝，API 仍为 202，mail failure counter 可见 | 不是实际邮件供应商/收件箱投递 |
| 配置更改 | 锁内原子切换、未交付拒绝、活跃目标不能消失、连续性重新建立 | 不改变生产定时器或配置 |

实际运行清单和功能行证书见[本轮审阅报告](../audit/operational-monitor-review.md)。
真实主机冷启动/休眠/持久存储、监控自身失联、外部接收者去重与确认、告警通知/
回滚演练仍由 [host qualification](host-qualification.md) 和 #331 后续负责；本轮不勾选这些门禁。
