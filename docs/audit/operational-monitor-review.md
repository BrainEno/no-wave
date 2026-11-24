# #331 有限只读告警切片：审阅与验收记录

Status: archived

本轮基线 `cd58a637668373e2f9f61f3fc00ec4837bf9a238`，分支
`arena/215cdc35-no-wave`。不借用先前 PR #369 的通过结果作为本轮验收。
范围是[ADR 0042](../architecture/decisions/0042-finite-read-only-operational-monitor.md)
与[运维规程](../operations/operational-monitor.md)中的有限只读监测、事件确认、
安全配置变更。#331 的真实主机/外部接收/回滚/其余 phase-gate 归属仍开放。

## 改变的行为

- 应用层八项规则、按 exporter UUID 隔离的完整 counter 窗口、持续阈值与恢复；
  缺失/过期/重启/低 HTTP 流量 unknown 不冒充健康零。
- 私有、有限 HTTP 采集，原生物理请求并发/取消、严格 Prometheus 契约；
  不连接业务数据库、不携带环境凭据、不执行 mutation。
- 本地 POSIX 独占原子日志，稳定事件 ID、先提交再输出、精确前缀 ack；
  队列满/磁盘冲突/配置不匹配均失败关闭，不丢旧事件或自动抢锁。
- 有限 check/inspect/status/ack/reconfigure；离线 status 会使旧绿灯过期，
  不生成新观测、清除告警或确认事件。配置更改不能清除活跃告警、丢未交付事件，
  也不能制造新鲜观测或把旧窗口套入不同规则。
- exporter 增加不透明 lifetime UUID，API 增加独立 persistence gauge；
  保留原有 metrics 默认关闭、采样/探针 single-flight 与非阻塞派发。

## 复用检索与新增边界

检索并阅读 shared-module index、`http-observability.ts`、`api-readiness.ts`、
`outbox-backlog.ts`、worker readiness/health、`outbox-metrics.ts`、
`service-settings.ts`、`service-operations.ts`、`http-lifecycle.ts`、
web-http `upstream*.ts`、Notion 的有限命令/持久作业及两个 provider fixture。

复用既有 exporter、入口检测和测试数据库 fixture。新增采集器不是通用 Web upstream：
它只读显式私有 metrics、不重试、不重定向、等物理 request.close 后才释放槽，并
严格解释本仓库 telemetry 的缺失/过期语义；不能导入浏览器/BFF Cookie 或凭据策略。
新增事件日志只管理本机运维交付，不复用业务 outbox/Notion mutation 队列，避免
把告警观察变成业务写权限。`monitorFields` 是 closed-object boundary，不是
宽松 isRecord 替代品；拒绝未知字段和 null/数组/非普通对象。

## TDD 与故障回归

高风险边界使用 RED → GREEN；完整日志保存在忽略的
`verification/operations-monitor/`，不提交数据库、下载工具或大日志。

- exporter、严格配置/exposition、纯评估/窗口/ack、缺失源连续性；
- collector 的 body/总 deadline、四个物理槽、排队取消、缓存与格式拒绝；
- 日志 inode 锁、权限、损坏、外部替换、幂等 commit 的磁盘重验；
- 配置切换前未交付/活跃条件保护、计时与基线重建；
- 实际竞争 CLI、慢 body、SIGTERM、真正塞满的 stdout FIFO、FIFO 假冒文件。

实际故障曾揭露并修复：null 配置被默认值吞掉、失败 scrape 重置可用性 timer、
恢复旧日志后不同时间事件 ID 冲突、no-op commit 跳过外部替换/目录权限检查、
满 stdout 虽已报错却被 libuv 写请求拖住退出、FIFO 在 fstat 前阻塞 open、
Content-Type 不配对引号、恢复 counter 历史中的不可能 error 差值、旧失败 observation
被重放后制造持续时间，以及缓存 verdict 与阈值/遥测源不一致。
没有删除/跳过/削弱这些回归。

## 本地验证

验证环境 Node 24.22.3 / pnpm 10.20.0；真实嵌入式 PostgreSQL 17.11，
仅回环、一次性测试 schema；SQLite 对照为真实文件。下列命令全部实际执行并检查
退出码/日志；串行执行所有拥有 Web build 目录的分组，不用定向测试替代完整验收。

