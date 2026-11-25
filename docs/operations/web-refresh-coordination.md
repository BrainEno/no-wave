# Web 共享刷新协调：迁移、观测与故障处理

Status: active

- 日期：2026-11-12；范围：#318，配合 #316 / #319。
- 协议：[ADR 0025](../architecture/decisions/0025-browser-session-refresh-protocol.md)。身份兼容变更：[ADR 0018](../architecture/decisions/0018-session-id-on-access-tokens.md)。
- 本文是操作规程，不是部署授权，也不是 #331 的真实公网托管验收。

## 1. 何时必须启用

单个 Web 进程仍默认 `memory`。运行多个 Web 进程时必须如实声明
`WEB_INSTANCE_COUNT`，并选择 `WEB_REFRESH_COORDINATOR=postgres`。多副本配内存
会在生产入口和 Vite 开发入口监听之前失败。黏性路由不是绕过启动保护的理由；
程序也无法自动发现未申报的副本。

这是 **Web 自己的协调数据库**，不更换身份持久层。API 可以继续使用 SQLite，
PostgreSQL 只保存哈希代次、所有者、截止时间、短期加密结果和长期不确定性栅栏。
API 的 refresh 仍然严格一次性；直接向 API 真正重放，仍原子撤销整个 family。

所有副本必须使用同一个数据库、有效 schema/search_path、namespace、AES 密钥和
共享策略。`rotationTimeoutMs`、容量及协议 TTL 不一致时拒绝启动。每个 namespace
在**第一次实际 claim** 时绑定 BFF 的规范化刷新端点指纹；不同 DNS/基础路径别名
随后会失败，不会悄悄产生两组哈希而重复消耗同一凭据。端点不从浏览器 Host 推导。

## 2. 配置与连接前提

| 变量 | 默认 | 范围 / 约束 |
| --- | --- | --- |
| `WEB_INSTANCE_COUNT` | `1` | 1–1024；声明实际 Web 进程数 |
| `WEB_REFRESH_COORDINATOR` | `memory` | `memory` / `postgres` |
| `WEB_REFRESH_DATABASE_URL` | 无 | shared 模式必需；独立运维密钥管理中的 PostgreSQL DSN |
| `WEB_REFRESH_ENCRYPTION_KEY` | 无 | shared 模式必需；32 个随机字节的规范无填充 base64url，43 字符 |
| `WEB_REFRESH_NAMESPACE` | `default` | 以小写字母开头，最多 48 字符，只含小写字母、数字、`_`、`-` |
| `WEB_REFRESH_MAX_ENTRIES` | `8192` | 1–65536；数据库 namespace 容量，所有副本必须一致 |
| `WEB_REFRESH_MAX_PENDING` | `128` | 1–1024；单进程不同代次 / 实际未结束回调上限 |
| `WEB_REFRESH_MAX_WAITERS` | `1024` | 1–8192；单进程请求等待者上限 |
| `WEB_REFRESH_MAX_WAITERS_PER_KEY` | `64` | 1–1024，且不超过全局等待者上限 |
| `WEB_REFRESH_DATABASE_CONCURRENCY` | `4` | 1–32，且不超过 `MAX_PENDING` |
| `WEB_REFRESH_DRIVER_TIMEOUT_MS` | `2000` | 100–10000；排队与数据库调用预算、数据库 statement/lock timeout |
| `WEB_REFRESH_ROTATION_TIMEOUT_MS` | `15000` | 100–120000；已提交 owner 的 HTTP 工作窗口，副本必须一致 |
| `WEB_REFRESH_WAIT_TIMEOUT_MS` | `20000` | 100–120000；等待共享结果的请求预算 |
| `WEB_REFRESH_SWEEP_INTERVAL_MS` | `30000` | 1000–600000；单进程后台有界 sweep 周期 |
| `WEB_REFRESH_METRICS_TOKEN` | 不启用 | 独立、随机、43–128 字符 URL-safe 运维凭据；不得复用 AES/JWT 密钥 |

- DSN 必须有用户名、主机和数据库，不接受 fragment。只允许唯一的
  `sslmode=disable|require|verify-full`、`sslrootcert=system`、
  `channel_binding=disable|prefer|require`、`target_session_attrs=read-write|primary`
  和受限 `search_path`（单个简单小写 schema，可追加 `,public`）。
- 非回环主机必须显式选择 TLS 策略；推荐 `sslmode=verify-full`。
  `require` 只表示显式选用驱动的加密策略，不等于证书身份验证；`disable` 只适合
  已审核的私有可信链路。禁止用 DSN 的 `options`、`statement_timeout`、
  `connect_timeout` 等覆盖资源预算，也禁止通过证书选项读取任意文件。
