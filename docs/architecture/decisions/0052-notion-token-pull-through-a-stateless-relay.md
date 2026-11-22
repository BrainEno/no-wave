# ADR 0052: 粘贴 Notion token 直接拉取：浏览器逐步拉取，API 只做无状态的单次只读中继

- Status: Proposed
- Implementation: Not started
- Date: 2026-11-22
- 修订：[ADR 0036](0036-notion-as-interchange-format.md) 决定 3（仅限本文所述的中继；其余决定不变）

## 背景

写作台现在只能导入「上传导出文件」：作者在 Notion 里导出 Markdown/ZIP，再选择
文件（P0-1～P0-6）。导出这一步正是作者最常卡住的地方：要找到导出菜单、记得勾选
「包含子页面」，导出后还要解压或重新选择。另外，CSV 属性、英文对照页、日期等问题
都源于导出格式本身是有损的。只要能直接读 Notion API，这些问题都不存在：拿到的
就是 `scripts/lib/notion-client.ts` 已经在用的原始 page/block JSON，也就是导入端点
本来就接受的 bundle。

有两个事实约束了做法：

1. **浏览器无法直接调用 Notion API。** `api.notion.com` 不返回 CORS 头，Notion
   官方也不建议从网页调用。所以 token 必须经过我们的某个服务端进程，纯前端方案
   不存在。原生客户端（Flutter）没有 CORS 限制，可以继续按 ADR 0036 决定 8 自己
   拉取后提交 bundle。
2. **ADR 0036 决定 3 写的是「Notion credentials never reach this server」。** 它的
   理由是：*保存* token 会让 API 成为第三方凭据的保管者，没有撤销机制，泄露影响
   超出我们自己的数据。这个理由针对的是保管，不是一次请求内的转手；但字面上任何
   网页拉取方案都会违反它，所以必须由本 ADR 明确修订，不能悄悄绕过。

## 备选方案

| 方案 | 做法 | 主要问题 |
|---|---|---|
| A. 服务器整库拉取 | `POST /api/v1/imports/notion/fetch {token, sourceId}`，API 调用 `collectNotionBundle` 拉完整个数据库，并在服务端分批导入 | 一次请求要调用 Notion 数百次（Notion 平均约 3 次/秒），200 页需要数分钟，超过代理和 HTTP 超时；token 在服务器内存里停留整个过程；进度无法显示，中断后只能重来；`collectNotionBundle` 超过 `maxPages`/`maxBlocksPerPage` 时会**静默截断**；服务端分批会重复 P0-4 已经在前端实现的分批、试跑、确认流程 |
| B. **API 单次只读中继（采用）** | 浏览器负责遍历：每一步（读数据库、查询一页行、读一页子块）是一次 `POST /api/v1/imports/notion/relay`，API 只转发这**一个**白名单内的 Notion 只读请求，然后返回裁剪后的结果；拉齐后在浏览器里拼成 bundle，交给现有的选择、试跑、确认流程 | token 会经过 API，但每次只在单个请求的内存里存在毫秒到秒级，不落盘、不记日志；需要新增一个出站主机和一条限流策略 |
| C. 只在 Web BFF 中继 | 同 B，但中继放在 `apps/web-rr` 的 BFF | BFF 目前只代理到我们自己的 API（ADR 0041 第 9 条：「Cookie 代理不扩大信任」），没有身份判定和持久限流（ADR 0011 在 API 里）；要么重做一遍，要么每步再问一次 API，等于 B 加一层 |
| D. 不做 | 继续只支持上传导出文件 | 最安全，但「尽可能少操作」做不到 |

## 决定

**采用 B：浏览器驱动、API 无状态单次中继。** 决定 3 修订为：

> Notion 凭据**不被服务器保存**。作者在写作台粘贴的 token 只存在于该页面的内存中，
> 随每一个只读中继请求经过 API，用完即弃；不写入数据库、文件、日志、错误信息、
> 指标或任何响应。服务器仍然不是 Notion 凭据的保管者。

具体规则：

