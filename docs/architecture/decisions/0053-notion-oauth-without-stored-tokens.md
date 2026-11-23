# ADR 0053: 用 Notion OAuth 代替粘贴令牌，授权结果只交给当前页面、服务器仍不保存

- Status: Accepted
- Implementation: Done
- Date: 2026-11-22
- 关联：[ADR 0052](0052-server-side-notion-pull-without-storing-tokens.md)（本文沿用其「token 只随请求经过、从不保存」的约束，只增加 token 的一种来源）；[ADR 0036](0036-notion-as-interchange-format.md) 决定 3

## 背景

ADR 0052 让作者粘贴令牌，由服务器分段拉取数据库。最初的令牌只能是内部集成的
Internal Integration Secret，作者要做三件事：新建内部集成、复制密钥、再到数据库
的「… → 连接」里添加这个集成。最容易出错的是最后一步：Notion 返回的「未共享」
错误（`NOTION_NOT_SHARED`）几乎都因为漏了它。

此后有两点变化：

1. Notion 推出了**个人访问令牌**（personal access token，PAT）。它按创建者本人的
   权限读取，不需要「添加连接」，可以设置 7 天到 1 年的有效期并随时撤销。写作台
   因此改为推荐 PAT，内部集成作为备选；令牌改按不透明值校验（见下文决定 6）。
   但 PAT 仍要作者自己去开发者设置里创建和复制，而且部分工作区只允许所有者创建。
2. Notion 的 **OAuth 集成**（OAuth connection）支持标准的授权码流程。作者点一个按钮，
   在 Notion 的授权页里选中要共享的页面或数据库，然后回到本站，不用创建或复制任何
   令牌，「添加连接」也在授权页里一并完成。

OAuth 一定会经过服务器：用授权码换令牌需要集成的 client secret，它不能出现在浏览器
里。本 ADR 决定令牌怎么处理。

## 备选方案

| 方案 | 做法 | 结论 |
|---|---|---|
| **A. 一次性 OAuth（采用）** | 服务器用授权码换到 access token 后，只交给发起授权的那个写作台页面，放在页面内存里；之后完全按 ADR 0052 使用，服务器不保存 | 省去创建、复制令牌和添加连接，保持 ADR 0052 的不变量 |
| B. 保存令牌 | 每位作者一行加密的 access/refresh token，支持「保持连接」、定时同步 | 需要密钥管理、断开连接与轮换、账户删除时清除，并再次修订 ADR 0036 决定 3；目前没有需求证明值得 |
| C. 只用粘贴令牌 | PAT 或内部集成（ADR 0052）和上传导出文件 | 仍然可用，也是未配置 OAuth 时的默认 |

## 决定（方案 A）

### 1. 流程

1. 写作台加载时请求 `GET /api/authoring/notion-oauth`（BFF → API
   `GET /api/v1/imports/notion/oauth`），只得到 `{ enabled }`。未配置时不显示按钮。
2. 作者点「用 Notion 授权」。页面在任何 `await` 之前用 `window.open("")` 打开一个
   同源的空白弹窗（避免被弹窗拦截），并把它的 `opener` 置空，然后请求
   `POST /api/authoring/notion-oauth/start`（→ API `POST /api/v1/imports/notion/oauth/start`）。
   API 返回 Notion 授权地址（`client_id`、`response_type=code`、`owner=user`、固定的
   `redirect_uri`、`state`），页面把弹窗导航过去。写作台本身不离开，勾选和内存状态都在。
3. Notion 重定向到 `/write/notion/oauth/callback?code=…&state=…`（拒绝时为
   `?error=access_denied&state=…`）。回调页首先用 `history.replaceState` 清掉地址栏里的
   code，然后把 `{code, state}` POST 给 `/api/authoring/notion-oauth/exchange`（→ API）。
   回调页响应带 `Cache-Control: no-store` 与 `Referrer-Policy: no-referrer`，不做登录跳转
   （跳转会丢掉或带走 code），也不渲染令牌。Web 访问日志只记录路径，不含查询串。
