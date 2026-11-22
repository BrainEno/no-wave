# ADR 0052: 粘贴 Notion token，由服务器分段拉取数据库；token 只随请求经过、从不保存

- Status: Accepted
- Implementation: Done
- Date: 2026-11-22
- 修订：[ADR 0036](0036-notion-as-interchange-format.md) 决定 3（仅限本文所述的拉取端点；其余决定不变）

## 背景

写作台目前只能导入「上传导出文件」：作者先在 Notion 里导出 Markdown/ZIP，再选择
文件（P0-1～P0-6）。导出这一步正是作者最常卡住的地方：要找到导出菜单、记得勾选
「包含子页面」，还要解压或重新选择。另外，CSV 属性、英文对照页、日期等问题都源于
导出格式本身是有损的。直接读 Notion API 就没有这些问题：拿到的是
`scripts/lib/notion-client.ts` 已经在用的原始 page/block JSON，也就是导入端点本来
就接受的 bundle。

有两个事实约束了做法：

1. **浏览器无法直接调用 Notion API。** `api.notion.com` 不返回 CORS 头，Notion 也
   不建议从网页调用，所以 token 必须经过我们的服务端。原生客户端（Flutter）没有
   CORS 限制，仍可按 ADR 0036 决定 8 自行拉取后提交 bundle。
2. **ADR 0036 决定 3 写的是「Notion credentials never reach this server」。** 它的
   理由是：*保存* token 会让 API 成为第三方凭据的保管者，没有撤销机制，泄露影响
   超出我们自己的数据。网页拉取在字面上一定违反它，所以必须由本 ADR 明确修订。

## 备选方案与选择

| 方案 | 做法 | 结论 |
|---|---|---|
| **A. 服务器拉取（采用）** | `POST /api/v1/imports/notion/fetch`，由 API 复用 `collectNotionBundle` 的遍历逻辑调用 Notion，并在服务端切分工作 | 作者在审阅时选定 |
| B. API 单次只读中继 | 浏览器负责遍历，每一步只请 API 转发一个 Notion 调用 | 请求更短，但遍历逻辑会放到浏览器里，和种子脚本分成两份 |
| C. Web BFF 中继 | 同 B，中继放在 BFF | BFF 只代理到我们自己的 API（ADR 0041 第 9 条），且没有持久限流 |
| D. 不做 | 只保留上传 | 「尽可能少操作」做不到 |

### A 必须遵守的现有上限，以及因此做的切分

现有链路有两条硬上限，本 ADR **不放宽**其中任何一条：

- Web BFF 转发上游请求的超时最长 120 秒（`MAXIMUM_UPSTREAM_TIMEOUT_MS`；导入路由用 90 秒）；
- BFF 缓冲上游 JSON 响应最多 8 MiB（`API_RESPONSE_MAX_BYTES`）。

Notion 平均限速约 3 次/秒，200 页加上嵌套块通常需要数百次调用，也就是几分钟。所以
「一次请求拉完整个数据库」在现有链路里不成立。原计划中「服务器分批」在这里落实为：
**服务器按时间和字节预算分段拉取，每段一个请求，响应里告诉浏览器下一段从哪里继续；
续传信息不在服务器上保存。** 导入时的分批（8 MiB / 200 页 / 8 张图片，以及英文对照页
同批）仍由 P0-4 的 `planImportBatches` 负责，因为导入上限、试跑和一次确认的流程已经
实现在那里。服务端再实现一套导入分批，就会有两份规则互相漂移，还会削弱「只有作者
点击确认才写入」的两步流程。

## 决定

决定 3 修订为：

> Notion 凭据**不被服务器保存**。作者在写作台粘贴的 token 只存在于该页面的内存中，
> 随每一个拉取请求经过 API，在该请求结束时丢弃；不写入数据库、文件、日志、错误信息、
> 指标或任何响应。服务器仍然不是 Notion 凭据的保管者。

### 1. 端点与两种模式

