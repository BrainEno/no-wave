# #331 离线签名告警交接：审阅与验收记录

本轮基线 `1463bfcd727aabe6ded8cf90e80cde5815fca1b0`，工作分支
`arena/66ff089b-no-wave`。该基线已包含合并的 PR #370；本轮重新实现、测试并审计
新增交接功能，不累计上轮监测器、Notion 或 Web 功能行，也不借用旧 CI 结果。
设计见 [ADR 0043](../architecture/decisions/0043-offline-signed-alert-handoff.md)，
完整使用/恢复语义见[操作规程](../operations/alert-handoff.md)。

## 完成的任务与行为

1. 有界、版本化的 Ed25519 离线事件包及独立回执，固定身份/key pin、角色 domain、
   原事件 ID、整批序号/前驱、时间、每规则 episode 和数值语义验证。
2. sender 持久在途意图；prepare 先提交再发布，重试不替换原批次。显式 settle
   先保存 receipt intent，再用 monitor 自有锁确认完整匹配前缀，最后推进链。
3. 独立 inbox：先持久接收再发布原回执，最新批次幂等，旧批次/fork 拒绝；
   1024 条容量失败关闭，不把回执或已消费 cursor 偷偷清掉。
4. 显式消费前缀、最近回执恢复、签名且绑定精确快照的分页；读不加写锁、不改日志。
5. 事件年龄/接受年龄分开的进展状态、等待预算与只读跨日志对账；没有服务健康声明，
   多文件比较明确不是跨主机原子快照，也不自动修复。
6. 公钥-only profile 导出与证据核验，不向审阅工作站提供私钥；签名正确不等于
   数据新鲜、真实磁盘不丢数据、外部告警投递或人员收到通知。
7. 抽取并复用既有私有 POSIX journal 与有界输出，保留旧 monitor 行为；新增产物
   create-only 原子发布和同字节重试 fsync，不复制第二份锁/权限/rename 实现。

## 复用检索与架构边界

先查 shared-module index、`operational-{alerts,monitor,monitor-state,monitor-configure,monitor-status}`、
`monitor-{command,state-file,config}`、`entrypoint.ts`、Notion 有限 job 命令、
`notion-job-keys.ts`、identity/plan 的签名边界、通知 outbox 和 web-http upstream。

复用 monitor 事件/角色/严重性语义、closed-object 边界、精确前缀确认和入口检测。
将原 `monitor-state-file.ts` 的文件原语抽到 `private-operation-file.ts`，把原
monitor 输出 callback 抽到 `operation-command-output.ts`；旧 parser、配置切换、
时间/revision 政策仍由 monitor adapter 管理。新功能不是 HTTP upstream，不携带
Cookie/Authorization，不自动联网或重试；也不复用业务 outbox/Notion 队列，避免把
运维交接变成业务写权限。独立 inbox 是本地运维日志，不是新的领域持久层。

新增 TypeScript 模块分 application 协议/状态/只读政策与 infrastructure 文件/命令。
没有 REST/BFF/UI 变化、依赖或迁移变化。读取配置不使用 `.env`；私钥只存在显式
私有配置与内存 KeyObject，不进入 stdout、日志、事件或公钥 profile。

## TDD 与真实故障演练

高风险行为先 RED 再 GREEN，完整日志保存在忽略的 `verification/alert-handoff/`。
未删除/跳过/放宽既有测试或 CI。重点覆盖：

- 无效 key/算法/角色/公钥替换、未知字段、改签名、改事件事实、错回执、未来时钟；
- 冻结批次、追加事件、错误前缀、ack 后最终提交中断及精确重试；
- 收件箱上限 1024、明确消费后的恢复、旧序号/fork 拒绝和回执丢失恢复；
- 分页快照失效/签名损坏、读视图在真实 writer 锁下不改变任何文件；
- 两个实际 prepare/receive CLI 竞争；真实 monitor 锁使 settle 中断后重启恢复；
- 配置/状态/批次/输出的真实 FIFO；真正塞满 stdout 后有限退出，持久意图/回执保留；
- monitor 共享原语抽取后的旧测试，以及 JSON null 不能变成“缺失状态”、空快照
  的精确 no-op 仍须保留并重验磁盘。

回归实际揭露并修复：最终提交阶段改动先前交给持久端口的对象、接收事件中不可能
的数值事实/episode、ack-through 不能代替非倒退源 revision/时间，以及共享抽取时
空状态 no-op 与 JSON null 的语义差异。独立行审计另发现并扣除六个 erased/历史/
类型擦除后重复片段，未改低门槛。

## 本地验收

环境 Node 24.22.3 / pnpm 10.20.0，真实嵌入式 PostgreSQL 17.11；只监听回环，
使用一次性测试 schema，SQLite 为真实文件。新交接命令完全不依赖业务 store；双
provider 回归用于验证共享 monitor 原语抽取不影响既有实际 API/worker 场景。