- 连接必须支持事务、事务 advisory lock 和长连 LISTEN/NOTIFY；不能使用
  statement/transaction-only 池化端点。驱动查询池最多 `DATABASE_CONCURRENCY`
  条连接，另外一条专用 LISTEN 连接；容量规划要乘以 Web 副本数。
- PostgreSQL 必须可靠持久化 WAL，恢复/故障切换不能丢失已确认 claim。
  每个事务强制 `SET LOCAL synchronous_commit='on'`，但这不能修复服务端关闭
  `fsync`、异步故障切换丢写或恢复旧快照。托管提供方的耐久性仍须单独审核。
- 不要用 `NEXT_PUBLIC_*` 或客户端 bundle 传入这些设置。驱动仅在原生 Node
  Web runtime 中使用，HTTP seam 不依赖 PostgreSQL。

## 3. 显式迁移与最小权限

从仓库根目录、通过受控环境注入同一组 shared 设置后运行：

```sh
pnpm web:refresh migrate
pnpm web:refresh check
pnpm web:refresh status
```

`migrate` 幂等创建 `web_refresh_coordinator_policy`、`web_refresh_coordination`
和到期索引，登记 key fingerprint / 协议策略。它不覆盖既有不匹配策略，不删除行，
也不自动转换不兼容旧表。正常启动只 verify，不执行 DDL。

迁移角色需要目标 schema 的 CREATE 以及创建表/索引/外键的权限。运行角色需要：

- 目标 schema 的 USAGE；
- policy 表的 SELECT 和 `upstream_fingerprint` 列的 UPDATE；
- coordination 表的 SELECT、INSERT、UPDATE、DELETE；
- 事务 advisory lock 与 `pg_notify` / LISTEN 的常规权限。

运行角色不需要表 owner 或任意 DDL。两张表必须是持久 WAL-logged 普通表，
具有精确的列类型/可空性和立即生效主键；不能启用 RLS、应用自定义 trigger/rule，
不能使用只读事务。缺失列、错误类型、无效索引、权限不足、错误密钥或策略都会失败。
不要在包含不可信角色可 CREATE 的 schema 中解析这些表。

`check` 返回经过脱敏的 ready 结果；`status` 只返回聚合状态/年龄/数据库时间，
不返回 namespace、generation key、owner、DSN、密钥或密文。命令错误是固定描述、
退出 1，不输出原始数据库异常。关闭数据库工作未能按预算完成同样退出 1。

## 4. 状态与失败策略

| 情况 | 存储 / 后续行为 |
| --- | --- |
| 成功刷新，或确定的 400/401 | AES-256-GCM 短结果最多 5 秒，且不越过 access 到期；到期才允许新 claim |
| 429 或其他确定的非 5xx 拒绝 | 250 ms 短复用，保留归一化 Retry-After；不消耗不确定性保留期 |
| API 超时、网络错误、5xx、成功体不合法、回调抛错 | 原 owner 的长期 fence 保留 30 天 + 60 秒；短失败结果过期后返回 `503 REFRESH_UNCERTAIN` |
| owner 被杀 / HTTP 结果丢失 / 完成提交结果不明 | 不偷租约、不删除 fence、不拿旧 refresh 再试；要求重新登录 |
| 数据库不可用 / 容量或等待者超限 / 协调超时 | 私有 503，不回退到内存，不裸调用 API |

不确定性保留期长于 API 最长绝对 refresh 生命周期。即使还没实际消耗凭据，
失去 owner 后也不猜测“应该没成功”。这是明确选择的安全/可用性取舍。
对成功结果短复用并不改变 API 的重放检测，5 秒后真正重放仍可能撤销 family。

回调/驱动超时只结束调用者等待，不假装底层已停止：真实工作仍占 admission 槽，
直到实际结束。断开一个浏览器请求只释放该等待者，不取消其他请求共用的刷新。
LISTEN/NOTIFY 仅带哈希提示，漏通知最多回退到 250 ms 有界轮询，不提供身份或结果。

API 的 `API_TIMEOUT_MS` 仍是**一次 API 调用**的预算，开始于 HTTP，不提前消耗在
数据库排队中。shared 的 owner/window 和 waiter 另有上限；需要长 API 预算时应
同时审核这些设置，不能假定放大 `API_TIMEOUT_MS` 会扩大协调所有权期限。

## 5. 探针、指标与清理

- `/healthz` 是廉价存活探针，不查询数据库。
- `/readyz` 返回 `ready`、`mode`、`status`，shared 模式每 5 秒采样一次依赖，
  10 秒未更新即不 ready。失败、恢复和关闭不会由过期异步回调“复活”。探针读取缓存，
  不在每次探活时创建新查询。
