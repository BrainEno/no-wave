# 身份刷新可靠性：本轮独立验收与代码审计

Status: archived

- 日期：2026-11-12。
- 本轮唯一基线：`a2e4aacc68758da939b59d83329503b150937a97`。
- 分支：`arena/19b5a1dd-no-wave`。
- 范围：#318 / #316 / #319，以及重新构建前轮未进入主线的纯测试端口夹具修复。
- 不重计 PR #336 及任何更早轮次；不实施 #329/#330，不以本地测试替代 #331 公网资格验收；没有部署授权。

## 1. 交付行为

1. **真正的共享 coordinator，而非只加 flag/接口。** PostgreSQL 原子容量/claim，
   在 HTTP 前提交 owner，按 owner/state/deadline 完成；短结果采用逐行绑定的
   AES-256-GCM，LISTEN/NOTIFY 只是有界唤醒提示。丢失 owner/结果永不偷租约，
   长期保留不确定性 fence，不回退无锁刷新。
2. **明确的运行边界。** 多副本 + memory 拒绝启动；原生 Node ingress、Vite
   与生产 BFF/SSR 共享 AsyncLocalStorage 注入。请求/每键等待者、真实未结束回调、
   数据库并发、队列及存储容量均有界，取消一个请求不会取消兄弟的 owner。
   熔断避免故障库被反复击穿，过期异步工作不会错误释放真实 admission。
3. **安全可操作。** 显式迁移、schema/权限/WAL-logged/RLS/rewrite-hook 验证，
   强制事务同步提交，namespace 绑定真实规范刷新端点，阻止别名分裂代次。
   提供聚合 `status`、有界 `sweep`、缓存 `/readyz`、独立授权指标及有界停机。
4. **身份策略。** 清理离开 login/refresh/logout 请求路径，复用显式 maintenance，
   失败只在实际维护运行计数/脱敏。签发和校验共享不超过 900 秒的有效 access TTL，
   强制有效 `sid`；ADR 0018 明确修订兼容政策，不默默拒绝外部签发方。
5. **原有安全语义保持。** API 一次性 refresh 与真正 replay 原子撤销 family 不变；
   400/401、429、cookie、private/no-store、actor fence 及 mutation 最多一次重试不放宽。

具体配置、最小权限、长期 fence 容量、恢复旧库/切换 namespace/回退 memory 的风险，见
[运维规程](../operations/web-refresh-coordination.md)。#316 后必须安装并监控现有
[scheduled maintenance](../operations/scheduled-maintenance.md)，认证流量不再代替定时任务。

## 2. 独立生产行数：825 行

这不是 `wc`、diff 总增量或“实现 + 测试”之和。

- [审计脚本](identity-refresh-lines.ts) 固定本轮 base，只扫描本轮变更的生产 TS。
- 通过 AST/token 扣除 import、类型、无初始化字段、注释、空白/纯标点；与 **基线全部
  生产 TS/TSX** 规范化逐行比对，再删除本轮重复片段，而不只比对同名文件。
- [语义扣除账本](identity-refresh-line-exclusions.json) 额外扣除沿用的协议常量、
  旧结果返回/签名、相同拒绝分类、Node/Vite 薄包装、CLI 环境装载和旧停机日志。
  每项固定行号及原文，陈旧账本直接报错。
- [逐文件结果](identity-refresh-line-count.json) 固定源码 SHA-256、候选及接受行号。
  **847 候选 − 22 语义扣除 = 825 行有效新生产代码。**

| 独立行为组 | 接受行数 |
| --- | ---: |
| PostgreSQL 原子存储及 schema/durability 契约 | 181 |
| 跨实例 coordinator、唤醒订阅、故障熔断 | 247 |
| 加密结果、真实数据库工作 gate、请求等待者隔离 | 131 |
| 有界设置/DSN 验证、安全错误协议 | 77 |
| 运行时依赖探测、指标、受保护处理器、CLI | 150 |
| 原生开发/生产/BFF 注入与有界关闭 | 37 |
| API 新 TTL/sid 拒绝条件 | 2 |
| **合计** | **825** |

测试（包括端口夹具与真实 PG/双 Web 案例）、文档、配置、lockfile、生成物、审计脚本
本身均为 **0 行生产计数**。删除旧请求内清理本身也不靠负数/搬移算新增行。

可复现命令（若浅克隆缺少 base，先获取该确切提交，不能换成别的 base）：

```sh
node docs/audit/identity-refresh-lines.ts
node docs/audit/identity-refresh-lines.ts | cmp - docs/audit/identity-refresh-line-count.json
```

## 3. 红灯与修复证据

本地详细日志位于未纳入 Git 的 `verification/session-reliability/logs/`。
不可把缺失模块的预实现红灯冒充行为回归；关键行为另有实际断言失败：

