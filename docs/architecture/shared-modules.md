# 开发前先查：公共模块索引

最后核对：2026-11-12。此页是导航，不取代各模块的测试与 ADR。
Web 已按 [ADR 0012](decisions/0012-portable-web-framework-migration.md) / [0017](decisions/0017-nextjs-retired-one-web-application.md)
收敛为 React Router Framework Mode；当前版本看 `apps/web-rr/package.json`，不重新开展框架选型。

## 检索规则

1. 从下面的职责检索符号、调用者和测试，再决定复用、扩展或新建。
2. PR 写明查过的模块，以及不复用时的语义差异；相同名字不保证相同策略。
3. 不因“去重”扩大信任：API 仍负责授权、媒体归属、原子导入和持久业务事实。
4. 新的跨路由策略优先放共享边界，框架路由只适配参数与注入配置。

| 需要做什么 | 先查这里 | 不能越过的边界 |
| --- | --- | --- |
| BFF 认证、账户、写作、目录、通知、消息 | [web-http](../../packages/web-http/README.md) 的 `src/index.ts`、对应 handler/test | Cookie-only；Origin / actor / revision 不在路由里重写 |
| BFF 路由写法 | [模板与校验顺序](bff-routes.md) | 不恢复 app-local proxy 包装层 |
| 期限、响应字节、排队、熔断、下载 | `packages/web-http/src/upstream*.ts`；[运行边界](web-upstream-timeouts.md) | 无自动 mutation retry；不是 API 限流或授权 |
| 入站 JSON / 上传 | `packages/web-http/src/body.ts`、`request-admission.ts` | 路由自身小限额仍生效；不放宽 API 限额 |
| 会话轮换协调 | `packages/web-http/src/refresh-coordinator.ts`、`apps/web-rr/refresh/` | [ADR 0025](decisions/0025-browser-session-refresh-protocol.md)；不确定代次不能重放 |
| Web 入口、配置、SSR 数据源 | [web-rr](../../apps/web-rr/README.md)、`app/lib/runtime.ts` | 环境读取、Node 驱动和运维凭据不进浏览器 |
| UI 控件、样式、文案 | [web-ui](../../packages/web-ui/README.md)、`src/components/ui/parts.tsx`、`src/lib/ui-copy.ts` | 优先既有交互/无障碍语义，不只复制外观 |
| 写作状态、目录、集合与备份 | `web-ui/src/lib/writing-*.ts`、`authoring-catalogue-*.ts` | 保留未保存编辑、修订冲突、恢复和跨账户保护 |
| 通知与消息浏览器传输 | `web-ui/src/lib/notification-transport.ts`、`messaging-transport.ts` 及 actor/controller 模块 | 既有取消、幂等、限流恢复；不重复计入新增功能 |
| 公共内容、标签、feed、sitemap、SEO | `web-ui/src/lib/{api-content,public-pages,tag-pages,tag-feed,site-metadata,sitemap-catalog}.ts` | 显式 source/config；已配置 API 失败不得冒充 fixtures |
| 默认关闭的 Notion job | `application/notion-{durable-jobs,job-service,job-poll,job-drain,job-check}.ts`、两个 `*-notion-jobs-store.ts`；[操作规程](../operations/notion-import-jobs.md) | 无崩溃自动重放；数据库事务 fence、外部 key、独立有限命令；BFF 仍在 web-http，不进 UI |
| API 运维设置、生命周期 | `apps/api/src/infrastructure/{service-settings,service-operations,http-lifecycle}.ts` | 验证范围且不输出原始设置；Web 不导入 API 实现 |
| 有限只读告警、事件确认、配置切换 | `application/operational-{alerts,monitor,monitor-state,monitor-configure,monitor-status}.ts`、`infrastructure/monitor-{config,exposition,scrape,state-file,command}.ts`；[运维规程](../operations/operational-monitor.md) | 不连接业务 DB、不自动修复/重投；unknown 不作健康；私有 POSIX 日志与显式 ack，不是浏览器 upstream 或生产告警账号 |
| 离线告警交接、签名证据、持久收件箱 | `application/alert-handoff-{protocol,sender,inbox,reader,status,reconcile,verification}.ts`、`infrastructure/alert-handoff-{config,file,command}.ts`、`private-operation-file.ts`；[交接规程](../operations/alert-handoff.md) | 不联网/不导入业务 store；receipt 只证明持久接受；settle 与 consume 分离，禁止隐式 ack/身份重绑定/清空旧链 |
| 公钥-only 历史证据审阅、比较、检查点和只读追踪 | `application/alert-evidence-{authentication,history,episodes,receipts,review,compare,requirements,query,context,trace}.ts`、`infrastructure/alert-evidence-{config,manifest,file,command}.ts`；[证据规程](../operations/alert-evidence.md)、[ADR 0044](decisions/0044-public-only-alert-evidence-review.md) | 复用 handoff 的签名/事件/profile 与 private-operation-file/output；固定 trust/独立要求，不接受私钥、不发现文件、不写日志；过滤和 unsigned navigation token 不授予权限、不隐藏全局发现，历史不能证明健康/最终性 |
| API 业务与持久层 | `apps/api/src/application/`、`domain/`、`persistence/`；[API README](../../apps/api/README.md) | 业务事务与所有权由后端/数据库执行 |
| 构建工具的 glob / 目录匹配 | [glob-match](../../packages/glob-match/README.md) 与 `scripts/glob-*.test.ts` | 私有非递归工具适配器；不生成 glob 正则，不进业务层或浏览器，不承诺完整 picomatch API |

示例检索：`rg 'forwardAuthoringRequest|handle.*Request' packages/web-http/src apps/web-rr/app/routes`，
再读对应测试。花括号路径表示检索分组，不是一个名为花括号的文件。

## 明示的服务端例外

Web 刷新协调可选直接访问 PostgreSQL，只存 Web 运维 ledger，不存文章、媒体、
身份模型或 API 数据副本。单 Web 进程默认 memory；多实例必须按 ADR 0025 声明拓扑。
迁移、备份、密钥与 fence 的转移独立于 API provider transfer；见
[刷新运维](../operations/web-refresh-coordination.md)和[转移规程](../deployment/provider-transfer-runbook.md#web-refresh-ledger-is-a-separate-operational-store)。
该例外不授权客户端包持有数据库驱动，也不解决 ADR 0026 的 moderation 发布门禁。