| 检查 | 实际结果 | 边界 |
| --- | --- | --- |
| 最终 focused：全部新增 application / monitor 测试 | **76 passed / 0 failed / 0 skipped** | SQLite + PG17、真实 API / 独立 worker / CLI、满 stdout / 假冒 FIFO、status / 配置 / 窗口 / journal 全部实跑 |
| 较早 PG16 发行包演练 | 失败后更换测试工具并完整重跑通过 | 原工具缺少 pg_trgm，未绕过迁移或弱化双 provider 断言 |
| `pnpm test` | **2500 passed / 0 failed / 465 skipped** | 根分组未配置 PG，环境条件跳过如实保留，不作为 PG 验收 |
| `TEST_DATABASE_URL=… pnpm --filter @bot-thk/api test:integration` | **774 passed / 0 failed / 0 skipped** | 真实 PG17，包含本轮双 provider 场景与既有跨 Web 进程回归 |
| `pnpm test:web` | **281 passed / 0 failed / 18 skipped** | 生产 Web build + HTTP 行为；PG 项由下一行实跑 |
| `TEST_DATABASE_URL=… pnpm --filter @bot-thk/web-rr test` | **299 passed / 0 failed / 0 skipped** | 包括不在 API integration inventory 的 Web PG 会话测试 |
| frozen install / `pnpm lint` / `pnpm format:check` / `pnpm typecheck` | 全部 exit 0 | 无依赖、lockfile 或门禁放宽 |
| `pnpm build` / `pnpm test:routes` / `pnpm --silent verify:publish --json` | 全部 exit 0 | 真实生产构建、路由及无邮件发布可见性 |
| `pnpm audit --audit-level high` | exit 0 | 完整 dev + prod 树；**仍有既有 @babel/core LOW GHSA-4x5r-pxfx-6jf8**，不是零漏洞声明 |
| `pnpm audit --json` | exit 1 | metadata：low=1，moderate/high/critical=0；未增加 ignore 或冒充全绿 |
| 新 package help / ADR 与全仓 Markdown 检查 / 两份证书复现 / `git diff --check` | 全部 exit 0 | 文档定向 26/26；主/独立证书逐字节复现一致 |

真实服务演练逐次比较业务 outbox 的 payload、调度/投递/死信时间、lease-token 等关键字段，
核对 monitor check 不改所比较的业务数据；
SMTP 为真实连接拒绝，API HTTP500/DB-health 为确定性 store wrapper 注入。
这些不是实际邮件供应商、宿主平台、外部告警接收者或生产回滚的验收。

## 新功能行证书与独立核对

本轮必须从上述精确基线重新计算，不累计历史 Notion/通知/Web 功能。
生产 TypeScript 的真正新增可执行行须排除测试、文档、配置、生成产物、
类型/import、纯接线/数据映射、等价搬运、重复片段和基线历史代码。
最终证书为 **1199 候选 − 397 语义扣除 = 802 行**，达到 ≥800 门槛。
扣除了函数/参数外壳、静态阈值/family/help、纯 DTO 转发、薄接线和基线重复。
Node 24 擦除类型后的独立 Espree 核对 **802 / 802，failures=[]**；首次独立
核对发现的 4 个运行时历史片段也已额外扣除，没有改低门槛或把类型差异当功能。

- [主计数程序](operational-monitor-lines.ts) / [逐行证书](operational-monitor-lines.json)
- [逐片段扣除账本](operational-monitor-line-exclusions.json)
- [独立核对程序](verify-operational-monitor-lines.ts) / [核对结果](operational-monitor-runtime-check.json)
- 证书 SHA-256：`8811e8f70aa3fd3bfff179f7b39a45e9823e47b23a425e7d43bad892e490058a`

复现：`node docs/audit/operational-monitor-lines.ts`，再运行
`node docs/audit/verify-operational-monitor-lines.ts`；源文件 hash 或扣除行文本改变
都会使证书/核对失效。审计程序、文档、测试和这份生成证书均不计生产功能行。

## 远端门禁与未授权事项

最终源 commit 的 Arena push CI 和 CodeQL **全部完成成功后才创建 PR**，随后
再检查独立 pull_request event 的同源门禁。精确 SHA/run/job 结果留在 PR 说明；
不把旧 PR、旧 head、仅列出测试或高阈值 audit 的 exit 0 说成新的完整通过。
沙箱无 Docker/Chromium，本地不冒称容器/浏览器已执行；这些仍由完整远端 gate 验证。

没有生产启用、外部账号接线、基础设施/域名/生产 DB 变化、自动修复/通知重投、
Notion 重放、moderation 扩权、merge 或关闭 #331。无新增源码依赖、lockfile 变更；
补充 package script 仅调用有限命令。已复核新增 diff；凭据模式扫描无发现，
只含显式 synthetic fixture/canary，无真实密钥、用户数据、大产物或无关修改。