`POST /api/v1/imports/notion/fetch`（BFF：`POST /api/authoring/notion-fetch`），需要登录。

- **`{ token, source, mode: "rows", cursor? }`**：列出数据库的行。`source` 是数据库
  链接或 ID（也接受数据源 ID），服务器解析出数据源后分页查询（每次调用 100 行），
  返回 `{ source: {id, title}, rows: [{id, properties, inTrash?, archived?}], cursor }`。
  `cursor` 为 `null` 表示已列完。一个请求最多返回 1000 行；行数据很小，200 行通常
  一个请求就能完成。
- **`{ token, mode: "pages", pageIds }`**：读取指定页面的正文块（深度优先，
  与 `collectBlocks` 相同）。`pageIds` 最多 200 个，按顺序处理，直到时间或字节预算
  用完。返回 `{ pages: [{id, blocks}], issues: [{id, code}], done: [...] }`，其中
  `done` 列出本段已经处理完的 ID（成功或带问题代码）。浏览器从 `pageIds` 中去掉这些
  ID，用剩下的发起下一段。这样续传状态完全在浏览器里，服务器不保存任何东西。

### 2. 预算（每个请求）

- 时间：开始新页面前检查，已用 45 秒就不再开始新页面；单页硬截止 75 秒，超时的
  页面记 `fetch-timeout` 并放进 `done`（不截断，不会被反复重试）。
- 字节：已收集的正文 JSON 达到 6 MiB 就结束本段；单页超过 6 MiB 记 `page-too-large`。
- 单页超过 2000 个块记 `too-many-blocks`，**不截断正文后导入**。
- 节奏：同一请求内两次 Notion 调用至少间隔 340 ms（≤ 3 次/秒）。Notion 返回 429 时，
  `Retry-After` 不超过 10 秒就在请求内等待后重试；更长则提前结束本段：若本段已有完成
  的页面，返回 200，已完成的页面在 `done` 中，并以 `retryAfterSeconds` 告诉浏览器等
  多久再发剩下的 ID；若一页都没完成，返回 `429 NOTION_RATE_LIMITED` + `Retry-After`。
- BFF 对这个路由使用 90 秒上游超时（与导入相同），不提高全局上限。

### 3. 出站请求的限制

与图片复制（`notion-image-fetch.ts`）相同：origin 固定为 `https://api.notion.com`，
不跟随重定向，每次调用超时 15 秒，按流计算字节（单次响应上限 4 MiB）。只调用三种
只读接口：`GET /v1/databases/{id}`、`POST /v1/data_sources/{id}/query`、
`GET /v1/blocks/{id}/children`。ID 必须是 32 位十六进制 UUID，游标只接受 Notion 游标
的字符集并限制长度，URL 由服务器拼接，`Notion-Version` 固定。没有写操作，也不能
透传任意路径。块数据按 `collectBlocks` 现有规则裁剪，只保留映射用到的字段。

### 4. token 的处理

- 只能放在请求体里（不进 URL 和查询串），只在本次请求中作为 `Authorization` 头发往
  Notion。
- 校验格式（`ntn_` 或 `secret_` 前缀，`[A-Za-z0-9_]`，长度 20～200），格式不符的
  直接拒绝，不会转发出去。（已由 [ADR 0053](0053-notion-oauth-without-stored-tokens.md)
  决定 6 修改：不再检查前缀，只检查长度 20～500 与 RFC 6750 bearer 字符集。）
- 错误、日志、指标和响应中都不出现 token，也不出现 Notion 的错误原文（Notion 的
  错误体可能回显内容）。错误映射为稳定代码：`NOTION_TOKEN_INVALID`（Notion 401，
  返回 422）、`NOTION_NOT_SHARED`（Notion 403/404：数据库未共享给该 integration，或
  ID 错误，返回 422）、`NOTION_RATE_LIMITED`（Notion 429，返回 429 并带
  `Retry-After`，限制在 1～900 秒）、`NOTION_UNAVAILABLE`（Notion 5xx、超时、响应过大
  或任何意外错误，返回 502）。请求本身的格式错误返回 400，信息只指出字段，不回显值。
  在 `pages` 模式中，单页 403/404 记 `page-unavailable`、其他失败记 `fetch-failed`，
  不影响其他页面；但 401 说明 token 已失效，后面每一页都会失败，所以结束整个请求。
