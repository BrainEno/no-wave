# Web/BFF 资源边界与共享模块收敛审查

核对日期：2026-11-12。基线：`420f37cff589f3a26c62caa14bedf9cc54560be0`。
本页不代表部署、合并授权、公网容量资格或 required CI 已通过。

## 范围与职责

- #348：38 个 BFF resource 直接导入共享 handler，删除四个 app-local proxy 配置包装；
  [模板](../architecture/bff-routes.md)说明方法、Origin、参数/body、cookie、actor、上游及返回的职责。
- #359：共享 UI 的 API/site/mail/feed/sitemap 不再读取 ambient environment；应用显式注入。
  `.env.example` 补齐 API_SERVICE_URL、两个 RR build 路径和资源保护配置，保留部署别名。
- #343 / #358：按已接受 ADR 0012/0017 记录 RR Framework Mode；
  [公共模块索引](../architecture/shared-modules.md)要求实现前先查；三个入口 README 不超过 80 行。
- #344：修复七个相对证据链接；Markdown 检查扩至所有 tracked 和未忽略的新文档，
  并用此前不在白名单内的坏链接验证失败。
- #362：明确 ADR 0025 的 Web-only PostgreSQL refresh ledger 例外，
  及独立凭据、迁移、备份、fence 恢复和 provider transfer 责任。它不是 API 数据库副本。

新增运行行为集中于 `packages/web-http/src/upstream*.ts`、`streaming-json.ts`、
`request-admission.ts`、`body.ts`，以及 Web 原生/Vite intake 和进程上下文。
后端/数据库的媒体归属、revision、签名 import plan、每作品原子性未转移到客户端。
ADR 0026 未解决的发布门禁保持关闭，没有实现 moderation/report/admin 服务。

## 行为与兼容性审查

1. **绝对期限**覆盖排队、headers 和 body；浏览器取消单独归类。单调时钟 checkpoint
   防止计时器被微任务饿死后仍返回成功或才发出排队 mutation；缓冲和流式读取逐次检查。
   这不是 JavaScript 的 CPU 抢占或硬实时保证。
2. **有限隔离容量**：data/auth/bulk FIFO；request intake 预留原始 body 内存并持有到
   整个 exchange 结束。满载、关停、排队过期与熔断失败关闭，不做自动 mutation retry。
3. **真实物理所有权**：忽略 abort 的 fetch 不提前归还槽；cancel receipt 未确认的 body
   也不提前归还。已被其他 reader 锁定的异常响应没有取消凭据，保守保留未知所有权，
   不能把锁冲突当作源确认；修复适配器并替换 transport／进程才能恢复。
   调用者不等待失控 cancel；有限 drain 明确报告未排空。
4. **响应验证**：用途字节 fence、严格 UTF-8/JSON、提前拒绝已声明非 JSON 的成功文档，
   5xx 脱敏；业务 4xx 恢复字段保留。原生 fetch 保留编码前 headers，因此 gzip 的
   Content-Length 不误当 decoded 长度；无编码声明和实际 decoded bytes 仍分别检查。
5. **入站读者**：长度语法、实际长度一致性、正整数 byte ceiling、非法 chunk、借用 buffer
   后续变更及空 chunk 饥饿均失败关闭；不把来源错误/取消 reason 传给浏览器。
6. **下载**：Notion 成功附件按需求串流，不 clone/text 整个 bundle，EOF 前拥有 bulk 槽与期限。
   增量 JSON 保留 O(depth) 加当前 chunk；不是导入 schema/签名验证。
   2 GiB 是只用于串流的防御 fence，高于当前 Node 单次 JSON serializer 的最坏 UTF-8 输出，
   不是业务限额提升；真实 mapper 的合法 50 作品/100 语言页回归超过 512 MiB。
7. **刷新与身份**：cookie-only、同 token `/me`、轮换后 actor 重查；401 无可读诊断体仍只
   协调刷新一次。取消一个 waiter 不撤销 shared owner；内存或注入 coordinator 忽略 context
   也不能无限钉住调用者。轮换后失败继续保留 rotated cookies。