1. **中继只能做三件事，且请求是结构化的，不是任意路径。** 请求体为
   `{ token, call }`，其中 `call` 只能是以下三种之一：
   - `{ kind: "database", id }` → `GET /v1/databases/{id}`（解析出数据源和标题）；
   - `{ kind: "query", id, cursor? }` → `POST /v1/data_sources/{id}/query`（每页最多 100 行，只用于列出行和属性）；
   - `{ kind: "children", id, cursor? }` → `GET /v1/blocks/{id}/children`（每页最多 100 个块）。

   `id` 必须是 32 位十六进制 UUID（允许带连字符）；`cursor` 只接受 Notion 游标的
   字符集，长度有限制。URL 由服务器拼接，origin 固定为 `https://api.notion.com`，
   `Notion-Version` 固定为 `scripts/lib/notion-client.ts` 中的版本。没有写操作、
   搜索、用户、评论，也不允许透传任意路径或方法。这样它不可能被当成 Notion 的
   通用代理，更不是任意 URL 代理。

2. **出站请求与图片复制同样受限**（`notion-image-fetch.ts`）：主机固定，不跟随重定向，
   超时 15 秒，响应按流计算字节、上限 4 MiB（一页 100 个块远小于此）。返回内容按
   `collectBlocks` 现有规则裁剪，只保留映射用到的字段（`id`、`type`、`has_children`、
   类型数据；行的 `id`、`properties`、`in_trash`、`archived`）。审计字段和用户对象
   不转发。

3. **token 的处理是本 ADR 的核心。**
   - 只能放在请求体里（不进 URL 和查询串），只在本次请求的作用域内使用，作为
     `Authorization` 头发往 Notion。
   - 校验格式（`ntn_` 或 `secret_` 前缀、长度上限），不像 token 的字符串直接拒绝，
     不会转发出去。
   - 任何错误、日志、指标、异常信息和响应都不包含 token，也不包含 Notion 的错误
     原文（Notion 的错误体可能回显内容）。错误只映射为稳定代码：
     `NOTION_TOKEN_INVALID`（401）、`NOTION_NOT_SHARED`（403/404，提示把数据库
     共享给该 integration）、`NOTION_RATE_LIMITED`（429，透传 `Retry-After`）、
     `NOTION_UNAVAILABLE`（5xx/超时）、`NOTION_RESPONSE_TOO_LARGE`。
   - 测试要捕获 API 和 BFF 的日志输出，断言 token 和错误原文都不出现。
   - 浏览器端：token 只保存在 React state 中，输入框为 `type="password"`、
     `autocomplete="off"`，不写入 localStorage、sessionStorage、URL 或导入报告；
     离开页面或点「清除 token」即丢弃；除中继外不发往任何路由。

4. **身份与限流沿用 API 现有边界。** 中继需要登录（BFF 用 Cookie 换 bearer，
   同源校验，`no-store`，透传 `Retry-After`，与 `notion-import` 处理器相同）。新增
   持久限流策略 `POST imports.notion.relay`：每位作者 600 次、每个 IP 1200 次 / 10 分钟。
   这个额度和导入的 10/20 次额度相互独立，拉取不消耗导入次数，导入的限流也不放宽。
   浏览器自行把请求节奏控制在 3 次/秒以内，并按 `Retry-After` 自动等待（复用 P0-4 的
   倒计时）。

5. **两步拉取，先列行，再只拉选中的正文。** 第一步只查询行（每 100 行一次请求），
   直接在现有的选择列表中显示标题（P0-3：默认全选、搜索、反选、英文对照页自动
   勾选）；第二步只对勾选的页面读取子块（深度优先，与 `collectBlocks` 相同）。拉取
   时显示「第 n/m 页」进度，可随时停止；已拉取的页面保留，可以继续拉取。

6. **不静默丢数据。** 不沿用 `collectNotionBundle` 的静默截断：
   - 单页超过 2000 个块时，这一页不放进 bundle，只给出可见的提示（「《…》超过
     2000 个块，未拉取，请改用导出文件」），绝不截断正文后导入；
   - 已删除（in trash）或已归档的行照常标记，由现有映射报告；
   - 拉取失败的页面逐页列出，不影响其他页面。