- 测试要捕获 API 和 BFF 的日志输出，断言其中不出现 token 和 Notion 的错误原文。
- 浏览器端：token 只保存在页面内存中（输入框的 React state，以及当前这次拉取的
  ref，用于试跑时读取正文），输入框为 `type="password"`、
  `autocomplete="off"`，不写入 localStorage、sessionStorage、URL 或导入报告，离开页面
  即丢弃，也不发往拉取以外的任何路由。

### 5. 身份与限流

需要登录，BFF 的同源校验、Cookie 换 bearer、`no-store` 和 `Retry-After` 透传都与
`notion-import` 处理器相同。新增持久限流策略 `POST imports.notion.fetch`：每位作者
60 次、每个 IP 120 次 / 10 分钟。它与导入的 10/20 次额度相互独立：拉取不消耗导入
次数，导入的限流也不放宽。

限流只约束 10 分钟内发起多少次，不约束同时进行多少个；而每个拉取请求最长占用 75 秒、
内存中最多 6 MiB 正文。所以每个 API 进程另设并发上限：总共 8 个、每位作者 2 个。超出
时返回 `503 NOTION_FETCH_BUSY` + `Retry-After: 5`，写作台自动等待后重发；服务器不排队。

### 6. 拉取结果只是 bundle，写入流程不变

浏览器把行和正文拼成与导出文件同构的 bundle，交给 P0-3～P0-5 的选择工具，再交给
P0-4 的分批、试跑和一次确认。写入只发生在作者明确点击「确认导入」之后。
`missing-translation-page`、归属、planToken 绑定、幂等键、单次 8 MiB / 200 页 / 8 张
图片的上限和导入限流都不变。

### 7. 不新增服务端状态

没有任务表、缓存或 token 存储，也不在服务器上保存 bundle 或续传信息。重启只会丢掉
正在进行的那一段，浏览器重新请求即可。

### 8. 默认开启，可由运维关闭

`NOTION_FETCH_ENABLED=false` 时端点返回 `409 NOTION_FETCH_DISABLED`（与
`IMPORT_JOBS_DISABLED` 的做法一致：路由存在，只是本实例关闭了它），写作台提示改用上传。
部署时出站防火墙需放行 `api.notion.com:443`。

### 9. 复用种子脚本的遍历逻辑

把 `scripts/lib/notion-client.ts` 中的数据源解析、行查询和块遍历移到
`apps/api/src/infrastructure/notion-source.ts`。种子脚本的 `collectNotionBundle` 改为
调用它，行为不变；唯一的变化是超过块上限的页面改为报错，不再静默截断。

## 写作台界面

导入页分两个选项卡：「连接 Notion 直接拉取」（默认）和「上传导出文件」（现有）。
拉取选项卡有三步说明：

1. 在 Notion「设置 → 连接 → 开发或管理集成」创建一个内部集成，复制它的
   Internal Integration Secret；
2. 在数据库右上角「… → 连接」中添加这个集成；
3. 把令牌和数据库链接粘贴进来（链接或 32 位 ID 均可）。

（后续：写作台改为优先推荐个人访问令牌，它不需要第 2 步；配置了 OAuth 时还可以
「用 Notion 授权」，见 [ADR 0053](0053-notion-oauth-without-stored-tokens.md)。）

点「连接并读取条目」后只列出行（属性），标题出现在现有的选择列表里（默认全选，英文
对照页自动勾选）。点「试跑所选文章」时，先只为**仍勾选且还没读过**的页面读取正文
（显示「正在读取正文：n / m 页…」，可停止），读完自动进入试跑；作者看完合并报告，再点
「确认导入」。取消勾选的页面从不读取正文；再次试跑不会重复读取已读过的页面。读不到
正文的页面会被取消勾选，并在计划上方逐页写明原因（可重试的超时会在下次试跑时再读）。
选择文件会自动切换到「上传导出文件」。列出的行超过 2000 个时只列前 2000 个并给出提示。