4. API 校验 `state`（决定 2），通过后立即作废，再用 HTTP Basic（client id + secret）调用
   `POST https://api.notion.com/v1/oauth/token`，请求体为
   `{grant_type: "authorization_code", code, redirect_uri}`。响应 `{accessToken, workspaceName}`
   带 `no-store`，不写库、不写日志。出站请求沿用 ADR 0052 决定 3 的限制：只访问
   `https://api.notion.com/v1/`、不跟随重定向、响应不超过 64 KiB、15 秒超时。
5. 回调页通过同源 `BroadcastChannel` 把结果交给写作台，频道名由 `state` 派生，只有发起
   这次授权的写作台和这个回调页知道；然后关闭自己。不依赖 `window.opener`。写作台只接受
   该频道上第一条格式正确的消息，随即关闭频道。
6. 写作台拿到 token 后，与粘贴的令牌完全一样地使用：放进令牌输入框背后的内存状态；已填
   数据库链接时自动「连接并读取条目」，然后走 ADR 0052 的拉取与原有的试跑 → 确认。刷新或
   离开页面后即失效。等待可以取消，10 分钟（`state` 的有效期）后自动停止。

### 2. `state`：签名而不是 cookie（相对提案的修改）

提案原本要把 `state` 写进一个 `Path` 限定在回调路径的 `__Host-` cookie。实施时发现两点：
`__Host-` 前缀要求 `Path=/`，与「只限回调路径」矛盾；BFF 的转发也不会把 API 的
`Set-Cookie` 传给浏览器，要为此改动会话转发层。因此改为无状态签名：

- `state = v1.<过期秒>.<32 字节随机数>.<HMAC>`，HMAC-SHA256 覆盖作者 id、过期时间和随机数，
  密钥由 client secret 派生（`HMAC(clientSecret, "no-wave/notion-oauth-state/v1")`），
  不新增配置项。作者 id 不出现在 `state` 里。
- 兑换时按**当前会话**的作者重新计算并常量时间比较：别人发起的、别的账户的、过期的、
  被篡改的 `state` 一律同一个回答 `NOTION_OAUTH_STATE_INVALID`，不调用 Notion。会话本身
  已经把它绑定到这个浏览器。
- 一次性：API 进程内记录已用过的随机数直到它本该过期（上限 20,000 条，满了宁可拒绝也
  不遗忘）。多实例部署时，跨进程的重放由 Notion「授权码只能兑换一次」兜底。轮换 client
  secret 会让进行中的授权失效，这是可以接受的。

### 3. 令牌处理（不变量，与 ADR 0052 相同）

- 服务器不保存 access token、refresh token、授权码或任何 OAuth 数据；`state` 也不落库。
- Notion 的兑换响应里只读取 `access_token` 和 `workspace_name`；refresh token、bot id、
  owner 等一概不读取、不返回。需要「保持连接」时由方案 B 另立 ADR。
- 错误、日志、指标、响应中都不出现 token、授权码、client secret 和 Notion 的错误原文。
  每种失败都是固定的错误码：`NOTION_OAUTH_DISABLED`（409）、`NOTION_OAUTH_STATE_INVALID`
  与 `NOTION_OAUTH_CODE_INVALID`（422）、`NOTION_OAUTH_MISCONFIGURED`（502，Notion 拒绝了
  client 凭据）、`NOTION_UNAVAILABLE`（502）。
- 浏览器端不写 `localStorage`/`sessionStorage`/URL/cookie；回调页不渲染 token。
- 兑换得到的 token 必须通过 ADR 0052 的令牌形态校验，否则视为 `NOTION_UNAVAILABLE`。

### 4. 配置与默认值

- `NOTION_OAUTH_CLIENT_ID`、`NOTION_OAUTH_CLIENT_SECRET`、`NOTION_OAUTH_REDIRECT_URI`，只放在
  API 进程的环境变量里，BFF 和浏览器都拿不到 secret。