7. **拉取得到的只是 bundle，后续全部沿用现有流程。** 拉取结果交给 P0-3～P0-5 的
   选择工具和 P0-4 的分批、试跑、一次确认；写入只发生在作者明确点击「确认导入」
   之后。`missing-translation-page`、归属、planToken 绑定、幂等键、8 MiB / 200 页 /
   8 张图片的单次上限、导入限流，全部不变。

8. **不新增服务端状态。** 没有任务表、没有缓存、没有 token 存储，也不在服务器上
   保存 bundle。这是一个纯函数式中继，可以水平扩展，重启不丢任何东西（丢的是浏览器
   里尚未提交的拉取进度，作者重新点一次即可）。

9. **默认开启，可由运维关闭。** `NOTION_RELAY_ENABLED=false` 时中继返回
   `404 FEATURE_DISABLED`，写作台隐藏「连接 Notion 直接拉取」选项卡，只保留上传。
   部署时出站防火墙需放行 `api.notion.com:443`。

## 写作台界面

导入页分两个选项卡：「连接 Notion 直接拉取」（默认）和「上传导出文件」（现有）。
拉取选项卡包含三步说明，配合 Notion 当前界面的文字指引：

1. 在 notion.so/profile/integrations 创建一个 Internal integration，复制它的
   Internal Integration Secret；
2. 在数据库页面「••• → 连接（Connections）」中添加这个 integration；
3. 把 secret 和数据库链接粘贴进来（链接或 32 位 ID 均可，前端解析出 ID）。

随后点「列出文章」，勾选后点「拉取所选并试跑」。拉取完成后自动进入试跑，作者看完
合并报告再点「确认导入」。同一页面再次导入时，只需粘贴一次 token（页面刷新会丢失）。

## 后果

- **Notion 托管图片的签名 URL 约 1 小时过期。** 拉取后应尽快试跑并确认；计划本身的
  有效期是 15 分钟，过期后会自动重新试跑（P0-4）。确认时 URL 已过期的图片按现有
  规则移除并报告（`expiring-image-url`），不会写入失效链接。
- **API 新增一个出站主机。** 它固定为 `api.notion.com`，只读，三种调用，并有超时、
  字节上限和限流。威胁模型的变化：攻击者可以用自己的 token 通过我们的 API 读取
  *自己的* Notion 数据，并消耗自己的限流额度；我们的出口不会被用来访问任何其他主机。
- **token 曾在服务器内存中出现过。** 进程内存转储或崩溃核心文件理论上可能包含正在
  处理的 token。这比保存 token 的风险小几个数量级，但不为零；运维规程应禁止在生产
  环境开启包含请求体的调试日志。
- **一次拉取可能耗时数分钟**（受 Notion 3 次/秒的限制）。这段时间都在作者的浏览器里，
  服务器上没有长请求。
- **OAuth（公共 integration）、服务端定时同步、写回 Notion 都不在本 ADR 范围内。**
  OAuth 需要保存 refresh token，恰好是决定 3 原本禁止的保管，需另起 ADR。

## 验证

- API 单元测试：三种 `call` 拼出的 URL、方法和头；拒绝任意路径、方法、非 UUID 的
  id、非法游标；重定向不跟随；超时；字节上限；错误映射；裁剪字段；token 格式校验；
  日志捕获中不出现 token 和 Notion 错误原文；功能关闭时返回 404。
- 限流：新策略与 `import.notion` 互不影响。
- BFF：同源、no-store、`Retry-After` 透传，与 `notion-import` 处理器同一套测试。
- 前端单元测试：从链接中解析数据库 ID；两步拉取的状态机；节奏控制与 429 等待；超过
  2000 块的页面被排除并给出提示；拉取结果与上传导出文件得到的 bundle 走同一条流程。
- e2e（mock 中继，不访问真实 Notion）：列出行 → 勾选 → 拉取 → 试跑 → 确认；token
  无效、未共享、429 自动等待；页面刷新后 token 不再存在。
- `pnpm typecheck`、`pnpm lint`、`pnpm test`、`pnpm test:e2e` 全部通过。