8. **运维**：固定标签描述逻辑结果、实际 admission wait、最老物理操作、detached/cancelling
   阶段、取消确认/拒绝及确认等待总时长。一个物理操作重复 cancel 不重复计数；无动态路径、
   账号、原始错误或凭据。受保护 metrics 端点使用独立凭据、有限输出和频率。
9. **运行装配**：原生 server 与 SSR 保持 HTTP 错误类和 AsyncLocalStorage 的同一模块身份。
   Vite 同样有 intake/期限/上下文；客户端 bundle 不获得 server store、PG 驱动或运维密钥。

操作范围、默认值的依据与限制见[运行边界](../architecture/web-upstream-timeouts.md)。
新进程预算不是生产容量 SLA；真实流量、代理与多副本部署仍需 owner 的托管资格审核。
旧 API_GRAPHQL_URL、API_SERVICE_URL、NEXT_PUBLIC_SITE_URL 的删除须另行确认。

## 独立有效新增行复核

**812 行新增生产功能**；不是 Git 总增量，也不包含测试。
证据分为三个互相约束的层次，不冒称另有独立人工审阅者：

- [主计算器](web-upstream-lines.ts)：从固定基线取 Git 实际新增行，Babel 检查运行 token；
  去除 imports、types、comments、空白/标点、re-export、静态 JSX，去除整个基线生产源码
  和本轮新增片段的规范化重复；只看限定生产 TS 范围。
- [逐片段排除账本](web-upstream-line-exclusions.json)：保存源行与文本以防漂移；进一步扣除
  纯配置/source 注入、路由接线、默认容量设置、历史 metrics 抽取、旧 reader 分配/拼接、
  改名/拆行和既有错误映射。三个 README、文档修复、审计器、测试及所有 UI 注入均不计。
- [第二条独立检查](verify-web-upstream-lines.ts)：Node 原生擦除 TS，再用 Espree 检查 JS
  token、Git 新增位置、源 SHA-256、擦除后历史/新增重复。它额外识别并扣除了主计算器中
  改类型的参数、通用方法声明和等价 return，不能以另一份同源计数冒充独立复核。

[逐文件/逐行证书](web-upstream-lines.json)与[独立运行时确认](web-upstream-runtime-check.json)
固定本轮源文件 hashes。两条路径都确认 812；任何源码、排除行或基线改变都须重算。
这不重新计算 PR 363 的 806 行，也不计算 continue_tags 或任何历史交付。

```sh
node docs/audit/web-upstream-lines.ts > verification-web-upstream-lines.json
cmp docs/audit/web-upstream-lines.json verification-web-upstream-lines.json
node docs/audit/verify-web-upstream-lines.ts
```

临时计数输出用完自行移出补丁；它不是生产代码。Node 的 type-erasure experimental warning
不改变比较结果。第二路径使用 frozen ESLint 工具链已有的 Espree，没有新增依赖。

## 验证与尚需外部证据的边界

- 根 `pnpm test` 明确登记新 HTTP suites；Web suite 通过真实 production bundle 和真实 Vite
  进程验证共享上下文、503、保留 session lane、真实 socket 取消及 header/receive timeout。
- `request-body-deadline`、`upstream-clock`、`upstream-release` 保护长 body、饥饿计时器与
  取消确认所有权；native gzip fixture 不用 mock 假定 Content-Length 的含义。
- 大型 Notion fixture 使用实际 API mapper 和合法作品边界，不用任意填充大字符串代替协议。
- 运行 `pnpm typecheck`、`pnpm lint`、`pnpm format:check`、`pnpm test:web`、
  `pnpm test:routes`；mail-free `verify:publish` 验证独立 SQLite → API → BFF → SSR。
  `verify:publish` 会重建共享 build，不能与消费该目录的 route smoke 并行。
- 精确 pass/fail/skip、最终 commit 的 CI 链接、冲突/依赖检查写在中文 PR 说明中；
  不用旧 PR 的 CI、未配置 PostgreSQL 的 skips 或仅本地绿色替代当前 required checks。
- 沙箱没有 Docker/psql/已下载的 Playwright browser；真实 PostgreSQL、双 Web、容器、
  浏览器与 CodeQL 须由当前 head 的 CI 提供证据。没有授权合并或部署。