- 三者缺一、`NOTION_OAUTH_REDIRECT_URI` 不是 `https`（`localhost`/`127.0.0.1` 可以用 `http`）、
  带用户信息/查询串/片段、或路径不是 `/write/notion/oauth/callback`，以及
  `NOTION_FETCH_ENABLED=false` 时，功能关闭：start 与 exchange 返回 409，写作台不显示按钮，
  粘贴令牌照常可用。
- `redirect_uri` 必须与 Notion 集成设置里登记的完全一致；不接受请求参数里的回调地址。

### 5. 限流

start 与 exchange 各为每位作者 10 次、每个 IP 20 次 / 10 分钟，与 ADR 0052 的拉取限流
（60/120）以及导入限流（10/20）互相独立。`GET` 状态查询只需要会话。

### 6. 令牌形态校验（随本 ADR 一起修改 ADR 0052 的实现）

Notion 说明令牌格式可能变化、应视为不透明值；PAT 与内部集成密钥目前以 `ntn_` 开头，旧的
以 `secret_` 开头，而 OAuth access token 的形态没有文档。因此服务器与浏览器都不再检查
前缀，只检查长度 20–500、字符属于 RFC 6750 的 bearer token 字符集（不含空白、控制字符或
粘贴进来的链接），保证它只能成为一个安全的 `Authorization` 头。

### 7. 撤销

服务器不保存令牌，本站没有「断开连接」可做。要撤销访问，在 Notion 的「设置 → 连接」里
移除本站的集成，之前发出的 token 随之失效。Notion 另有 `POST /v1/oauth/revoke`，但一次导入
要用同一个 token 发出多次拉取请求，本站不在拉取后自动撤销。

### 8. 弹窗没有 opener

跳转 Notion 之前切断弹窗的 `opener`，Notion 的页面因此拿不到写作台的窗口句柄。代价是
浏览器可能把弹窗放进独立的浏览上下文组，写作台对它的句柄随之失效：「取消授权」只能停止
等待并尝试关闭弹窗，界面提示作者可以手动关掉那个窗口。回调页成功后自己 `window.close()`。

## 实施前核实的结果

对照 Notion 当前文档（2026-11）：

1. **授权地址与令牌端点**：授权地址为 `https://api.notion.com/v1/oauth/authorize`，参数
   `client_id`、`redirect_uri`、`response_type=code`、`owner=user`、`state`（可选，建议使用）；
   拒绝时回到 `redirect_uri?error=access_denied&state=…`。令牌端点
   `POST /v1/oauth/token`，HTTP Basic 认证（`client_id:client_secret` 的 base64），错误码按
   RFC 6749 §5.2。授权地址带了 `redirect_uri` 时，兑换请求也必须带上。**与提案一致。**
2. **过期、refresh token、PKCE**：兑换总会返回 `refresh_token`（本站丢弃）；文档没有说明
   access token 的有效期；REST API 的授权指南没有提到 PKCE（只在 MCP 客户端指南中出现），
   因此没有启用。
3. **审核**：只有上架 Notion Marketplace 才需要安全审核，不上架即可使用。**提案中
   「需要以公开集成身份登记并提供隐私政策和服务条款」的说法过于宽泛，已更正。**
4. **页面选择**：授权页可以直接选中数据库；选中父页面时，其子页面与子数据库一并共享。
5. **数据源 API 权限**：OAuth token 调用的是同一套 REST API，权限由授权页里选中的内容
   决定，与内部集成添加连接后的效果相同。本站没有用真实 Notion 验证这一点（见「局限」）。

## 集成类型的选择（运营层面）

Notion 的 OAuth 集成在创建时选择可安装范围，**创建后不能更改**，开发工作区也不能更改：

- **限定工作区**（Installable in「Or select 1 or more workspaces」）：只有列出的工作区能
  授权，不能上架 Marketplace。适合只有站长本人或少数固定工作区使用的站点。**本站当前的
  部署选择这一种。**