## 后果

- **Notion 托管图片的签名 URL 约 1 小时后过期。** 拉取后应尽快试跑并确认；计划有效期
  15 分钟，过期后会自动重新试跑（P0-4）。确认时已过期的图片按现有规则移除并报告。
- **API 新增一个出站主机**，固定为 `api.notion.com`，只读、三种调用，有超时、字节上限
  和限流。攻击者只能用自己的 token 读取自己的 Notion 数据，并消耗自己的额度。
- **token 在服务器内存中最多停留一个请求的时长（≤ 75 秒）。** 进程内存转储理论上可能
  包含它。这比保存 token 的风险小得多，但不为零；运维规程应禁止在生产环境开启包含
  请求体的调试日志。
- **一次完整拉取可能需要数分钟**，分成多个 ≤ 90 秒的请求，进度可见，可随时停止。
- **OAuth、定时同步、写回 Notion 都不在本 ADR 范围内。** OAuth 需要保存 refresh token，
  正是决定 3 禁止的保管，需另起 ADR。

## 验证

- `notion-source` 单元测试：三种调用的 URL、方法和头；非法 ID 或游标被拒绝；不跟随
  重定向；超时；字节上限；429 处理；块上限报错而不截断；裁剪字段。
- 端点测试：模式与参数校验、token 格式、预算切段、`done` 与问题代码、错误映射、
  功能关闭时返回 409、新限流策略与并发上限生效；捕获日志，断言其中没有 token 和 Notion 错误原文。
- 种子脚本现有测试继续通过。
- BFF：同源、no-store、`Retry-After` 透传，token 不进入日志。
- 前端单元测试：行与正文拼成 bundle；游标与分段续传；429、段内 `retryAfterSeconds`
  与 503 自动等待且次数有限；没有进度的响应不会死循环；问题页被报告而不是静默丢弃；
  错误信息是固定句子，不回显 token。（链接解析在 API 端，由端点测试覆盖。）
- e2e（mock 拉取端点，不访问真实 Notion）：列出 → 取消一项 → 试跑（只读取勾选页面的
  正文）→ 确认；token 格式不符时不发请求；无效、未共享的提示；429 自动等待；超过块
  上限的页面被取消勾选并说明原因；导入请求里不含 token；刷新页面后 token 不再存在。
- `pnpm typecheck`、`pnpm lint`、`pnpm test`、`pnpm test:e2e` 全部通过。

## 实现记录（2026-11-22）

本 ADR 在同一分支上实现。与评审时的草稿相比，以下几处按实现时的发现做了调整，正文已同步：

- **关闭时返回 `409 NOTION_FETCH_DISABLED`，而不是 `404 FEATURE_DISABLED`。** 仓库里
  可由运维关闭的功能（`IMPORT_JOBS_DISABLED`）都用 409；404 会让客户端以为部署缺了路由。
- **Notion 拒绝 token 或数据库未共享时返回 422，Notion 不可用时返回 502。** 401/403/404
  是关于我们自己的会话和资源的，转发 Notion 的状态码会让写作台误以为本站登录失效。
- **`pages` 模式不需要 `source`。** 页面 ID 已经足够，多传一个没有用到的字段只会多一个
  校验分支。
- **段内遇到较长的限流时返回 200 和 `retryAfterSeconds`，而不是 429。** 已读完的页面
  不应因为后面一页被限流而作废。
- **正文延迟到试跑时读取，只读勾选的页面。** 草稿中「列出文章」和「拉取所选并试跑」
  两个按钮合成了现有的「试跑所选文章」，点击次数不变，但取消勾选的页面不再产生 Notion
  调用。
- **新增每进程并发上限（总 8、每位作者 2，超出返回 503 + Retry-After）。** 见决定 5。
