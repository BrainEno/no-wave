# 通知服务运维闭环：范围、行数与验收证据

Status: archived

## 比较基线与边界

本轮只比较 PR #335 合并后的 `d7ee85f4de274462fae7ba70d027567d18d507d0`，对应 #315、#320、#328。
前轮实现、测试、配置、文档、生成物均不重计。没有修改 ADR 0009 收件人时点、lease fencing、
认证/媒体所有权、生产限流或导入原子性；#318 跨副本 refresh 与 #331 实际主机资格验证不在本轮。

## 非测试实际开发量

按本仓库锁定的 Node/pnpm 安装依赖后，在本次提交上运行：

```sh
node docs/audit/notification-operations-lines.ts > /tmp/notification-operations-lines.json
cmp /tmp/notification-operations-lines.json docs/audit/notification-operations-line-count.json
```

- [可执行审计脚本](notification-operations-lines.ts) 固定上述基线，仅选择生产 TypeScript 改动。
- AST 排除 import、type-only 导出/注解、注释、空白及纯标点行；不计测试、smoke/audit 脚本、文档、配置和生成物。
- 归一化后与**全部基线生产 TS/TSX 文件**去重，再做本轮跨文件去重；旧 gauges、旧业务代码和搬移不能靠换文件重新计入。
- [人工语义扣除账本](notification-operations-line-exclusions.json) 进一步扣除旧设置/入口、dev 输出及启动拼装、旧 Web 503/停机片段、旧监听 Promise 的等价复用。每一条同时固定行号与原文，源文件变化会拒绝复用陈旧账本。
- [结果文件](notification-operations-line-count.json) 包含每个文件的 SHA-256、候选行、扣除行和最终接受行，可逐行复核。

| 行为组 | 有效非测试行 |
| --- | ---: |
| API 有界依赖就绪、可信积压采样、worker 进度就绪 | 213 |
| HTTP 绝对关停预算、终止性进程故障、独立启动期限 | 125 |
| worker 健康监听/运行闭环、停止后不再 claim | 141 |
| API 集成、同镜像角色、严格设置及跨平台入口 | 115 |
| dev 三角色、持续监督、进程树回收、有界角色探针与持久化配置 | 207 |
| **总计** | **801** |

机器文本/AST 去重后的 911 行再扣除 110 行语义搬移/重复，最终为 **801 行**。
新增测试与验证脚本全部独立于这个数字；行数不是测试通过或部署完成的证明。

## 行为验收与可复核位置

| 风险 | 权威行为验证 |
| --- | --- |
| 默认 dev 漏 worker、进程读到不同 SQLite 文件、私信静默排队 | `scripts/dev-notifications.test.ts`：真实 SQLite/PostgreSQL、默认三个子进程、公开 HTTP、2 秒内投递、幂等/收件人隔离 |
| 某一角色或 watch 背后应用死亡、存活但持续失去就绪、watch leader 留下后代 | `scripts/lib/dev-supervisor.test.ts`、真实 dev 故障用例：整套停止、非零状态、POSIX 后代回收 |
| 探针角色误认、响应体卡住/过大、取消无效 | `scripts/lib/dev-service-probe.test.ts`：8 KiB 上限及完整响应期限，固定失败类别 |
| 老通知积压被数据库健康掩盖、超时查询制造风暴或迟到结果冒充新鲜 | `api-readiness.test.ts`、`service-operations.test.ts`：单飞、保留可信样本、年龄推进、迟到拒绝、关闭立即释放探针 |
| 初始化永久挂住或停止后复活 | `api-startup-process.test.ts`：真实 PostgreSQL schema 锁、两种角色、SIGTERM 及自主启动超时、晚到资源只清理不启动业务 |
| 异常/rejection/监听器丢失时未清理或泄漏异常内容 | `process-failures.test.ts`：独立进程、强制故障、恰好一次持久化关闭、绝对期限、私密 canary 不出现在输出 |
| 挂起 HTTP、空闲/不完整连接、清理失败或监听 close 错误 | `http-lifecycle.test.ts`、`lifecycle-process.test.ts`：真实套接字及子进程，保留资源清理预算，诚实 forced/exit 报告 |
| 可选 metrics 拖住业务、持续 SQLite 队列饿死健康/停止信号 | `outbox-backlog.test.ts`、`worker-process.test.ts`：单飞不阻塞投递、超时/无效/迟到保留旧值、3,000 条真实事件仍可探测和停止 |
| 镜像只启动却没有实际投递 | required `container-image`：两个真实镜像、三个非 root 角色、迁移共享卷、Docker healthy、公开 HTTP 投递/隔离/幂等、重启和干净停止 |
| 浏览器可见通知与已读持久化脱节 | `e2e/messages.spec.ts`：浏览器发送 → 独立 worker → 收件人通知 → 标记已读 → 重载仍已读；该旅程没有通知路由拦截或直接 drain |

本地保存了各关键回归的先红后绿结果。冻结后的启动/进程故障组实际为 **19 passed / 0 failed / 0 skipped**，
就绪/采样/关停单元组为 **21 passed / 0 failed / 0 skipped**；文档/ADR/测试库存检查为 **28 passed / 0 failed / 0 skipped**。
冻结代码的真实浏览器私信/通知旅程为 **2 passed / 0 failed / 0 skipped**（36.9 秒）。
`typecheck`、`lint`、`format:check`、`openapi:check`、`slices:check`、`build`、`test:routes`、高危依赖审计及 diff whitespace 检查实际全部 exit 0。
完整全量测试与真实镜像结果以本 PR **最终 source SHA** 对应的运行记录为准，不借用前一轮 CI。

## 验收限制与发布纪律

- 本地没有 Docker daemon，静态 Dockerfile/CI 契约测试不等于实际镜像运行成功。
  必须由本 PR 最终 source 的真实 `container-image` 及全部 required checks 成功后才能合并。
- Windows drive/UNC/编码路径有平台无关单元覆盖，但本地 Linux 运行不能声称经过原生 Windows 进程验收。
- JavaScript 定时器不能抢占同步 SQLite/native/CPU 阻塞；外部强杀期限仍须大于应用预算。
  异步 PostgreSQL 锁、忙 SQLite 批次之间的事件循环公平性分别用真实提供器验证。
- 没有添加项目依赖；依赖审计失败不能静默绕过。探针/指标不含身份、payload、DSN 或异常正文，metrics 仍必须限制在受控网络。
- 没有部署、DNS/基础设施修改、生产数据库操作或 issue 关闭来替代验收。