- **任意工作区**（「Any workspace」，即公开集成）：任何作者都能授权自己的工作区；不上架
  就不需要审核。站点开放给不特定作者使用时应选这一种，需要新建一个集成。

两者的授权与兑换流程完全相同，本站代码不区分。创建步骤：
`https://app.notion.com/developers/connections` → New connection → Authentication method 选
OAuth → 登记 redirect URI（`https://<站点域名>/write/notion/oauth/callback`）→ 选择可安装范围；
client id 与 secret 在 Configuration 页。secret 只放进部署环境的密钥管理，不要贴进聊天或日志。
限定工作区的集成不能装进未列出的工作区（授权页上的具体提示由 Notion 决定），这些作者可以改用粘贴令牌。

## 后果

- 作者一次点击加一次 Notion 授权页就能列出数据库条目，不必创建或复制令牌，也不会因为
  漏了「添加连接」而失败。
- 风险与 ADR 0052 相同：token 在服务器内存中只停留兑换和每次拉取的时长。新增的风险面是
  client secret：泄露后可以冒充本站集成发起授权，但拿不到任何已有 token（我们不保存）。
  轮换方法是在 Notion 里重新生成 secret 并更新环境变量。
- 每次导入都要重新授权（Notion 可能记住之前的选择，使第二次更快）。这是不保存令牌的
  直接代价，可以接受。

## 局限

- 没有用真实的 Notion OAuth 集成做端到端验证：API 测试用桩代替令牌端点，e2e 用桩代替
  Notion 的授权页（按 Notion 的方式 302 回到回调页）。上线前应在部署环境里完成一次真实授权。
- 防重放的已用 `state` 记录在单个 API 进程内；多实例时依赖 Notion 的授权码一次性。
- 文档没有说明 access token 的有效期；一次导入如果持续很久，token 可能在中途失效，届时
  按 ADR 0052 报 `NOTION_TOKEN_INVALID`，重新授权即可。
- 弹窗被浏览器拦截时，写作台提示允许弹窗或改用粘贴令牌，没有整页跳转的备用流程。

## 不在本 ADR 范围内

保存令牌和「保持连接」（方案 B）、定时同步、写回 Notion、通过 OAuth 列出可选数据库
（作者仍需粘贴数据库链接）、Flutter 端的 OAuth（原生端可自行完成授权，再按 ADR 0036
决定 8 提交 bundle），以及持久化导入任务（[ADR 0041](0041-default-off-notion-import-jobs.md)，
仍为 Proposed）。

## 验证

- API：`apps/api/src/application/notion-oauth.test.ts`（配置校验、`state` 的跨作者/过期/
  篡改/重放、兑换请求的形态、Notion 拒绝的映射且不带原文）与
  `apps/api/src/transport/rest/notion-oauth.integration.test.ts`（真实 HTTP：start → exchange、
  重放不再调用 Notion、功能关闭 409、会话、限流，日志与响应中没有 code、secret、token、
  refresh token 和 Notion 原文）。
- BFF：`packages/web-http/test/authoring-notion-oauth.test.ts`（方法、同源、体积上限、
  `no-store`、拒绝不回显 code）。
- Web：`apps/web-rr/test/web.test.ts`（回调页无登录跳转、不回显 code、`no-referrer`、
  `no-store`）、`apps/web-rr/test/document-security.test.ts`（路由只能把 referrer 策略收紧
  为 `no-referrer`）、`packages/web-ui/src/lib/notion-oauth.test.ts`（回调 URL 解析、频道只
  接受本次 `state` 的第一条消息、取消与超时、固定提示语）。
- e2e：`e2e/notion-oauth.spec.ts`（弹窗授权、回调先清 code 再兑换、按粘贴令牌的路径拉取、
  令牌不进存储/URL/cookie；Notion 拒绝、取消等待、未配置时不显示按钮），全部端点为桩。
