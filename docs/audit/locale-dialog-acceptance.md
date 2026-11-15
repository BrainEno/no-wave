# #329 / #330：双语通知与顶栏弹层验收

## 范围与行为

本轮固定增量基线：`cb437926913c4249e20e53125450ca6c13ebfcbf`。不重计前轮实现，不修改 API 授权、notification controller/provider/transport、持久化读状态、媒体所有权、导入协议或生产限流；不部署。

### #329：同页切换与通知本地化

- `locale-navigation.ts` / `locale-query.ts` 仅解析真实注册的双语页面。`/authors`、`/feed`、`/messages`、会话详情和对应 `/en/*` 双向同页保留；契约测试直接枚举 `apps/web-rr/app/routes.ts`，并验证其他双语页面。
- 不假定文章/标签的译文身份：跨语言时明确返回相应目录。同语言链接保留详情；只携带各 loader 实际消费且验证通过的查询状态。拒绝外部路径、歧义参数、非法编码和凭据搭车，不制造 `/en/write`。
- 增加 `/notifications` 与 `/en/notifications`。页面 loader 只检查非敏感 session marker，返回私有、`no-store`、`noindex` 的空 shell；marker 不是 API 授权。私有行仍完全来自原有客户端 actor-fenced transport，两个页面、写作台与铃铛共用 shell-scoped controller。
- `NotificationInbox` 接收 locale，显示对应语言的行、日期、筛选、反馈与恢复登录入口；已知通知按 payload 的作品 edition 跳转。
- 未知通知进入本语言 Inbox，合法、唯一的 UUID `notice` 只作已授权列表内 locator。筛选、语言切换和安全登录返回保留它；等待、被筛选、较旧和不存在的状态分开说明，提供显式 Jump，不自动扫描旧页或标记已读。
- 全页 Inbox 支持已加载数据的类型/读状态筛选、UTC 日期分组、行级方向键/Home/End 导航、加载更多后的合理落点和同 actor 的操作反馈。已加载计数与全局未读摘要不混用。

### #330：模态与非模态焦点生命周期

- 打开即进入面板；Escape/显式关闭返回原触发控件。两个顶栏面板由同一个 owner 管理，导航或替换时不抢回旧触发器。
- 移动菜单为模态，动态计算双向 Tab 边界，对背景兄弟分支施加并回收 inert 与滚动锁。保留原有样式及后来其他 owner 修改的值/优先级；新增背景节点也隔离。
- 铃铛是非模态：Tab 可离开；焦点已经回到触发器时，不截获其文档原生 Tab 顺序。外点、离开、用户选区和新焦点优先于自动修复。
- 原生确认 dialog 独占顶层，菜单暂停隔离；取消/Escape 回到菜单原项，确认离开后才聚焦新页面。
- 异步按钮禁用/移除时记忆语义行及 action，而非陈旧的数字索引。请求、导航提交与下一帧之间，指针、键盘、滚轮、触摸滚动、视口或窗口变化都可以撤销待执行的焦点操作；未完成任务在路由、身份或组件生命周期变化时回收。
- 选择定位以本次 URL 意图的已验证 actor 为起点，同账户路由重验证的暂空状态不误判为换号；即使账户替换发生在首帧前，也不会自动跟随新 actor。新账户需要显式 Jump。

近期列表为空但服务端全局未读数已确认归零时，反馈真实的“已没有未读通知”，不再误报写入失败；错误、pending 和换号门禁仍优先，不补造任何行或 readAt。此边界先由单元 RED 复现，再验证真实浏览器中的 controller/UI 反馈。

## 有效生产行审计

复现命令（Node.js 24、仓库冻结依赖）：

```sh
node docs/audit/locale-dialog-lines.ts
```