| 检查 | 本轮实际结果 | 证据边界 |
| --- | --- | --- |
| 最终 focused：全部 handoff、monitor、共享原语与双 provider 场景 | **112 passed / 0 failed / 0 skipped** | 含实际独立 CLI、FIFO、锁竞争及 SQLite/PG API/worker/monitor；先前一次 PG 工具连接名错误已改为 initdb 的真实本地角色后完整重跑 |
| `pnpm test` | **2536 passed / 0 failed / 465 skipped** | 共 3001；未提供 PG 的根分组环境跳过如实保留，不能当双 provider 证明 |
| 真实 PG17 `pnpm --filter @bot-thk/api test:integration` | **774 passed / 0 failed / 0 skipped** | 包含双 provider 实际 API/worker/monitor 与跨 Web 进程契约 |
| `pnpm test:web` | **281 passed / 0 failed / 18 skipped** | 生产 Web build + 默认分组；PG 项另跑 |
| 真实 PG17 `pnpm --filter @bot-thk/web-rr test` | **299 passed / 0 failed / 0 skipped** | 包括不在 API integration inventory 中的 Web PG 会话用例 |
| frozen install / lint / format:check / typecheck / build / test:routes / verify:publish | **全部 exit 0** | 完整串行 12 阶段 runner 每阶段退出码已核对，未放宽门禁或依赖 |
| `pnpm audit --audit-level high` | **exit 0** | 完整 dev+prod 树；不是零漏洞声明 |
| `pnpm audit --json` | **exit 1，LOW=1，moderate/high/critical=0** | 既有 `@babel/core` / `GHSA-4x5r-pxfx-6jf8`；未增加 ignore、改阈值或隐瞒风险 |
| ADR/全仓 Markdown、初始化示例、公钥 profile、package help、两份行证书复现、diff 检查 | **全部 exit 0** | 文档 26/26；两份证书逐字节一致；示例只生成一次性私有 keys |

SQLite/PG 的 API HTTP500/DB-health 为既有确定性 wrapper 注入；SMTP 是本地真实
连接拒绝。两进程交接通过复制事件/回执文件实跑，不包含真实跨主机传输或外部通知。
沙箱没有 Docker/Chromium，本地不冒称容器/浏览器验收；完整远端 CI 仍必须通过。

## 真正新增生产功能行

从本轮精确基线计数，只看新增生产 TypeScript 可执行 token；去掉注释/空白/标点、
类型/import、测试/fixture/审计脚本、配置、文档、静态 help/schema、函数参数外壳、
纯 DTO/接线、基线历史运行时与新片段重复。等价抽取的 journal/有界输出、monitor
adapter 和 handoff 文件薄适配全部不计入。

最终证书：**1394 候选 − 572 语义扣除 = 822 行**，独立 Node 24 类型擦除 +
Espree 核对 **822/822，failures=[]**。初次 737 行不足时，没有回收扣除或降低
门槛；补足公钥独立核验与真实连续性/源回退防护，再重新审查并扣除了六个独立
核对拒绝的片段。采用普通 Prettier 排版，不以复制、仅换名或生成代码补足功能。

- [主计数程序](alert-handoff-lines.ts) / [逐行证书](alert-handoff-lines.json)
- [逐片段扣除账本](alert-handoff-line-exclusions.json)
- [独立核对程序](verify-alert-handoff-lines.ts) / [核对结果](alert-handoff-runtime-check.json)
- 证书 SHA-256：`52c477b3886b952140ae896c042d321bfa5398468a5916009e9b83ec28b17ebf`

复现：`node docs/audit/alert-handoff-lines.ts`，然后
`node docs/audit/verify-alert-handoff-lines.ts`。源 hash、精确扣除行文本和 baseline 都
受检查；之前轮次证书是各自源 commit 的历史证据，不用当前抽取后的文件替代旧 hash。

## 远端门禁、授权与剩余事项

最终源提交的 push CI/CodeQL 必须全部完成成功后才创建 PR；再检查独立
pull_request event 的同一源 commit 和每个 job，不只看 rollup 或旧 green SHA。
精确 run/job 链接、PR 状态与最终合并结果在中文 PR 说明/本轮汇报补齐。
用户已授权：CI 全通过、无冲突/阻塞时先转 Ready for review，再直接合并；不使用
自动合并来代替等待和核验。此授权不扩展到部署、生产迁移或外部账号接线。

#331 仍开放：真实宿主冷启动/休眠/存储、跨主机安全传输、外部告警通知到人、监控
自身失联、密钥轮换/保管、备份恢复/回滚、其余 Phase gate 归属和 Notion checkpoint。
没有部署、域名/基础设施变更、业务 DB mutation、通知重投、Notion replay 或 moderation
扩权。已复核新增源码/依赖边界、凭据模式及最终 diff，无真实密钥、真实用户数据或
无关修改；只保留代码、测试、文档和必要行证书，不提交一次性 keys、数据库、下载
工具或大日志。根依赖、lockfile、CI workflow 与既有门禁阈值均未修改。