- 设置独立 `WEB_REFRESH_METRICS_TOKEN` 后启用 `/internal/refresh-metrics`。
  默认 404；只接受 `Authorization: Bearer ...`，拒绝查询参数，不允许 URL token。
  启动拒绝复用 AES、JWT 或来源证明密钥。GET/HEAD 以外 405；未授权 401；
  授权后每进程每分钟最多 60 次、输出最多 16 KiB。
  响应 no-store/noindex；抓取只渲染缓存，不访问数据库。仍应在边缘限制为运维网络。
- `web_refresh_coordination_events_total{event}`、`failures_total{reason}` 为固定标签
  **单进程 counter，跨副本求和**。关注 uncertain、database、circuit-open、capacity。
- 请求 waiters / waiting keys、真实数据库 active / queued operations、熔断 one-hot
  state / 当前失败数 / 剩余退避，以及通知订阅、等待者和受限唤醒计数，都来自
  **实际运行组件的内存快照**，不是测试专用统计。它们帮助区分“等待者已取消”与
  “底层工作仍占槽”，也不因抓取而发起查询。这些压力指标是单进程值。
- `stored_generations{state}`、过期/overdue 数、最老 pending/uncertain 年龄和采样时间
  是各副本重复采样的 **共享存储 gauge，跨副本取 max，不能相加**。
  `storage_available=0` 不是“数据库里零条记录”；保留最后样本并检查时间戳。
  memory 模式的 `shared=0`、存储可用性 0 属于未配置共享库，不应触发共享库故障告警。
- 默认每 30 秒 sweep 最多 256 条已到期记录；显式
  `pnpm web:refresh sweep` 最多 20 轮 × 256 条，返回 removed/passes/converged。
  `converged=false` 是有界运行，不是擅自放宽删除谓词。
- 达到 namespace 容量会失败关闭，不通过 LRU 挤掉未到期 pending/uncertain。
  容量告警应结合 `status`、sample age、DB 可用性调查，而不是先清表。

协调数据库熔断在连续 3 次数据库/期限/策略错误后开启，退避从 1 秒到 30 秒，
恢复时只允许一个探测工作；旧 epoch 的迟到成功不能关闭新熔断。

HTTP SIGTERM/SIGINT 先停止接收新工作，按原 8 秒预算排空，随后关闭协调器与连接池。
资源清理共享原来的绝对预算，不再另加无界等待；未实际排空会记录
`coordinationDrained=false` 并非零退出。未完成 owner 留下的 fence 不能被接班重试。

## 6. 上线、故障与回滚边界

任何真实部署都需另外授权。本轮仅有本地/CI 验证，不修改线上环境、DNS、密钥或数据。

1. 在隔离环境按本文迁移；用同一 key/namespace/policy 运行真实双 Web 测试。
2. 检查声明的副本数、数据库连接上限、主从/恢复耐久性、API 规范地址以及独立 issuer。
   #319 现在要求有效 `sid` 且 access TTL 不超过 900 秒；不能默默依赖旧兼容。
3. 在获批切换窗口排空原 Web 请求/刷新及短复用窗口，不混跑独立内存和 shared 模式。
   先验证一个 shared Web，再扩展；客户端已处于不确定刷新状态时应重新登录。
4. 必须安装并监控 [API scheduled maintenance](scheduled-maintenance.md)。#316 后
   身份清理不再由第 128 个认证请求兜底；通知 worker 也不会替你安装定时任务。
5. 故障先看 ready、聚合指标、熔断与数据库连接/权限；修复依赖后允许原 ledger 恢复。
   **不要清 pending/uncertain，不要换 namespace 绕过失败，不要回退内存。**
6. key/namespace/共享策略的变更不是普通滚动发布。没有自动重置、重加密或丢弃 fence
   的命令；应另行设计保留所有未到期 fence 的停机迁移。恢复旧快照或更换空库同样危险。
7. 回滚到不认识该 ledger 的旧 Web，即使只开一个实例，也可能重新消耗仍然不确定的
   refresh。保留能读取原 ledger 的版本，或另行审核全面会话失效/重新登录方案；
   本轮不执行任何此类数据操作。

## 7. 可复现验证入口

```sh
# 纯协议/有界资源/加密/运维测试，加上测试专用数据库时执行真实共享库案例
node --test apps/web-rr/test/refresh-*.test.ts

# 必须先 build，真实 OS 进程实际运行 server.ts 和生产 BFF bundle
pnpm --filter @no-wave/web-rr build
# 使用隔离的 TEST_DATABASE_URL；这些夹具创建并清理自己的 schema
pnpm --filter @no-wave/api test:integration
```

CI 的 required `postgres-integration` 服务使用真实 PostgreSQL，先构建 Web 再执行
共享存储与双生产 Web 测试。没有 `TEST_DATABASE_URL` 的本地命令会明确跳过真实库
案例，不能把这种 skip 当成跨副本验收。另有生产 Web 常规、浏览器与容器检查；
它们也不能替代独立 OS 进程 / API 提交后强杀 owner 的证据。