- 只计固定基线后新增且有运行时 token 的生产 TS/TSX 行。
- 自动剔除空白、注释、纯标点、imports、类型、全库基线已有的规范化行和本轮重复片段。
- 测试、审计/验证脚本、文档、配置、CSS、翻译字典、静态 JSX-only 文案以及字体等生成物不参与计数。
- 再经独立的逐行语义复核，以 `locale-dialog-line-exclusions.json` 精确扣除搬移、改名、薄包装、静态标签、无初始化的类型占位等；额外扣除了尚无生产消费点的 model.loaded/visible 返回字段。行号和原文必须同时匹配，否则脚本失败。
- 最终 **895 个候选 − 91 个语义扣除 = 804 行有效生产代码**。逐文件行号、源码 SHA-256 与总数见 `locale-dialog-line-count.json`；不使用新增测试或字体文件凑数。

## 已执行验证

以下是本地实际结果，不替代 PR 最终 HEAD 的 CI。

| 检查 | 通过 | 失败 | 跳过 | 说明 |
| --- | ---: | ---: | ---: | --- |
| 根 `pnpm test` | 2064 | 0 | 445 | 此入口未设置 `TEST_DATABASE_URL`；PostgreSQL 合同另行实跑 |
| API `test:integration`，真实 PostgreSQL 17.9 | 675 | 0 | 0 | 临时独立测试库/隔离 schema，不是模拟 PG |
| API `test:unit` | 563 | 0 | 0 | 原有 API 行为完整保留 |
| Web 全套，连接真实 PG | 276 | 0 | 0 | 包含私有 shell、HTTP/cache、账户与共享刷新 |
| 5 个通知/焦点浏览器 spec | 45 | 0 | 0 | Chromium；焦点、locale、同步及真实账户切换/隔离 |
| portable-stack / SQLite | 9 | 0 | 1 | 唯一 skip 为 PG 专属 outbox drain |
| portable-stack / PostgreSQL + worker | 10 | 0 | 0 | 真实 worker/drain 与全链路 HTTP |

`pnpm typecheck`、完整 `pnpm lint`、`pnpm format:check`、生产 `pnpm build`、`pnpm test:routes`、无邮件发布可见性验证及 `pnpm fonts:check` 均成功。format 脚本只覆盖仓库定义的三个格式化文件，不声称全库格式化。

选择定位、异步/导航提交到 paint 的意图间隙、返回铃铛后的反向 Tab、CSS 优先级所有权均先由真实浏览器复现 RED，再修复并合并复测；未删除隐私、actor header、读状态或重试次数断言。旧安全测试在框外操作后先验证非模态铃铛关闭，再于授权恢复后重新打开；隐藏 DOM 的清理仍保留断言。`pagehide(persisted)` 用合成事件验证同步清理，不能据此声称命中了真实 BFCache。

全量 183 条浏览器用例、容器镜像与 `required-checks` 以本轮最终提交的 CI 结果为准。当前环境没有 Docker，因此未运行本地 Docker 容器镜像验证及依赖 Docker 的 `pnpm test:all` 总入口；没有用本地部分绿替代最终 CI。分支保护设置 API 为 403，也不视为免除 required checks。

## 字体、依赖与安全审查

- 本次 chrome 中文 literal 变化触发既有字体 recipe 校验失败。已运行原有 `pnpm fonts:generate`，使用固定 SHA/校验和的上游字体和许可证生成 CSS、manifest、WOFF2，再通过完整字体校验。大量 Noto Sans SC 分片变化是既有分片算法重新分配字符的结果，生成物均不计功能行。
- 下载时只为本地 Node 使用系统 CA（`--use-system-ca`），没有关闭 TLS 校验、修改生成器或绕过字体测试。字体源 cache、本地 Chromium/PG 工具及测试库均未纳入 Git。
- 应用依赖与 lockfile 未改，未新增运行时/重型焦点依赖。`pnpm audit --audit-level high` exit 0；完整 JSON 审计仍报告基线 `@babel/core@7.28.5` 的 **1 low、0 moderate/high/critical**（`GHSA-4x5r-pxfx-6jf8`），不能称为零告警。
- API、授权、actor fencing、notification persistence、读状态协议、生产限流及已有标签/产品能力均未修改。私有 marker 只开 shell，URL `notice` 从不提供 actor 或获取跨账户资源的权限。
- 差异审查未发现真实凭据、生产数据、部署或无关业务变更。PR 的 CI 和合并状态以 GitHub 最终 HEAD 为准，不使用历史 PR 的成功记录充当本轮证据。