- 身份第 128 次触发 cleanup、过长 TTL / 缺失 sid 先失败，再改行为。
- RLS readiness：原实现未拒绝被过滤的协调表，先观察到 `Missing expected rejection`。
- UNLOGGED/rewrite-hook：原实现错误接受崩溃可丢 fence 的表，再加契约拒绝。
- DSN：原实现错误接受 `statement_timeout=0` 等预算覆盖，再加白名单。
- upstream alias：同 namespace 原可创建两个不相干 claim，新增端点绑定后拒绝第二个。
- API 预算：曾因提前把 API timeout 当整个协调 deadline 而返回 503，回归要求 504；
  修正预算起点，保留显式 upstream timeout 语义。
- 指标密钥：先复现误用 AES/JWT/来源证明密钥仍可启用，再在启动时拒绝复用。

首轮完整真实 PG 回归确实出现 **2446 pass / 41 fail / 0 skip**，未掩盖：
40 项是本地临时数据库误建为 SQL_ASCII，触发既有媒体审计 UTF-8 拒绝；已新建
UTF-8 测试库，未放宽生产检查。另 1 项是旧 PG REST 夹具没有 `sid`，已改为
不同的 `sid` / `jti`，未降低授权断言。定向重验三项均通过。

另一次本地最终 Web 验证为 **264 pass / 2 fail / 0 skip**：两个生产夹具启动仅报告
`exit 1`，恰逢另一命令重建同一个 build 目录。构建并发是待验证的环境因素，现有输出
不足以断言唯一根因。已补充只保留固定错误分类、不回显原始输出的夹具诊断，并将
构建和最终 Web 重验隔离；不删除测试、不放宽断言。隔离构建后的最终批次为 267/0/0；启动失败的唯一根因仍不作无证据推断。
端口预留修复只消除同一夹具内部重复分配，不声称消除与外部进程之间的释放→监听竞态。

## 4. 验证层次与最终结果记录

完整命令的最终 pass/fail/skip 与正式 CI 链接记录在本轮中文 PR；以下是运行入口：

```sh
pnpm test
pnpm --filter @bot-thk/web-rr build
# 测试专用的 UTF-8 TEST_DATABASE_URL，夹具隔离 schema；不是生产数据库
pnpm --filter @bot-thk/api test:integration
node --test --test-concurrency=1 apps/web-rr/test/*.test.ts
pnpm typecheck
pnpm lint
pnpm format:check
pnpm audit --audit-level high
pnpm test:routes
```

最终本地分批结果（不相加冒充不重复案例）：

| 批次 | pass | fail | skip |
| --- | ---: | ---: | ---: |
| 根测试，无外部 PG | 2042 | 0 | 445 |
| API 完整 unit 脚本 | 563 | 0 | 0 |
| 完整真实 PostgreSQL integration 脚本 | 675 | 0 | 0 |
| 隔离构建后的最终生产 Web 全量，含真实 PG | 267 | 0 | 0 |

根测试的 skip 不是 PG 验收，已另由真实数据库 integration 执行；后者包含独立
进程生产链路。267 项最终 Web 复验还覆盖最后新增的压力指标与脱敏夹具诊断。

- 专项真实 PostgreSQL 案例覆盖独立连接池、密文、错误 key、abandoned/deadline、
  原子容量、schema/RLS/UNLOGGED/trigger、API alias、预算、最小权限角色与
  `synchronous_commit=off` 默认值，以及真实 CLI。
- 独立 OS 进程案例运行真实 `server.ts` + 构建后的 BFF，在 SQLite / PG 身份库上
  验证显式/自动/无 access cookie 的同代次只刷新一次。API 提交后 SIGKILL 胜出进程，
  另一进程只能返回 uncertain，不重放、不撤销 family。还覆盖请求断开、指标/ready
  故障恢复、正常排空，以及真实 Vite 原生入口与生产 SSR 共享协调。
- required `postgres-integration` CI 现先构建 Web，再明确运行共享存储/双 Web 测试，
  不是只有默认跳过的本地 green。合并只能依据本轮最终 source 的真实 CI。

本地沙箱没有 Docker 或可用 Chromium，因此不伪称本地容器/浏览器通过；正式 CI 的
容器镜像与浏览器检查仍需真实完成。安全审查发现的是基线已有 `@babel/core` 低危
GHSA-4x5r-pxfx-6jf8；`pnpm audit --audit-level high` 退出 0，高危/严重为 0。
`--json` 审计会对这项低危返回非零，不能与 required 命令的结果混淆。

Web 新增直接依赖 `postgres@4.1.0`，与 API 已有固定版本相同，Unlicense、Node >=18，
注册表标注解包约 310 KB；没有引入第二种驱动或身份库。驱动、密钥和协调代码保持在
Node 服务端，不得进入客户端 bundle。所有临时数据库、日志与下载工具均不提交。
